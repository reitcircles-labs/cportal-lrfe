import {recordKindOf} from './domain.js';

/**
 * What an event is about, as `kind:id` strings (README.md section 1). The trail of a record, a
 * document or a user is found through them.
 *
 *   record:<record id>          document:<EDRMS document id>    edrmsNo:<EDR-NA-2026-000005>
 *   intake:<intake document id> process:<bpm instance id>       user:<user id>
 *
 * The product's record is described by the domain pack's record kind (CB-3): the subject kind
 * `record` is fixed (it is in the anchored trail); a product without a record kind has no `record`
 * subjects. A record's events may name documents by EDRMS number in their changes (the pack's
 * `linkedSubjects`), edrms and intake by id and number: both are kept, so either links them.
 *
 * The subjects are part of an entry's hash (chain.js), in the order found: that order never changes.
 */
const ALL_KINDS = [
  'record',
  'document',
  'edrmsNo',
  'intake',
  'process',
  'user',
];

/** bpm processes of the shared services whose business key is another subject (bpm/src/definitions). */
const BUSINESS_KEY = {
  'document-amendment': 'document',
};

/**
 * The subject kinds of an install: every kind, without `record` when the product has no record kind.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {!Array<string>}
 */
export function subjectKinds(pack) {
  return recordKindOf(pack) ? ALL_KINDS : ALL_KINDS.filter(k => k !== 'record');
}

/**
 * The value at a path of keys into an object, or undefined.
 * @param {object} data
 * @param {!Array<string>} path
 * @return {unknown}
 */
function valueAt(data, path) {
  let value = data;
  for (const key of path) {
    value = value?.[key];
  }
  return value;
}

/**
 * The subjects (`kind:id`) an event is about, as listed above.
 * @param {object} event a domain event
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {!Array<string>}
 */
export function subjectsOf(event, pack) {
  const kind = recordKindOf(pack);
  const d = event.data || {};
  const out = new Set();
  const add = (subjectKind, id) => {
    if (id !== undefined && id !== null && id !== '') {
      out.add(`${subjectKind}:${id}`);
    }
  };

  add('user', event.actor?.id);
  if (kind) {
    add('record', d.recordId);
  }
  if (event.source === 'intake') {
    add('intake', d.documentId);
  } else if (event.source === 'edrms') {
    add('document', d.documentId);
  }
  add('document', d.edrmsDocumentId);
  add('edrmsNo', d.edrmsNo);
  if (event.source === 'edrms') {
    add('intake', d.sourceId); // filed from this intake document
  }
  // a record's own links: a document linked, updated or unlinked, or a pinned document amended
  for (const linked of kind?.linkedSubjects ?? []) {
    add(linked.kind, valueAt(d, linked.path));
  }
  add('process', d.instanceId);
  add('process', d.reviewInstanceId);
  if (d.instanceId) {
    const keyKind = kind?.businessKeyProcesses.includes(d.definitionKey)
      ? 'record'
      : BUSINESS_KEY[d.definitionKey];
    if (keyKind) {
      add(keyKind, d.businessKey);
    }
  }
  add('user', d.userId);
  add('user', d.submittedBy?.id);
  add('user', d.approvedBy?.id);
  return [...out];
}

/**
 * "record:…" → ['record', '…'], or null when it is not a subject of this install.
 * @param {string} s
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {?Array<string>}
 */
export function parseSubject(s, pack) {
  const i = String(s ?? '').indexOf(':');
  if (i < 1) {
    return null;
  }
  const kind = s.slice(0, i);
  const id = s.slice(i + 1);
  return subjectKinds(pack).includes(kind) && id ? [kind, id] : null;
}

/**
 * Subjects whose entries belong to another subject's trail: from a record to its documents and
 * their capture, filing and processes. Records and users never pull in more (a document used in
 * two records does not bring the other record's steps along).
 */
export const FOLLOWS = new Set(['document', 'edrmsNo', 'intake', 'process']);
