import {domain} from '@lrfe/common';
import {docType} from '../doc-types.js';

/**
 * Cross-document checks against the EDRMS: is this document already filed, and the product's own
 * checks against the documents it cites (`documents.reading.crossChecks` of the domain pack, CB-3).
 * These are the checks that make "compare during review" reliable; they never depend on the model.
 *
 *   edrms.lookupRef(ref) → document ({ id, edrmsNo, docType, props }) | null
 * @param {{edrms: object, pack?: import('@lrfe/domain-pack').DomainPack}} options
 * @return {{check: function(string, Array<object>): Promise<void>}}
 */
export function createChecker({edrms, pack = domain}) {
  async function lookup(ref, cache) {
    if (!cache.has(ref)) cache.set(ref, edrms.lookupRef(ref));
    return cache.get(ref);
  }

  return {
    /** Adds checks to `rows` in place. Rows: { k, type, value, normalized, checks }. */
    async check(typeId, rows) {
      const t = docType(typeId, pack);
      if (!t) return;
      const row = k => rows.find(r => r.k === k && r.value);
      const cache = new Map();
      const unavailable = (r, err) =>
        r.checks.push({
          level: 'warn',
          code: 'crosscheck_unavailable',
          message: `Could not check against the EDRMS: ${err.message}`,
        });

      // 1. Already filed?
      const own = t.refField && row(t.refField);
      if (own?.normalized) {
        try {
          const dup = await lookup(own.normalized, cache);
          if (dup) {
            own.checks.push({
              level: 'error',
              code: 'duplicate',
              message: `${own.value} is already filed as ${dup.edrmsNo}`,
              ref: dup.id,
            });
          }
        } catch (err) {
          unavailable(own, err);
        }
      }

      // 2. The product's checks against the documents this one cites
      await pack.documents.reading?.crossChecks?.check({
        typeId,
        rows,
        row,
        lookup: ref => lookup(ref, cache),
        unavailable,
      });
    },
  };
}

/**
 * The codes of every check createChecker adds, removed before the checks run again.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {Array<string>}
 */
export function crossCheckCodesOf(pack = domain) {
  return [
    'duplicate',
    ...(pack.documents.reading?.crossChecks?.codes ?? []),
    'crosscheck_unavailable',
  ];
}

/** A checker that checks nothing (no EDRMS configured, and tests that don't need it). */
export const noChecks = {async check() {}};
