import {BadRequestError} from '@lrfe/common';
import {checkEntries, nextEntry} from './chain.js';
import {FOLLOWS, parseSubject, subjectsOf} from './subjects.js';

const VERIFY_PAGE = 1000;
const MAX_ROUNDS = 5; // record → documents → their capture and processes: 2-3 in practice

/**
 * The audit trail (README.md section 1): one hash-chained entry per durable domain event, written
 * by the consumer only; read by subject, type and time; verified by recomputing the chain.
 */
export class TrailService {
  constructor({repo, clock = () => new Date(), logger = console}) {
    this.repo = repo;
    this.clock = clock;
    this.logger = logger;
  }

  /**
   * The consumer's handler: the event becomes the next entry. A redelivered event (same id) writes
   * nothing. Returns the entry, or null for a repeat. A message that is not a domain event can
   * never be recorded: it is logged and skipped, not delivered again forever.
   */
  async record(event) {
    if (!event?.id || !event.type) {
      this.logger.error?.(
        {event},
        'audit trail: not a domain event (no id or type), skipped',
      );
      return null;
    }
    return this.repo.append(String(event.id), last => ({
      ...nextEntry(last, {
        eventId: String(event.id),
        type: event.type,
        source: event.source ?? 'unknown',
        time: event.time ?? this.clock().toISOString(),
        actor: event.actor ?? {id: null, name: 'System'},
        subjects: subjectsOf(event),
        data: event.data ?? {},
      }),
      recordedAt: this.clock(),
    }));
  }

  /**
   * Events the stream dropped before the consumer read them (README.md section 1, "Gaps"): the
   * range is recorded once as a trail entry of its own (`audit.trail.gap`, written by the audit
   * service, its id derived from the range) and reported loudly, so the loss is visible and the
   * trail is never passed off as complete. Run at start and every hour.
   */
  async checkGap(events, consumer = 'audit-trail') {
    const gap = await events.consumerGap(consumer);
    if (!gap) return null;
    const data = {
      consumer,
      fromStreamSeq: gap.from,
      toStreamSeq: gap.to,
      missing: gap.to - gap.from + 1,
    };
    const entry = await this.record({
      id: `gap:${consumer}:${gap.from}-${gap.to}`,
      type: 'audit.trail.gap',
      source: 'audit',
      time: this.clock().toISOString(),
      actor: {id: null, name: 'System'},
      data,
    });
    if (entry) {
      this.logger.error?.(
        data,
        'audit trail: events were lost before the audit service could record them; the gap is recorded in the trail',
      );
      try {
        await events.publish('audit.trail.gap', data, {durable: false});
      } catch {
        /* the bus logs its own failures */
      }
    }
    return {...data, recorded: !!entry};
  }

  /**
   * Trail entries, oldest first. `subject` (`record:<id>`, `document:<id>`, `user:<id>` …): for a
   * land record or a document also the steps of what it is made of — its documents' capture,
   * filing, amendments and review processes — but not those of other records.
   */
  async list({subject, type, from, to, limit = 100, offset = 0} = {}) {
    const filter = {
      type: type || undefined,
      from: iso(from, 'from'),
      to: iso(to, 'to'),
    };
    let subjects = null;
    if (subject) {
      const parsed = parseSubject(subject);
      if (!parsed) {
        throw new BadRequestError(
          `Unknown subject "${subject}": use record:, document:, edrmsNo:, intake:, process: or user: and an id`,
        );
      }
      if (parsed[0] === 'record') filter.exceptRecord = subject;
      subjects = await this.related(subject, filter.exceptRecord);
    }
    const {total, entries} = await this.repo.list(
      {...filter, subjects},
      {limit, offset},
    );
    return {total, subjects, entries: entries.map(publicEntry)};
  }

  /** `subject` and every subject that follows from it (FOLLOWS), up to MAX_ROUNDS links away. */
  async related(subject, exceptRecord) {
    const [kind] = parseSubject(subject);
    const found = new Set([subject]);
    if (kind === 'user') return [...found];
    let frontier = [subject];
    for (let round = 0; round < MAX_ROUNDS && frontier.length; round++) {
      const linked = await this.repo.linkedSubjects(frontier, {exceptRecord});
      frontier = linked.filter(
        s => !found.has(s) && FOLLOWS.has(parseSubject(s)?.[0]),
      );
      frontier.forEach(s => found.add(s));
    }
    return [...found];
  }

  /**
   * The people who acted in the trail, for searching by user on the Audit screen (API-673): whose
   * name contains `q`, by name, at most `limit`. Taken from the trail itself, so an auditor can
   * find anyone who did something without the administrators' user list.
   */
  async actors({q = '', limit = 20} = {}) {
    return {items: await this.repo.actors(q.trim(), limit)};
  }

  /**
   * Recompute the whole chain. `intact` false names the first entry that is missing, changed or
   * out of place: everything after it can no longer be trusted from the chain alone.
   */
  async verify() {
    let last = null;
    for (;;) {
      const page = await this.repo.page(last ? last.seq : 0, VERIFY_PAGE);
      if (!page.length) break;
      const broken = checkEntries(last, page);
      if (broken) {
        this.logger.error?.({...broken}, 'audit trail: the chain is broken');
        return {
          intact: false,
          entries: broken.seq - 1,
          brokenAt: broken.seq,
          problem: broken.problem,
        };
      }
      last = page.at(-1);
    }
    return {
      intact: true,
      entries: last ? last.seq : 0,
      head: last && head(last),
    };
  }
}

const head = e => ({seq: e.seq, hash: e.hash, time: e.time});

function iso(value, name) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestError(`"${name}" is not a date`);
  }
  return d.toISOString();
}

function publicEntry(e) {
  const {
    seq,
    eventId,
    type,
    source,
    time,
    actor,
    subjects,
    data,
    prevHash,
    contentHash,
    hash,
  } = e;
  return {
    seq,
    eventId,
    type,
    source,
    time,
    actor,
    subjects,
    data,
    prevHash,
    contentHash,
    hash,
  };
}
