/**
 * What an event is about, as `kind:id` strings (README.md section 1). The trail of a land record, a
 * document or a user is found through them.
 *
 *   record:<land record id>     document:<EDRMS document id>    edrmsNo:<EDR-NA-2026-000005>
 *   intake:<intake document id> process:<bpm instance id>       user:<user id>
 *
 * Land records name documents by EDRMS number in their changes, edrms and intake by id and number:
 * both are kept, so either links them.
 */
export const KINDS = ['record', 'document', 'edrmsNo', 'intake', 'process', 'user'];

/** bpm processes whose business key is another subject (bpm/src/definitions). */
const BUSINESS_KEY = { 'land-record-review': 'record', 'document-amendment': 'document' };

export function subjectsOf(event) {
    const d = event.data || {};
    const out = new Set();
    const add = (kind, id) => { if (id !== undefined && id !== null && id !== '') out.add(`${kind}:${id}`); };

    add('user', event.actor?.id);
    add('record', d.recordId);
    if (event.source === 'intake') add('intake', d.documentId);
    else if (event.source === 'edrms') add('document', d.documentId);
    add('document', d.edrmsDocumentId);
    add('edrmsNo', d.edrmsNo);
    if (event.source === 'edrms') add('intake', d.sourceId);               // filed from this intake document
    add('edrmsNo', d.change?.edrmsNo);                                     // land record: document linked, updated, unlinked
    add('document', d.flag?.edrmsDocumentId);                              // land record flagged: a pinned document was amended
    add('edrmsNo', d.flag?.edrmsNo);
    add('process', d.instanceId);
    add('process', d.reviewInstanceId);
    if (d.instanceId && BUSINESS_KEY[d.definitionKey]) add(BUSINESS_KEY[d.definitionKey], d.businessKey);
    add('user', d.userId);
    add('user', d.submittedBy?.id);
    add('user', d.approvedBy?.id);
    return [...out];
}

/** "record:…" → ['record', '…'], or null when it is not a subject. */
export function parseSubject(s) {
    const i = String(s ?? '').indexOf(':');
    if (i < 1) return null;
    const kind = s.slice(0, i), id = s.slice(i + 1);
    return KINDS.includes(kind) && id ? [kind, id] : null;
}

/**
 * Subjects whose entries belong to another subject's trail: from a land record to its documents
 * and their capture, filing and processes. Records and users never pull in more (a document used
 * in two records does not bring the other record's steps along).
 */
export const FOLLOWS = new Set(['document', 'edrmsNo', 'intake', 'process']);
