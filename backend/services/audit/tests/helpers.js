// The in-memory chain the tests anchor on lives with the service, which also offers it to the
// end-to-end test stack (src/cardano/test-chain.js).
export { createTestChainDriver as fakeDriver, PARAMS, txid } from '../src/cardano/test-chain.js';
