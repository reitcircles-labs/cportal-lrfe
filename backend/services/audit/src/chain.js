import {createHash} from 'node:crypto';
import {canonicalJson} from '@lrfe/common';

/**
 * The trail's hash chain (README.md section 1):
 *
 *   contentHash(n) = SHA-256( canonicalJson({ seq, eventId, type, source, time, actor, subjects, data }) )
 *   hash(n)        = SHA-256( prevHash || contentHash )     (both 32 bytes; hex in the database)
 *   prevHash(1)    = 32 zero bytes
 */
export const ZERO_HASH = '0'.repeat(64);

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

/**
 * The contentHash of a trail entry (above): the SHA-256 of the canonical JSON of its eight
 * content fields (seq, eventId, type, source, time, actor, subjects, data).
 */
export function contentHash({
  seq,
  eventId,
  type,
  source,
  time,
  actor,
  subjects,
  data,
}) {
  return sha256(
    canonicalJson({seq, eventId, type, source, time, actor, subjects, data}),
  );
}

/**
 * The hash of a trail entry (above): the SHA-256 of the previous entry's hash and this entry's
 * content hash.
 */
export const chainHash = (prevHash, content) =>
  sha256(Buffer.from(prevHash, 'hex'), Buffer.from(content, 'hex'));

/** The entry that follows `last` (null: the first), with its hashes. */
export function nextEntry(last, fields) {
  const seq = last ? last.seq + 1 : 1;
  const prevHash = last ? last.hash : ZERO_HASH;
  const entry = {seq, ...fields, prevHash};
  entry.contentHash = contentHash(entry);
  entry.hash = chainHash(prevHash, entry.contentHash);
  return entry;
}

/**
 * Check entries in order against the chain, continuing from `last` (the entry before them, or
 * null). The first problem found, or null.
 */
export function checkEntries(last, entries) {
  let prev = last;
  for (const e of entries) {
    const expectedSeq = prev ? prev.seq + 1 : 1;
    if (e.seq !== expectedSeq) {
      return {
        seq: expectedSeq,
        problem: e.seq > expectedSeq ? 'missing' : 'out of order',
      };
    }
    if (e.prevHash !== (prev ? prev.hash : ZERO_HASH)) {
      return {seq: e.seq, problem: 'does not follow the entry before it'};
    }
    if (
      contentHash(e) !== e.contentHash ||
      chainHash(e.prevHash, e.contentHash) !== e.hash
    ) {
      return {seq: e.seq, problem: 'changed'};
    }
    prev = e;
  }
  return null;
}
