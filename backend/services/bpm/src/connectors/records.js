/**
 * Connectors to the land-records service, for "land-record-review". Each sends the decision of
 * the approval task; land-records rechecks the version's state, so a repeated call is harmless.
 */
export function recordsConnectors(call) {
    const decision = (v) => ({ by: { id: v.approval.by.id, name: v.approval.by.name }, comment: v.approval.comment || undefined });
    return {
        /** Approved: land-records commits the version (sealed, chained) and makes it current. */
        async 'records.commitVersion'({ variables: v }) {
            const res = await call('POST', `/records/${v.record.id}/versions/${v.record.versionNumber}/commit`, decision(v));
            return { seal: res.current?.seal ?? null };
        },
        /** Rejected: the version goes back to the submitter as a draft, with the comment. */
        async 'records.rejectVersion'({ variables: v }) {
            await call('POST', `/records/${v.record.id}/versions/${v.record.versionNumber}/reject`, decision(v));
            return {};
        }
    };
}
