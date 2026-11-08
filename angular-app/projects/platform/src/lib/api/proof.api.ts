import {Injectable, inject} from '@angular/core';

import type {VerifyResult} from '../shared/verify-wording';
import {ApiService} from './api.service';

/** What a proof can be of (GET /audit/proofs/{kind}/{id}). */
export type ProofKind = 'record-version' | 'document-version' | 'trail-entry';

/** A proof's status: in no anchoring yet, anchored, or confirmed. */
export type ProofStatus = 'waiting' | 'anchored' | 'confirmed';

/**
 * Proofs and blockchain checks of the audit service (gateway prefix /api/audit), the same for
 * every product.
 */
@Injectable({providedIn: 'root'})
export class ProofApi {
  protected readonly api = inject(ApiService);

  /** A proof file (`lrfe-audit-proof/1`), for the offline verifier (API-672). */
  proof(kind: ProofKind, id: string, version?: number) {
    return this.api.get<Record<string, unknown>>(
      `/audit/proofs/${kind}/${id}`,
      {version},
    );
  }

  /** Check a version against the blockchain now (API-675). */
  verify(kind: ProofKind, id: string, version?: number) {
    return this.api.post<VerifyResult>('/audit/verify', {
      kind,
      id,
      ...(version ? {version} : {}),
    });
  }

  /** The anchoring wallet the installation publishes (no sign-in needed). */
  wallet() {
    return this.api.get<{
      address: string | null;
      explorerUrl: string | null;
      transactionUrl: string | null;
    }>('/audit/anchoring/wallet');
  }

  proofStatus(seq: number) {
    return this.api.get<{status: ProofStatus; anchor: {batch: number} | null}>(
      `/audit/proofs/trail-entry/${seq}`,
    );
  }

  /** The whole trail's hash chain, recomputed. */
  verifyTrail() {
    return this.api.get<{intact: boolean; brokenAt?: number}>(
      '/audit/trail/verify',
    );
  }

  verifyEntry(seq: number) {
    return this.api.post<{valid: boolean; status: ProofStatus}>(
      '/audit/verify',
      {kind: 'trail-entry', id: String(seq)},
    );
  }
}
