/**
 * The Details tab's offer to take encumbrances from the documents (API-721): the bonds the linked
 * mortgage bonds suggest that the draft does not have yet. Plain TypeScript without Angular, so it
 * is unit tested on its own (`npm run test:link`).
 */
import type {Encumbrance} from '../../api/records.api';

/** What to offer: the encumbrances to add, and the request that adds them. */
export interface EncumbranceOffer {
  /** The suggested encumbrances the draft does not have, in the documents' order. */
  missing: Encumbrance[];
  /** The button text, e.g. "Use B 1944/2014 from the documents". */
  label: string;
  /** The draft's encumbrances once the missing ones are added. */
  encumbrances: Encumbrance[];
  /**
   * True when that is exactly the documents' list: it is then saved as taken from the documents
   * (`accept`, shown so in the history). Otherwise it is saved as a change, so encumbrances entered
   * by hand (a servitude, say) are kept.
   */
  accept: boolean;
}

/** One encumbrance as a comparable key: type and reference, ignoring case and spacing. */
export function encumbranceKey(e: Encumbrance): string {
  return `${e.type}|${(e.ref || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

/** Whether two encumbrances are the same in every detail the record keeps. */
function sameEntry(a: Encumbrance, b: Encumbrance): boolean {
  return (
    a.type === b.type &&
    (a.ref || '').trim() === (b.ref || '').trim() &&
    (a.inFavourOf ?? '') === (b.inFavourOf ?? '') &&
    (a.note ?? '') === (b.note ?? '')
  );
}

/**
 * The offer for a draft's encumbrances, given the documents' suggestions; null when there is nothing
 * to add. Suggestions without a reference are not offered, and each is offered once.
 */
export function encumbranceOffer(
  suggested: readonly Encumbrance[] | null | undefined,
  current: readonly Encumbrance[] | null | undefined,
): EncumbranceOffer | null {
  const s = suggested ?? [];
  const kept = current ?? [];
  const have = new Set(kept.map(encumbranceKey));
  const missing = s.filter(e => {
    const key = encumbranceKey(e);
    if (!(e.ref || '').trim() || have.has(key)) return false;
    have.add(key);
    return true;
  });
  if (!missing.length) return null;
  const target = [...kept, ...missing];
  return {
    missing,
    label: `Use ${missing.map(e => e.ref.trim()).join(', ')} from the documents`,
    encumbrances: target.map(e => ({...e})),
    accept:
      target.length === s.length && target.every((e, i) => sameEntry(e, s[i])),
  };
}
