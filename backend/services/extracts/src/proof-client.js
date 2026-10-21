import {AppError} from '@lrfe/common';

/**
 * The extracts service's call to the audit service for the proof attached to an extract's PDF
 * (API-691), with an extracts service token:
 *   recordProof(recordId, n) → { proof, explorerUrl }: the proof of version n of the land record,
 *                              the same as the evidence pack's proofs/record-v<n>.json
 * A proof that cannot be read now is a 503: the extract is then not issued.
 * `fetchImpl` lets tests route calls into an in-process audit app.
 */
export function createProofClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
}) {
  return {
    async recordProof(recordId, versionNumber) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/audit/anchoring/proof`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({recordId, version: versionNumber}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw unavailable(
          `the audit service cannot be reached: ${err.message}`,
        );
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.proof) {
        throw unavailable(
          `the audit service answered ${res.status}: ${body?.message ?? 'no proof'}`,
        );
      }
      return body;
    },
  };
}

/** 503 with a message for staff; what went wrong is kept for the log. */
function unavailable(detail) {
  const err = new AppError(
    503,
    'The proof that the version is on the blockchain cannot be read now: try again later',
  );
  err.cause = new Error(detail);
  return err;
}
