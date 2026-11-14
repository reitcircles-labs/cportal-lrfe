// The in-memory chain the tests anchor on lives with the service, which also offers it to the
// end-to-end test stack (src/cardano/test-chain.js).
export {
  createTestChainDriver as fakeDriver,
  PARAMS,
  txid,
} from '../src/cardano/test-chain.js';

/**
 * The names of the checks a verifier's result failed (lrfe-verify.mjs), in its order.
 *
 * @param {{checks: !Array<{name: string, ok: boolean}>}} result a verifier's result
 * @return {!Array<string>}
 */
export function failedChecks(result) {
  return result.checks.filter(check => !check.ok).map(check => check.name);
}
