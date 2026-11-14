/**
 * The shipping product's `recordKind` section (CB-28): a bill of lading is the record. Its versions
 * are committed by the `shipping-records` service, with the same event and the same names in the
 * audit trail and the tree as land records (the subject `record:<id>`, the leaf of type 1 keyed
 * `record-version:<id>:<n>`, the proof kind `record-version`).
 *
 * Left out on purpose: `commitPermission` (a B/L version is committed by the workflow service, by
 * a second person; no permission says who commits, so the audit sign-off has no rule on it) and
 * `lookup` (a B/L number is the carrier's transport document reference, which has no pattern of
 * its own: a search for one goes to the record service as words, which matches it on its number).
 * @type {import('@lrfe/domain-pack').DomainPack['recordKind']}
 */
export const recordKind = {
  /** The service whose events commit record versions, as the trail and the checks name it. */
  source: 'shipping-records',

  /**
   * The service that answers the record contract (CB-4, `@lrfe/record-contract`): the name other
   * services know its token by, what error texts call it, and the setting holding its address.
   */
  service: {
    name: 'shipping-records',
    label: 'shipping records',
    urlSetting: 'SHIPPING_RECORDS_URL',
    defaultUrl: 'http://localhost:3509',
  },

  /**
   * The event that commits a record version (`data.recordId`, `data.versionNumber`, `data.seal`):
   * it becomes a tree leaf of type 1, and resolves the findings on older versions of the record.
   */
  committedEvent: 'records.record.committed',

  /** No workflow process is keyed by a B/L yet. */
  businessKeyProcesses: [],

  /** A B/L's events name no other subject: it pins no documents. */
  linkedSubjects: [],
};
