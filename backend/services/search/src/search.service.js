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

/** A page of a changed-since list in the re-index, written in one bulk request. */
const PAGE = 200;

/** Documents of a page fetched from intake and edrms at once. */
const FETCHES = 16;

/**
 * Where the re-index reads documents: intake first (documents not filed yet, and filed ones with
 * their EDRMS side), then edrms (filed documents, also those intake no longer has, and
 * corrections, which change only edrms' document).
 */
const SOURCES = [
  {from: 'intake', id: d => d.documentId},
  {from: 'edrms', id: d => d.id},
];

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
   * Fetches a document from `from` (and its other side) and says what its entry should be:
   * `{ action: write | remove | skip | missing, entry, summary }`. `gone`: intake no longer has
   * the document, so its entry (if any) is removed.
   */
  async prepare(from, documentId) {
    let reading;
    let filed;
    if (from === 'intake') {
      reading = await this.intake.getReading(documentId);
      if (!reading) return {action: 'missing', gone: documentId};
      filed = reading.filedDocumentId
        ? await this.edrms.getDocument(reading.filedDocumentId)
        : null;
    } else {
      filed = await this.edrms.getDocument(documentId);
      if (!filed) return {action: 'missing'};
      reading = filed.sourceId
        ? await this.intake.getReading(filed.sourceId)
        : null;
    }
    const summary = summarise(reading, filed);
    const entry = buildEntry({reading, filed});
    // an upload the AI has not read (yet, or it failed): nothing to search; its reading's event
    // indexes it (the re-index meets these)
    if (!filed && !READ.has(reading.status)) {
      return {action: 'skip', entry, summary};
    }
    // a rejected upload leaves the results. The removal's mark lasts only a minute in the
    // index, but a later event fetches the rejection again and removes it again
    if (reading?.status === 'rejected' && !filed) {
      return {action: 'remove', entry, summary};
    }
    return {action: 'write', entry, summary};
  }

  /**
   * Fetches a document from `from` (and its other side) and writes, replaces or removes its
   * entry: `{ result: indexed | removed | stale | skipped | logged | missing, summary }`.
   */
  async indexDocument(from, documentId) {
    const prepared = await this.prepare(from, documentId);
    if (prepared.action === 'missing') {
      if (prepared.gone) await this.remove(prepared.gone, null);
      return {result: 'missing'};
    }
    const {entry, summary} = prepared;
    const done = result => ({result, summary, entryId: entry.id});
    if (prepared.action === 'skip') return done('skipped');
    if (!this.engine) return done('logged');
    if (prepared.action === 'remove') {
      return done(await this.remove(entry.id, entry.version));
    }
    return done(await this.write(entry));
  }

  /**
   * Indexes a page of documents from `from` into `index` (the alias, or a rebuild's new index):
   * fetched a few at a time, written in one bulk request. Returns the count per result and the
   * ids (listed, and of the entry) of the documents found, for the dead-letter list.
   */
  async indexPage(from, ids, {index = INDEX_ALIAS} = {}) {
    const results = emptyResults();
    const prepared = await mapLimit(ids, FETCHES, id => this.prepare(from, id));
    const found = prepared.flatMap((p, n) =>
      p.action === 'missing' ? [] : [ids[n], p.entry.id],
    );
    // the bulk request's lines, and per line the result it counts for
    const lines = [];
    const counted = [];
    for (const p of prepared) {
      if (p.action === 'missing') {
        results.missing += 1;
        if (p.gone && this.engine) {
          lines.push({delete: {_index: index, _id: p.gone}});
          counted.push(null);
        }
      } else if (p.action === 'skip') {
        results.skipped += 1;
      } else if (!this.engine) {
        results.logged += 1;
      } else {
        const meta = {
          _index: index,
          _id: p.entry.id,
          version: p.entry.version,
          version_type: 'external_gte',
        };
        if (p.action === 'remove') {
          lines.push({delete: meta});
          counted.push('removed');
        } else {
          lines.push({index: meta}, p.entry.body);
          counted.push('indexed');
        }
      }
    }
    if (lines.length === 0) return {results, found};
    const body = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    const res = await this.bulk(body);
    res.body.items.forEach((item, n) => {
      const {status, error} = item.index ?? item.delete;
      const result = counted[n];
      if (status === 409) {
        if (result) results.stale += 1;
      } else if (status >= 300 && status !== 404) {
        throw new AppError(
          status === 503 ? 503 : 502,
          `The search engine could not write the entry: ${status} ${error?.type ?? ''}`.trim(),
        );
      } else if (result) {
        results[result] += 1;
      }
    });
    return {results, found};
  }

  /**
   * One bulk request; when the engine is too busy (429, for the request or any of its lines) or
   * does not answer in time, it is sent again after 2 s, 4 s, … up to 5 times. Sending it again is
   * safe: each line carries its version.
   */
  async bulk(body) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await this.engine('POST', '/_bulk', body);
      } catch (err) {
        if (attempt > 5) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      const busy =
        res.status === 429 ||
        (res.status < 300 &&
          res.body.items.some(i => (i.index ?? i.delete).status === 429));
      if (!busy || attempt > 5) {
        if (res.status >= 300) throw engineError('write', res);
        return res;
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
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
   *
   * For a rebuild (API-804): `index` is the new index; `start` the position to resume from
   * (`{ source, after }`, as given to `onPage`); `onPage({ position, done, results })` is called
   * after each page with the position to resume from (null at the end); when `stop()` says so it
   * returns before the next page, with `stopped: true`.
   */
  async reindex({
    since = null,
    index = INDEX_ALIAS,
    start = null,
    onPage = null,
    stop = () => false,
    pageSize = PAGE,
  } = {}) {
    const results = emptyResults();
    // the documents in the dead-letter list leave it when they are indexed
    const deadLettered = new Set(
      ((await this.deadLetters({size: 10_000}))?.items ?? []).map(
        d => d.documentId,
      ),
    );
    const first = start ? SOURCES.findIndex(x => x.from === start.source) : 0;
    for (let n = first; n < SOURCES.length; n++) {
      const source = SOURCES[n];
      const list = source.from === 'intake' ? this.intake : this.edrms;
      let after = n === first ? (start?.after ?? null) : null;
      do {
        if (stop()) return {...results, stopped: true};
        const page = await list.listChanged({
          since,
          after,
          limit: pageSize,
        });
        const ids = page.items.map(source.id);
        const {results: counts, found} = await this.indexPage(
          source.from,
          ids,
          {index},
        );
        for (const [k, v] of Object.entries(counts)) results[k] += v;
        for (const id of found) {
          if (deadLettered.delete(id)) await this.clearDeadLetter(id);
        }
        after = page.next;
        if (onPage) {
          const next = SOURCES[n + 1];
          await onPage({
            position: after
              ? {source: source.from, after}
              : next
                ? {source: next.from, after: null}
                : null,
            done: ids.length,
            results: counts,
          });
        }
      } while (after);
    }
    return results;
  }

  /** How many documents intake and edrms have changed since `since` (all when null). */
  async countChanged({since = null} = {}) {
    let total = 0;
    for (const source of SOURCES) {
      const list = source.from === 'intake' ? this.intake : this.edrms;
      total += (await list.listChanged({since, limit: 1})).total;
    }
    return total;
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
  async deadLetters({size = 20} = {}) {
    if (!this.engine) return null;
    try {
      const res = await this.engine('POST', `/${DEAD_LETTER_INDEX}/_search`, {
        size,
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

/** A count per result of the re-index. */
function emptyResults() {
  return {
    indexed: 0,
    removed: 0,
    stale: 0,
    skipped: 0,
    logged: 0,
    missing: 0,
  };
}

/** `fn` over `items`, at most `limit` at once, the results in order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next++;
      out[n] = await fn(items[n]);
    }
  };
  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, worker),
  );
  return out;
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
