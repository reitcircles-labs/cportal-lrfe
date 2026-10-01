import { BadRequestError, ConflictError } from '@lrfe/common';

/**
 * Connectors to the edrms service. Each receives { instance, token, variables, input } and
 * returns what is merged into the instance variables (or stored under the node's outputVar).
 */
export function edrmsConnectors(call) {
    return {
        /**
         * Precheck for "document-amendment": the document exists, is at the version the requester
         * was looking at, and the change is real. Returns a before/after preview for the approver.
         */
        async 'edrms.prepareAmendment'({ variables: v }) {
            const doc = await call('GET', `/documents/${v.documentId}`);
            if (doc.currentVersion !== v.expectedVersion) {
                throw new ConflictError(`${doc.edrmsNo} is now at version ${doc.currentVersion}.0. Reload and try again.`);
            }
            const preview = [];
            for (const { k, v: to } of v.changes || []) {
                const field = doc.fields.find(f => f.k === k);
                if (!field) throw new BadRequestError(`${doc.edrmsNo} has no field "${k}"`);
                if (field.v !== to) preview.push({ k, label: field.label, from: field.v, to });
            }
            if (!preview.length && !v.recordMetadata) throw new BadRequestError('Nothing to change: every value is already current');
            return {
                document: { id: doc.id, edrmsNo: doc.edrmsNo, title: doc.title, instrumentRef: doc.instrumentRef, docType: doc.docType, currentVersion: doc.currentVersion },
                preview
            };
        },

        /** Apply an approved amendment. edrms rechecks the version, so a concurrent change fails cleanly (409). */
        async 'edrms.applyAmendment'({ variables: v }) {
            const res = await call('POST', `/documents/${v.documentId}/amendments`, {
                reason: v.reason,
                expectedVersion: v.expectedVersion,
                changes: v.changes,
                ...(v.recordMetadata ? { recordMetadata: v.recordMetadata } : {}),
                actor: v.startedBy,
                approvedBy: { id: v.approval.by.id, name: v.approval.by.name }
            });
            return { amendedVersion: res.version.versionNumber, seal: res.version.seal };
        }
    };
}
