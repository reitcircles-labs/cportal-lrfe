import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import {AuditApi, ProofKind} from '../api/audit.api';
import {RbacService} from '../state/rbac.service';
import {InfoTipComponent} from './info-tip.component';

/** How to check a downloaded proof, with the wallet address when it is known. */
function checkTip(address: string | null): string {
  return (
    'A proof shows that this item’s fingerprint is in a batch on the blockchain. Anyone can check the file without the portal, with the registry’s offline verifier:\n\n' +
    `node lrfe-verify.mjs <proof file> --address ${address ?? '<the registry’s anchoring wallet>'}\n\n` +
    'The address is the registry’s anchoring wallet, which pays for every batch. The verifier checks that the batch was written by that wallet.'
  );
}

/**
 * "Download proof" for a land record version or a document version (API-672): saves its proof file
 * (`lrfe-audit-proof/1`) for the offline verifier, with an (i) note on how to check it. Shown only to
 * whoever can open the Audit screen (`audit.view`). While the item waits for the next batch, it says
 * that the proof can be checked only once the item is on the blockchain.
 *
 *   <app-proof-download kind="record-version" [itemId]="recordId" [version]="2" fileName="proof-LR-NA-2026-000001-v2.json" />
 */
@Component({
  selector: 'app-proof-download',
  imports: [InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (canView()) {
      <span class="dl">
        @if (waiting()) {
          <span class="small muted">Proof file: it can be checked once this is on the blockchain</span>
        } @else {
          <button type="button" class="btn btn-secondary btn-sm" [disabled]="busy()" (click)="download()">Download proof</button>
        }
        <app-info-tip label="proof file" align="right" [text]="tip()" (click)="loadAddress()" />
      </span>
      @if (error(); as e) { <span class="small tone-danger" role="alert">{{ e }}</span> }
    }
  `,
  styles: [
    `
    :host { display: inline-flex; flex-direction: column; gap: 2px; }
    .dl { display: inline-flex; align-items: center; gap: 2px; }
    .btn-sm { min-height: 32px; padding: 0 10px; font-size: 13px; }
    .tone-danger { color: var(--danger-fg); }
  `,
  ],
})
export class ProofDownloadComponent {
  private readonly audit = inject(AuditApi);
  private readonly rbac = inject(RbacService);

  /** What the proof is of. */
  readonly kind = input.required<ProofKind>();
  /** The land record's or document's id, or a trail entry's number. */
  readonly itemId = input.required<string>();
  /** The version; none for a trail entry. */
  readonly version = input<number | undefined>(undefined);
  /** The name the file is saved under. */
  readonly fileName = input.required<string>();
  /** The item waits for the next batch: its proof cannot be checked yet. */
  readonly waiting = input(false);

  protected readonly canView = computed(() => this.rbac.can('audit.view'));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly address = signal<string | null>(null);
  protected readonly tip = computed(() => checkTip(this.address()));

  /** The wallet address for the note, read once when the note is opened. */
  protected loadAddress(): void {
    if (this.address()) {
      return;
    }
    this.audit.wallet().then(
      w => this.address.set(w.address),
      () => {},
    );
  }

  protected async download(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const proof = await this.audit.proof(
        this.kind(),
        this.itemId(),
        this.version(),
      );
      const link = document.createElement('a');
      link.href = URL.createObjectURL(
        new Blob([JSON.stringify(proof, null, 2)], {type: 'application/json'}),
      );
      link.download = this.fileName();
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
