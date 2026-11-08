/**
 * The land registry's `recordKind` section (CB-3): what the audit service needs to know about a
 * land record. The names the audit trail and the tree already hold stay fixed in the audit service:
 * the subject `record:<id>`, the tree leaf of type 1 keyed `record-version:<id>:<n>` and the proof
 * kind `record-version`. This section says which events and fields map to them
 * (docs/architecture/products.md, "What may never change").
 */
export const recordKind = {
  /** The service whose events commit record versions, as the trail and the checks name it. */
  source: 'land-records',

  /**
   * The service that answers the record contract (CB-4, `@lrfe/record-contract`): the name other
   * services know its token by, what error texts call it, and the setting holding its address.
   */
  service: {
    name: 'land-records',
    label: 'land records',
    urlSetting: 'RECORDS_URL',
    defaultUrl: 'http://localhost:3505',
  },

  /**
   * The event that commits a record version (`data.recordId`, `data.versionNumber`, `data.seal`):
   * it becomes a tree leaf of type 1, and resolves the findings on older versions of the record.
   */
  committedEvent: 'records.record.committed',

  /** Workflow processes whose business key is a record id: their steps join the record's trail. */
  businessKeyProcesses: ['land-record-review'],

  /**
   * Further subjects a record's events name, in this order, each at a path into the event's data:
   * a document linked, updated or unlinked (`change`), or a pinned document that was amended (`flag`).
   */
  linkedSubjects: [
    {kind: 'edrmsNo', path: ['change', 'edrmsNo']},
    {kind: 'document', path: ['flag', 'edrmsDocumentId']},
    {kind: 'edrmsNo', path: ['flag', 'edrmsNo']},
  ],

  /** The permission to commit a record version: whoever holds it cannot sign off audits. */
  commitPermission: 'record.finalize',

  /** How "Is it on the blockchain?" recognises a number in a search (API-697). */
  lookup: {
    /** A land record number: LR-NA-2026-000001. */
    recordNumber: /^LR-/i,
    /** A deed or other instrument number: T 2210/2008, A 412/2007, B 3301/2015 (spaces around the slash allowed). */
    instrumentNumber: /^[A-Z]{1,3}\s?\d{1,7}\s?\/\s?\d{4}$/i,
  },
};
