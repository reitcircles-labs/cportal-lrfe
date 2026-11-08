import {createRecordClient} from '@lrfe/record-contract';

/**
 * Connectors to the product's record service (CB-4: the record contract), for
 * "land-record-review". Each sends the decision of the approval task; the record service rechecks
 * the version's state, so a repeated call is harmless.
 * @param {function(string, string, object=): Promise<any>} call the bpm service client's transport
 */
export function recordsConnectors(call) {
  const records = createRecordClient(call);
  const decision = v => ({
    by: {id: v.approval.by.id, name: v.approval.by.name},
    comment: v.approval.comment || undefined,
  });
  return {
    /** Approved: the record service commits the version (sealed, chained) and makes it current. */
    async 'records.commitVersion'({variables: v}) {
      const res = await records.commit(
        v.record.id,
        v.record.versionNumber,
        decision(v),
      );
      return {seal: res.current?.seal ?? null};
    },
    /** Rejected: the version goes back to the submitter as a draft, with the comment. */
    async 'records.rejectVersion'({variables: v}) {
      await records.reject(v.record.id, v.record.versionNumber, decision(v));
      return {};
    },
  };
}
