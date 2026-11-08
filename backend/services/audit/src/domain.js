import {domain} from '@lrfe/common';

/**
 * What the audit service takes from the install's domain pack (CB-3): the product's record kind
 * and the audit wording. The names already held by the trail and the tree stay fixed here, whatever
 * the pack: the subject kind `record`, the proof kind and leaf key prefix `record-version`, leaf
 * type 1 (docs/architecture/products.md, "What may never change").
 */

/** The audit texts a pack leaves out: plain words for a product's record. */
const DEFAULT_WORDING = Object.freeze({
  record: 'record',
  portal: 'portal',
  lookupHint: 'Give a record number or a document number',
  evidenceUnsealed:
    'Not covered by any seal, shown as exported: this README, who exported the pack and when, the\n' +
    "record's summary (record/record.json) beyond its id and current version, document titles, and the",
});

/**
 * The product's record kind, every field filled in (empty when the pack leaves it out), or null
 * when the product has no record: then the audit service records no record subjects or leaves, and
 * offers no record proofs, lookups, sign-offs or evidence packs.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {?{source: ?string, committedEvent: ?string, businessKeyProcesses: !Array<string>,
 *     linkedSubjects: !Array<{kind: string, path: !Array<string>}>, commitPermission: ?string,
 *     lookup: {recordNumber: ?RegExp, instrumentNumber: ?RegExp}}}
 */
export function recordKindOf(pack = domain) {
  const kind = pack.recordKind;
  if (!kind) {
    return null;
  }
  return {
    source: kind.source ?? null,
    committedEvent: kind.committedEvent ?? null,
    businessKeyProcesses: kind.businessKeyProcesses ?? [],
    linkedSubjects: kind.linkedSubjects ?? [],
    commitPermission: kind.commitPermission ?? null,
    lookup: {
      recordNumber: kind.lookup?.recordNumber ?? null,
      instrumentNumber: kind.lookup?.instrumentNumber ?? null,
    },
  };
}

/**
 * The audit texts of the pack, with the defaults for what it leaves out.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {{record: string, portal: string, lookupHint: string, evidenceUnsealed: string}}
 */
export function auditWording(pack = domain) {
  return {...DEFAULT_WORDING, ...pack.wording.audit};
}
