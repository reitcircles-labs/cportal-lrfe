/**
 * The land registry's texts for the audit service (CB-3): the name of its record in messages, the
 * sign-off messages and the evidence pack's README. The audit service has plain defaults for
 * whatever a pack leaves out.
 */
export const audit = {
  /** One record, in messages: "This land record version is not in the audit tree yet". */
  record: 'land record',

  /** The portal, in the evidence pack's README: "Exported … from the land records portal of …". */
  portal: 'land records portal',

  /** What "Is it on the blockchain?" asks for when the search is empty. */
  lookupHint: 'Give a land record number, document number, Erf or deed number',

  /**
   * The first two lines of the README's note on what no seal covers, wrapped as the README is (its
   * next line begins "times of sign-offs and findings").
   */
  evidenceUnsealed:
    'Not covered by any seal, shown as exported: this README, who exported the pack and when, the land\n' +
    "record's summary (record/record.json) beyond its id and current version, document titles, and the",
};
