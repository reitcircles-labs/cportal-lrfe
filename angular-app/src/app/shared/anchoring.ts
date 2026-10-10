/** A sealed version's anchoring status, from the audit service (API-658); null when it cannot say. */
export interface Anchoring { status: 'waiting' | 'anchored' | 'confirmed'; batch?: number; tx?: string; network?: string; confirmedAt?: string | null; }

const LABELS = { waiting: 'Waiting for the next anchoring', anchored: 'Anchored, confirming', confirmed: 'Anchoring confirmed' };
const TAGS = { waiting: 'tag tag-neutral', anchored: 'tag tag-info', confirmed: 'tag tag-accent' };

export const anchoringLabel = (a: Anchoring) => LABELS[a.status];
export const anchoringTag = (a: Anchoring) => TAGS[a.status];
export const anchoringTitle = (a: Anchoring) => a.tx ? `batch ${a.batch} · transaction ${a.tx}` : 'in the audit tree; it goes into the next anchoring';
