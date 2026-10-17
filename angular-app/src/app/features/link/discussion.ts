/**
 * The Discussion of a land record (API-729): the comments on the record and the review decisions in
 * each version's change log (submitted, withdrawn, returned, approved), in one timeline per version.
 */

/** One entry of a version's change log, as land-records keeps it. */
export interface DiscussionChange {
  at: string;
  byName: string | null;
  action: string;
  comment?: string;
}

/** A version with its change log (GET /records/:id/versions). */
export interface DiscussionVersion {
  versionNumber: number;
  changes: DiscussionChange[];
}

/** A comment on the record (GET /records/:id/comments). */
export interface DiscussionComment {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  versionNumber: number | null;
}

export type EventKind = 'comment' | 'submitted' | 'withdrawn' | 'returned' | 'approved';

/** One entry of the timeline. */
export interface DiscussionEvent {
  /** Unique within the record, for tracking in templates. */
  key: string;
  kind: EventKind;
  at: string;
  byName: string;
  /** What happened, e.g. "submitted version 1 again"; empty for a comment. */
  what: string;
  /** The comment, or the reason given with a decision. */
  text: string | null;
  /** Null for a comment written before the record had a version. */
  versionNumber: number | null;
}

/** The timeline of one version, oldest first. */
export interface DiscussionGroup {
  versionNumber: number | null;
  events: DiscussionEvent[];
}

const DECISIONS: Readonly<Record<string, EventKind>> = {
  submit: 'submitted',
  withdraw: 'withdrawn',
  reject: 'returned',
  commit: 'approved',
};

/** Whether an event is a decision on a version (anything but a comment). */
export function isDecision(e: DiscussionEvent): boolean {
  return e.kind !== 'comment';
}

function whatHappened(kind: EventKind, version: number, submissions: number): string {
  switch (kind) {
    case 'submitted':
      return submissions > 1 ? `submitted version ${version} again` : `submitted version ${version} for review`;
    case 'withdrawn':
      return `withdrew version ${version} from review`;
    case 'returned':
      return 'returned it to the records officer';
    case 'approved':
      return `approved version ${version}`;
    default:
      return '';
  }
}

/** The decisions and comments of a record, as one list, oldest first. */
export function discussionEvents(versions: readonly DiscussionVersion[], comments: readonly DiscussionComment[]): DiscussionEvent[] {
  const events: DiscussionEvent[] = [];
  for (const v of versions) {
    let submissions = 0;
    (v.changes || []).forEach((c, i) => {
      const kind = DECISIONS[c.action];
      if (!kind) return;
      if (kind === 'submitted') submissions++;
      events.push({
        key: `v${v.versionNumber}-${i}`,
        kind,
        at: c.at,
        byName: c.byName || 'Someone',
        what: whatHappened(kind, v.versionNumber, submissions),
        text: c.comment?.trim() || null,
        versionNumber: v.versionNumber,
      });
    });
  }
  for (const c of comments) {
    events.push({
      key: `c${c.id}`,
      kind: 'comment',
      at: c.createdAt,
      byName: c.authorName || 'Someone',
      what: '',
      text: c.body,
      versionNumber: c.versionNumber,
    });
  }
  // stable: a decision and a comment at the same instant keep the order above
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/** The events grouped by version, the newest version first; each group oldest first. */
export function groupByVersion(events: readonly DiscussionEvent[]): DiscussionGroup[] {
  const groups = new Map<number | null, DiscussionEvent[]>();
  for (const e of events) {
    const list = groups.get(e.versionNumber) ?? [];
    list.push(e);
    groups.set(e.versionNumber, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (b ?? 0) - (a ?? 0))
    .map(([versionNumber, list]) => ({ versionNumber, events: list }));
}
