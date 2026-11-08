/** A sealed version's anchoring status, from the audit service (API-658); null when it cannot say. */
export interface Anchoring {
  status: 'waiting' | 'anchored' | 'confirmed';
  batch?: number;
  tx?: string;
  network?: string;
  confirmedAt?: string | null;
}

// the same words as the Audit screens (API-661)
const LABELS = {
  waiting: 'Waiting for next batch',
  anchored: 'On the blockchain',
  confirmed: 'Confirmed',
};
const TAGS = {
  waiting: 'tag tag-neutral',
  anchored: 'tag tag-info',
  confirmed: 'tag tag-accent',
};

/** How a version's anchoring status is described. */
export const anchoringLabel = (a: Anchoring) => LABELS[a.status];
/** The tag style for a version's anchoring status. */
export const anchoringTag = (a: Anchoring) => TAGS[a.status];
