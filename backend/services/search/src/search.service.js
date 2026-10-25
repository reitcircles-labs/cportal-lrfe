/**
 * The events the search service follows, each with its own durable consumer (API-802): a
 * consumer resumes where it stopped, so documents read, rejected, filed or corrected while the
 * service was down are fetched once it is back. `from` says where the document is fetched.
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

/**
 * Receives intake's and edrms' document events and fetches what the index needs: from intake
 * the AI's reading (fields and page text), from edrms the filed document (corrected fields, EDRMS
 * number, access restriction). Until the index is written (API-808), what was fetched is only
 * counted and logged, never the document's content.
 */
export class SearchService {
  /**
   * @param {{events: object, intake: object, edrms: object, clock?: () => Date}} deps
   */
  constructor({events, intake, edrms, clock = () => new Date()}) {
    this.events = events;
    this.intake = intake;
    this.edrms = edrms;
    this.clock = clock;
    this.logger = console;
    this.counts = new Map(
      CONSUMERS.map(c => [
        c.type,
        {received: 0, fetched: 0, missing: 0, failed: 0, lastHandledAt: null},
      ]),
    );
  }

  /** Starts the durable consumers; what is fetched is logged to `logger` (the app's). */
  start({logger} = {}) {
    if (logger) this.logger = logger;
    for (const consumer of CONSUMERS) {
      const handler = event => this.handle(consumer, event);
      this.events.consume(consumer.type, handler, {durable: consumer.durable});
    }
  }

  /**
   * One event: fetch the document it names. A document that is no longer there is counted and
   * the event acknowledged; when intake or edrms cannot answer, the error is thrown so the event
   * is delivered again.
   */
  async handle(consumer, event) {
    const count = this.counts.get(consumer.type);
    count.received += 1;
    const documentId = event.data?.documentId;
    try {
      const summary =
        consumer.from === 'intake'
          ? summariseReading(await this.intake.getReading(documentId))
          : summariseFiled(await this.edrms.getDocument(documentId));
      if (summary) {
        count.fetched += 1;
        this.logger.info(
          {event: consumer.type, eventId: event.id, documentId, ...summary},
          'search: document fetched',
        );
      } else {
        count.missing += 1;
        this.logger.warn(
          {event: consumer.type, eventId: event.id, documentId},
          `search: the document is not in ${consumer.from}`,
        );
      }
      count.lastHandledAt = this.clock().toISOString();
    } catch (err) {
      count.failed += 1;
      throw err;
    }
  }

  /**
   * Per event: what was received and fetched since the service started, and its lag, the events
   * not handled yet (`pending`, not given to the service yet, plus `unacked`, being handled).
   * `lag` is their total over all consumers, null when the event bus cannot say.
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
    };
  }
}

/** What is logged of intake's reading: its size, not its content. Null when there is none. */
function summariseReading(reading) {
  if (!reading) return null;
  return {
    status: reading.status,
    docType: reading.docType,
    fields: reading.fields?.length ?? 0,
    pages: reading.pages?.length ?? 0,
  };
}

/** What is logged of a filed document: its number and size, not its content. Null when there is none. */
function summariseFiled(document) {
  if (!document) return null;
  return {
    edrmsNo: document.edrmsNo,
    docType: document.docType,
    fields: document.fields?.length ?? 0,
    access: document.recordMetadata?.accessRestriction ?? null,
  };
}
