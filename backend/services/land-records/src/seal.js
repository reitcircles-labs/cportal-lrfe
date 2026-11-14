/**
 * The seal of a committed version (README.md section 7) and the recomputation of the chain. The
 * formula is shared by every product's record service and lives in `@lrfe/record-contract/seal`
 * (CB-27), because the offline verifier repeats it for every product; land seals are unchanged.
 */
export {sealOf, verifyChain} from '@lrfe/record-contract/seal';
