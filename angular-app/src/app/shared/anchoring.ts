/** A sealed version's anchoring status, from the audit service (API-658); null when it cannot say. */
export interface Anchoring { status: 'waiting' | 'anchored' | 'confirmed'; batch?: number; tx?: string; network?: string; confirmedAt?: string | null; }

// the same words as the Audit screens (API-661)
const LABELS = { waiting: 'Waiting for next batch', anchored: 'On the blockchain', confirmed: 'Confirmed' };
const TAGS = { waiting: 'tag tag-neutral', anchored: 'tag tag-info', confirmed: 'tag tag-accent' };

export const anchoringLabel = (a: Anchoring) => LABELS[a.status];
export const anchoringTag = (a: Anchoring) => TAGS[a.status];
export const anchoringTitle = (a: Anchoring) => a.tx ? `batch ${a.batch} · blockchain transaction ${a.tx}` : 'sealed; it goes to the blockchain with the next batch';
