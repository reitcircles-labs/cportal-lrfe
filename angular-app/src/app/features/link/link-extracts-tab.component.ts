import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import {Extract} from '../../api/extracts.api';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkExtracts} from './link-extracts';
import {extentText, tenureLabel} from './link-format';

/** The (i) explanations of the Extracts tab (the API-690 wording sheet). */
const TIPS = {
  extract:
    'A statement of who owns this parcel, from the record’s current version, sealed by the registry. Anyone can check it against the blockchain by scanning its QR code: that it is exactly what the registry recorded, and whether it is still current.',
  onChain:
    'The version’s fingerprint is in a batch written to the public blockchain. From then on nobody, not even the registry, can change the version without it showing. An extract can be issued only then, so that it can be checked.',
  status:
    'Valid · current: the extract shows the record’s current version.\nValid · replaced: the record has a newer version; the check page tells the reader to ask for a new extract.\nWithdrawn: the registry revoked it; the check page says so.',
};

/**
 * Land record, Extracts tab (API-692, designed in API-690): the readiness of the record's current
 * version, the register of its ownership extracts, and the issue, issued and revoke dialogs.
 */
@Component({
  selector: 'app-link-extracts-tab',
  imports: [InfoTipComponent],
  template: `
    @let r = store.rec()!;
    @let v = extracts.current();
    <section class="panel" aria-labelledby="ex-h">
      <div class="panel-head ex-head">
        <div class="stack" style="gap:6px;min-width:0">
          <div class="row" style="gap:4px"><h4 id="ex-h">Ownership extracts</h4><app-info-tip label="Ownership extract" [text]="tips.extract" /></div>
          <span class="small muted">Issued at the counter to a registered owner. The QR code on it opens the public check page.</span>
          @switch (extracts.readiness()) {
            @case ('ready') {
              <span class="row small" style="gap:8px"><span class="tag tag-accent">On the blockchain</span>
                <span>Version {{ v!.versionNumber }} is current{{ extracts.anchoring()?.batch ? ', in batch ' + extracts.anchoring()!.batch : '' }}{{ extracts.anchoring()?.confirmedAt ? ' since ' + store.fmt(extracts.anchoring()!.confirmedAt) : '' }}.</span>
                <app-info-tip label="On the blockchain" [text]="tips.onChain" /></span>
            }
            @case ('anchoring') {
              <span class="row small" style="gap:8px"><span class="tag tag-outline">Waiting for confirmation</span>
                <span>Version {{ v!.versionNumber }} is on the blockchain and waiting to be confirmed. You can issue an extract once it is, usually within minutes.</span></span>
            }
            @case ('waiting') {
              <span class="row small" style="gap:8px"><span class="tag tag-outline">Waiting for next batch</span>
                <span>Version {{ v!.versionNumber }} is not on the blockchain yet. You can issue an extract once it is, usually within the hour.</span></span>
            }
            @case ('unknown') {
              <span class="row small" style="gap:8px"><span class="tag tag-outline">Status unknown</span>
                <span>Whether version {{ v!.versionNumber }} is on the blockchain can't be read right now. Try again in a moment.</span></span>
            }
            @default { <span class="small">This record has no approved version yet, so no extract can be issued.</span> }
          }
          @if (r.draft && v) {
            <span class="small muted">A change is in progress (draft version {{ r.draft.versionNumber }}). Extracts show version {{ v.versionNumber }}, the current one, until version {{ r.draft.versionNumber }} is approved.</span>
          }
        </div>
        <button type="button" class="btn btn-primary" [disabled]="extracts.readiness() !== 'ready'" (click)="extracts.openIssue()">Issue extract</button>
      </div>
      <div style="overflow-x:auto">
        <table class="table">
          <thead><tr><th scope="col">Extract</th><th scope="col">Issued</th><th scope="col">To</th><th scope="col">Version</th>
            <th scope="col"><span class="row" style="gap:2px;flex-wrap:nowrap">Status<app-info-tip label="Extract status" [text]="tips.status" align="right" /></span></th>
            <th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (e of extracts.items(); track e.id) {
              <tr>
                <td><b class="num" style="white-space:nowrap">{{ e.extractNo || '—' }}</b></td>
                <td>{{ store.fmt(e.issuedAt) }}<div class="small muted">by {{ e.issuedByName || '—' }}</div></td>
                <td>{{ e.ownerName }}</td>
                <td>v{{ e.versionNumber }}</td>
                <td><span class="tag" [class]="'tag ' + statusOf(e).tag">{{ statusOf(e).label }}</span>
                  @if (e.status === 'revoked') { <div class="small muted" style="margin-top:4px">Withdrawn {{ store.fmt(e.revokedAt) }} by {{ e.revokedByName || '—' }}: {{ e.revokeReason }}</div> }</td>
                <td style="text-align:right;white-space:nowrap">
                  @if (e.status === 'valid') {
                    <button type="button" class="btn btn-ghost" [attr.aria-label]="'Download again ' + (e.extractNo || '')" (click)="extracts.download(e)">Download again</button>
                    <button type="button" class="btn btn-ghost" [attr.aria-label]="'Revoke ' + (e.extractNo || '')" (click)="extracts.openRevoke(e)">Revoke</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="small muted" style="text-align:center;padding:18px">{{ !extracts.loaded() ? 'Loading…' : extracts.failed() ? 'The extracts could not be loaded.' : 'No extracts issued for this record yet.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
      <div class="small muted foot">Every extract issued or revoked is recorded in the audit trail, with who did it and when.</div>
    </section>

    @switch (extracts.dialog()) {
      @case ('issue') {
        <div class="dialog-backdrop" (click)="extracts.close()">
          <form class="dialog" role="dialog" aria-modal="true" style="width:min(600px,100%)" aria-labelledby="is-h" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); extracts.issue()">
            <div class="dialog-title" id="is-h">Issue an ownership extract</div>
            <div class="dialog-body">For {{ r.label }}. Only a registered owner can be given one: check their identity document.</div>
            <fieldset class="grp">
              <legend>1 · The owner</legend>
              @for (o of extracts.owners(); track $index) {
                <label class="pick"><input type="radio" name="owner" [checked]="extracts.ownerIndex() === $index" (change)="extracts.pickOwner($index)">
                  <span class="stack" style="gap:0"><b>{{ o.name }}</b><span class="small muted">Registered owner, {{ o.share }} share{{ o.since ? ', under ' + o.since : '' }}</span></span></label>
              }
              <div class="field"><label for="idno">ID number on their identity document</label>
                <input id="idno" class="input num" inputmode="numeric" autocomplete="off" [disabled]="extracts.ownerIndex() === null" [value]="extracts.idNo()" (input)="extracts.idNo.set($any($event.target).value)" aria-describedby="idno-help">
                <span id="idno-help" class="small" [class.ok]="extracts.idMatches() === true" [class.bad]="extracts.idMatches() === false">
                  @if (extracts.idMatches() === true) { ✓ Matches the ID number on the record for {{ extracts.owner()!.name }}. }
                  @else if (extracts.idMatches() === false) { Doesn't match the ID number on the record for {{ extracts.owner()!.name }}. Check the document: an extract is issued only to a registered owner. }
                  @else { Typed in from the document, and checked against the ID number on the record. }
                </span></div>
              <label class="pick"><input type="checkbox" [checked]="extracts.idSeen()" (change)="extracts.idSeen.set($any($event.target).checked)">
                <span>I have seen the owner's identity document, and the person in front of me is that owner.</span></label>
            </fieldset>
            @if (v) {
              <div class="shows">
                <b>2 · What the extract shows</b>
                <span>Version {{ v.versionNumber }}, the current one · committed {{ store.fmt(v.committedAt) }} · on the blockchain{{ extracts.anchoring()?.batch ? ' in batch ' + extracts.anchoring()!.batch : '' }}</span>
                <span class="small muted">{{ r.label }}{{ v.data.parcel['regDiv'] ? ' · Reg. division ' + v.data.parcel['regDiv'] : '' }} · {{ extentText(v.data.extent) }} · {{ tenureLabel(v.data.tenure) }} · Owners {{ ownersText() }}</span>
              </div>
            }
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" (click)="extracts.close()">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="!extracts.canIssue()">Issue extract</button>
            </div>
          </form>
        </div>
      }
      @case ('issued') {
        @let x = extracts.issued()!;
        <div class="dialog-backdrop" (click)="extracts.close()">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="id-h" style="width:min(560px,100%)" (click)="$event.stopPropagation()">
            <div class="dialog-title" id="id-h">Extract {{ x.extractNo }} issued to {{ x.ownerName }}</div>
            <div class="dialog-body">Sealed by the registry, for version {{ x.versionNumber }}. Give the owner the PDF, or print it for them.</div>
            <div class="small muted">Recorded in the audit trail. The QR code on the extract opens the public check page.</div>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" (click)="extracts.close()">Close</button>
              <button type="button" class="btn btn-secondary" (click)="extracts.print(x)">Print</button>
              <button type="button" class="btn btn-primary" (click)="extracts.download(x)">Download PDF</button>
            </div>
          </div>
        </div>
      }
      @case ('revoke') {
        @let x = extracts.revoking()!;
        <div class="dialog-backdrop" (click)="extracts.close()">
          <form class="dialog" role="dialog" aria-modal="true" style="width:min(520px,100%)" aria-labelledby="rv-h" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); extracts.revoke()">
            <div class="dialog-title" id="rv-h">Revoke extract {{ x.extractNo }}?</div>
            <div class="dialog-body">The public check page will then say the registry withdrew this extract. This can't be undone; the owner can be given a new one.</div>
            <div class="field" style="margin-top:12px"><label for="rv-r">Reason (kept in the audit trail)</label>
              <textarea id="rv-r" class="input" rows="3" style="height:auto;padding:8px 12px" placeholder="For example: the owner reported it lost" [value]="extracts.reason()" (input)="extracts.reason.set($any($event.target).value)"></textarea></div>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" (click)="extracts.close()">Cancel</button>
              <button type="submit" class="btn btn-danger" [disabled]="extracts.busy() || !extracts.reason().trim()">Revoke extract</button>
            </div>
          </form>
        </div>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .ex-head { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
    .foot { padding: 12px 18px; border-top: 1px solid var(--color-divider); }
    .grp { border: 1px solid var(--color-divider); border-radius: 10px; padding: 12px 14px; margin: 12px 0 0; display: flex; flex-direction: column; gap: 10px; }
    .grp legend { font-weight: 600; padding: 0 4px; }
    .pick { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; cursor: pointer; min-height: 32px; }
    .pick input { width: 18px; height: 18px; margin-top: 2px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .ok { color: var(--success); font-weight: 600; }
    .bad { color: var(--warn-fg); font-weight: 600; }
    .shows { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px 14px; border-radius: 10px; background: var(--color-neutral-100); }
  `,
  ],
})
export class LinkExtractsTabComponent {
  protected readonly store = inject(LinkStore);
  protected readonly extracts = inject(LinkExtracts);
  protected readonly tips = TIPS;
  protected readonly extentText = extentText;
  protected readonly tenureLabel = tenureLabel;

  /** The owners of the current version, as the extract lists them. */
  protected readonly ownersText = computed(() =>
    this.extracts
      .owners()
      .map(o => `${o.name} ${o.share}`)
      .join(', '),
  );

  /** An extract's status in the register: its label and tag. */
  protected statusOf(e: Extract): {label: string; tag: string} {
    if (e.status === 'revoked') return {label: 'Withdrawn', tag: 'tag-neutral'};
    if (e.isCurrentVersion === null) return {label: 'Valid', tag: 'tag-accent'};
    return e.isCurrentVersion
      ? {label: 'Valid · current', tag: 'tag-accent'}
      : {label: 'Valid · replaced', tag: 'tag-outline'};
  }
}
