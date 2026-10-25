import {AppError} from '@lrfe/common';
import {
  DEAD_LETTER_INDEX,
  INDEX_ALIAS,
  ensureDeadLetterIndex,
  ensureIndex,
} from '@lrfe/search-index';
import {buildEntry} from './entry.js';

/**
 * The events the search service follows, each with its own durable consumer (API-802): a
 * consumer resumes where it stopped, so documents read, rejected, filed or corrected while the
 * service was down are indexed once it is back. `from` says where the document is fetched.
 */
export const CONSUMERS = [
  // the AI has read an upload (also a new reading of the same document)
  {
    type: 'intake.document.extracted',
    durable: 'search-intake-extracted',
    from: 'intake',
  },
  // a reviewer rejected an upload: it leaves the results
  {
    type: 'intake.document.rejected',
    durable: 'search-intake-rejected',
    from: 'intake',
  },
  // filed in the EDRMS, with the officer's corrections and its EDRMS number
  {
    type: 'edrms.document.filed',
    durable: 'search-edrms-filed',
    from: 'edrms',
  },
  // a correction of a filed document was approved
  {
    type: 'edrms.document.amended',
    durable: 'search-edrms-amended',
    from: 'edrms',
  },
];

/** A failed event is delivered again after 5 s, 10 s, 20 s, … at most 5 minutes apart. */
export const retryDelayMs = (attempt, baseMs = 5000) =>
  Math.min(baseMs * 2 ** (attempt - 1), 5 * 60_000);

/** After this many failures a document goes to the dead-letter list. */
export const MAX_ATTEMPTS = 8;

/** A page of a changed-since list in the re-index. */
const PAGE = 200;

/** Intake's statuses of a document the AI has read (and of a rejected one, which is removed). */
const READ = new Set(['ready', 'filed', 'rejected']);

/**
 * Receives intake's and edrms' document events and writes each document's entry into the search
 * index (API-808): from intake the AI's reading (fields and page text), from edrms the filed
 * document (corrected fields, EDRMS number, access restriction). Each event fetches both sides as
 * they are now, so the same event twice gives one entry. Without a search engine (`engine` null:
 * development, an install without one) what was fetched is only counted and logged, as API-802.
 * Never a document's content in the log.
 */
export class SearchService {
  /**
   * @param {{events: object, intake: object, edrms: object, engine?: Function|null,
   *   pack?: object, clock?: () => Date}} deps
   */
  constructor({
    events,
    intake,
    edrms,
    engine = null,
    pack = null,
    clock = () => new Date(),
  }) {
    this.events = events;
    this.intake = intake;
    this.edrms = edrms;
    this.engine = engine;
    this.pack = pack;
    this.clock = clock;
    this.logger = console;
    this.counts = new Map(
      CONSUMERS.map(c => [
        c.type,
        {
          received: 0,
          fetched: 0,
          indexed: 0,
          removed: 0,
          stale: 0,
          skipped: 0,
          missing: 0,
          failed: 0,
          deadLettered: 0,
          lastHandledAt: null,
        },
      ]),
    );
  }

  /** Creates the index and the dead-letter index unless they exist (before the consumers start). */
  async prepareIndex() {
    if (!this.engine) return null;
    const name = await ensureIndex(this.engine, this.pack);
    await ensureDeadLetterIndex(this.engine);
    return name;
  }

  /** Starts the durable consumers; what is handled is logged to `logger` (the app's). */
  start({logger} = {}) {
    if (logger) this.logger = logger;
    for (const consumer of CONSUMERS) {
      this.events.consume(
        consumer.type,
        event => this.handle(consumer, event),
        {
          durable: consumer.durable,
          retryDelayMs: attempt => retryDelayMs(attempt),
          maxAttempts: MAX_ATTEMPTS,
          onGiveUp: (event, err) => this.deadLetter(consumer, event, err),
        },
      );
    }
  }

  /**
   * One event: fetch the document it names, from both sides, and write its entry. A document that
   * is no longer there is counted and the event acknowledged; when intake, edrms or the search
   * engine cannot answer, the error is thrown so the event is delivered again.
   */
  async handle(consumer, event) {
    const count = this.counts.get(consumer.type);
    count.received += 1;
    const documentId = event.data?.documentId;
    try {
      const outcome = await this.indexDocument(consumer.from, documentId);
      if (outcome.result === 'missing') {
        count.missing += 1;
        this.logger.warn(
          {event: consumer.type, eventId: event.id, documentId},
          `search: the document is not in ${consumer.from}`,
        );
      } else {
        count.fetched += 1;
        if (count[outcome.result] !== undefined) count[outcome.result] += 1;
        this.logger.info(
          {
            event: consumer.type,
            eventId: event.id,
            documentId,
            result: outcome.result,
            ...outcome.summary,
          },
          'search: document fetched',
        );
        // the document leaves the dead-letter list, under either of its ids
        await this.clearDeadLetter(documentId);
        if (outcome.entryId && outcome.entryId !== documentId) {
          await this.clearDeadLetter(outcome.entryId);
        }
      }
      count.lastHandledAt = this.clock().toISOString();
    } catch (err) {
      count.failed += 1;
      throw err;
    }
  }

  /**
   * Fetches a document from `from` (and its other side) and writes, replaces or removes its
   * entry: `{ result: indexed | removed | stale | logged | missing, summary }`.
   */
  async indexDocument(from, documentId) {
    let reading;
    let filed;
    if (from === 'intake') {
      reading = await this.intake.getReading(documentId);
      if (!reading) {
        await this.remove(documentId, null);
        return {result: 'missing'};
      }
      filed = reading.filedDocumentId
        ? await this.edrms.getDocument(reading.filedDocumentId)
        : null;
    } else {
      filed = await this.edrms.getDocument(documentId);
      if (!filed) return {result: 'missing'};
      reading = filed.sourceId
        ? await this.intake.getReading(filed.sourceId)
        : null;
    }
    const summary = summarise(reading, filed);
    const entry = buildEntry({reading, filed});
    const done = result => ({result, summary, entryId: entry.id});
    // an upload the AI has not read (yet, or it failed): nothing to search; its reading's event
    // indexes it (the re-index meets these)
    if (!filed && !READ.has(reading.status)) return done('skipped');
    if (!this.engine) return done('logged');
    // a rejected upload leaves the results. The removal's mark lasts only a minute in the
    // index, but a later event fetches the rejection again and removes it again
    if (reading.status === 'rejected' && !filed) {
      return done(await this.remove(entry.id, entry.version));
    }
    return done(await this.write(entry));
  }

  /** Writes the entry unless the index has a newer one: indexed, or stale. */
  async write(entry) {
    const res = await this.engine(
      'PUT',
      `/${INDEX_ALIAS}/_doc/${encodeURIComponent(entry.id)}?version=${entry.version}&version_type=external_gte`,
      entry.body,
    );
    if (res.status === 409) return 'stale';
    if (res.status >= 300) throw engineError('write', res);
    return 'indexed';
  }

  /** Removes an entry (if there is one): removed, or stale when the index has a newer one. */
  async remove(id, version) {
    if (!this.engine) return 'logged';
    const versioned = version
      ? `?version=${version}&version_type=external_gte`
      : '';
    const res = await this.engine(
      'DELETE',
      `/${INDEX_ALIAS}/_doc/${encodeURIComponent(id)}${versioned}`,
    );
    if (res.status === 409) return 'stale';
    if (res.status >= 300 && res.status !== 404) {
      throw engineError('remove', res);
    }
    return 'removed';
  }

  /** A document that kept failing: into the dead-letter list (only what failed, no content). */
  async deadLetter(consumer, event, err) {
    const count = this.counts.get(consumer.type);
    const documentId = event.data?.documentId;
    this.logger.error(
      {event: consumer.type, eventId: event.id, documentId, err: err.message},
      'search: the document keeps failing; it is in the dead-letter list',
    );
    if (!this.engine || !documentId) {
      count.deadLettered += 1;
      return;
    }
    const res = await this.engine(
      'PUT',
      `/${DEAD_LETTER_INDEX}/_doc/${encodeURIComponent(documentId)}`,
      {
        documentId,
        event: consumer.type,
        attempts: event.attempt,
        error: String(err.message ?? err).slice(0, 500),
        at: this.clock().toISOString(),
      },
    );
    if (res.status >= 300) throw engineError('dead-letter', res);
    // counted once recorded: a failed record comes back, and is counted then
    count.deadLettered += 1;
  }

  /** A document indexed again leaves the dead-letter list. */
  async clearDeadLetter(documentId) {
    if (!this.engine || !documentId) return;
    await this.engine(
      'DELETE',
      `/${DEAD_LETTER_INDEX}/_doc/${encodeURIComponent(documentId)}`,
    );
  }

  /**
   * "Re-index since": every document intake or edrms changed at or after `since` (all when null),
   * indexed again as an event would (used after a restore, API-806, and for documents from before
   * the search service). Returns the counts per result.
   */
  async reindex({since = null} = {}) {
    const results = {
      indexed: 0,
      removed: 0,
      stale: 0,
      skipped: 0,
      logged: 0,
      missing: 0,
    };
    const sources = [
      {from: 'intake', list: this.intake, id: d => d.documentId},
      // corrections change only edrms' document
      {from: 'edrms', list: this.edrms, id: d => d.id},
    ];
    for (const source of sources) {
      // pages by position: a document changed during the run can move past a page boundary, but
      // that change is an event, which indexes it anyway
      for (let offset = 0; ; offset += PAGE) {
        const page = await source.list.listChanged({
          since,
          limit: PAGE,
          offset,
        });
        for (const d of page.items) {
          const {result, entryId} = await this.indexDocument(
            source.from,
            source.id(d),
          );
          results[result] += 1;
          if (result !== 'missing') {
            await this.clearDeadLetter(source.id(d));
            if (entryId) await this.clearDeadLetter(entryId);
          }
        }
        if (page.items.length < PAGE) break;
      }
    }
    return results;
  }

  /**
   * Per event: what was handled since the service started, and its lag, the events not handled
   * yet (`pending`, not given to the service yet, plus `unacked`, being handled). `lag` is their
   * total over all consumers, null when the event bus cannot say. `deadLetters`: the documents
   * that kept failing (null without a search engine).
   */
  async status() {
    const consumers = await Promise.all(
      CONSUMERS.map(async c => {
        const lag = await this.events.consumerLag(c.durable);
        return {
          event: c.type,
          durable: c.durable,
          ...this.counts.get(c.type),
          pending: lag?.pending ?? null,
          unacked: lag?.unacked ?? null,
        };
      }),
    );
    const known = consumers.every(c => c.pending !== null);
    return {
      lag: known
        ? consumers.reduce((sum, c) => sum + c.pending + c.unacked, 0)
        : null,
      consumers,
      deadLetters: await this.deadLetters(),
    };
  }

  /** The dead-letter list, newest first: `{ total, items }`; null without an engine or when it cannot say. */
  async deadLetters() {
    if (!this.engine) return null;
    try {
      const res = await this.engine('POST', `/${DEAD_LETTER_INDEX}/_search`, {
        size: 20,
        sort: [{at: 'desc'}],
        track_total_hits: true,
      });
      if (res.status !== 200) return null;
      return {
        total: res.body.hits.total.value,
        items: res.body.hits.hits.map(h => h._source),
      };
    } catch {
      return null;
    }
  }
}

function engineError(what, res) {
  return new AppError(
    res.status === 503 ? 503 : 502,
    `The search engine could not ${what} the entry: ${res.status} ${res.body?.error?.type ?? ''}`.trim(),
  );
}

/** What is logged of a document: its status, number and size, not its content. */
function summarise(reading, filed) {
  return {
    status: filed ? 'filed' : (reading?.status ?? null),
    ...(filed ? {edrmsNo: filed.edrmsNo} : {}),
    docType: filed?.docType ?? reading?.docType ?? null,
    fields: (filed?.fields ?? reading?.fields)?.length ?? 0,
    pages: reading?.pages?.length ?? 0,
    ...(filed ? {access: filed.recordMetadata?.accessRestriction ?? null} : {}),
  };
}
