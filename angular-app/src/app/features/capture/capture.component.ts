import { Component, DestroyRef, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { ApiError } from '../../api/api.service';
import { IN_PROGRESS, IntakeApi, IntakeBatch, IntakeSummary, STATUS_LABEL, needsChecks } from '../../api/intake.api';
import { RbacService, fmtTime } from '../../state/rbac.service';
import { ToastService } from '../../state/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { CanDirective } from '../../shared/can.directive';

const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg'];
const POLL_MS = 3000;

interface Upload { key: number; name: string; state: 'waiting' | 'uploading' | 'done' | 'error'; message?: string; }

/**
 * #/capture — upload scans into an intake batch (intake service). Each file is stored and queued
 * for AI extraction; its progress shows here until it is ready for review on #/verify.
 */
@Component({
    selector: 'app-capture',
    imports: [IconComponent, CanDirective],
    template: `
    <div class="page layout">
      <aside class="stack" style="gap:18px">
        <div class="stack" style="gap:8px">
          <div class="field"><label for="batch">Batch</label>
            <select id="batch" class="input" (change)="selectBatch($any($event.target).value)">
              @if (!batches().length) { <option value="">No batches yet</option> }
              @for (b of batches(); track b.id) { <option [value]="b.id" [selected]="b.id === batchId()">{{ b.id }}{{ b.source ? ' · ' + b.source : '' }}</option> }
            </select>
          </div>
          @if (newBatch() === null) {
            <button class="btn btn-secondary" style="align-self:flex-start" appCan="capture.scan" (click)="newBatch.set('')">New batch</button>
          } @else {
            <form class="stack" style="gap:8px" (submit)="$event.preventDefault(); createBatch()">
              <div class="field"><label for="src">Source of the new batch</label>
                <input id="src" class="input" maxlength="200" placeholder="e.g. Vault 3 · T-series vol. 2008" [value]="newBatch()" (input)="newBatch.set($any($event.target).value)"></div>
              <div class="row" style="gap:8px">
                <button type="submit" class="btn btn-primary" [disabled]="busy()">Create batch</button>
                <button type="button" class="btn btn-secondary" (click)="newBatch.set(null)">Cancel</button>
              </div>
            </form>
          }
        </div>

        @if (batch(); as b) {
          <div class="blueprint" style="padding:14px"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
            <div class="row" style="justify-content:space-between"><span class="card-kicker">Batch</span><span class="tag tag-accent">{{ working() ? 'Reading' : docs().length ? 'Idle' : 'Empty' }}</span></div>
            <div class="card-title" style="margin:4px 0 10px">{{ b.id }}</div>
            <div class="kv" style="font-size:13px">
              <span>Source</span><span>{{ b.source || '—' }}</span>
              <span>Created</span><span>{{ fmt(b.createdAt) }} · {{ b.createdByName }}</span>
              <span>Documents</span><span>{{ docs().length }} · {{ tally().ready }} in review · {{ tally().filed }} filed</span>
            </div>
          </div>

          <label class="drop" appCan="capture.scan" [class.over]="dragOver()"
                 (dragover)="$event.preventDefault(); dragOver.set(true)" (dragleave)="dragOver.set(false)" (drop)="onDrop($event)">
            <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" (change)="onPick($event)">
            <app-icon name="scan" [size]="22" />
            <b>Drop scans here or choose files</b>
            <span class="small muted">PDF, PNG or JPEG · one file = one instrument</span>
          </label>
        }

        @if (uploads().length) {
          <div class="stack" style="gap:6px">
            <div class="row small" style="justify-content:space-between"><b>Uploads</b><button class="btn btn-ghost small" [disabled]="uploading()" (click)="uploads.set([])">Clear</button></div>
            @for (u of uploads(); track u.key) {
              <div class="up" [class.err]="u.state === 'error'">
                <span class="ellipsis num" [title]="u.name">{{ u.name }}</span>
                <span class="small" [class.muted]="u.state !== 'error'">{{ u.state === 'error' ? u.message : u.state === 'done' ? 'Queued for reading' : u.state === 'uploading' ? 'Uploading…' : 'Waiting' }}</span>
              </div>
            }
          </div>
        }
      </aside>

      <section class="stack" style="gap:16px;min-width:0">
        <div class="row" style="justify-content:space-between;align-items:baseline">
          <h2 style="margin:0">{{ batch() ? 'Documents in ' + batch()!.id : 'Documents' }}</h2>
          <span class="small muted">Read by AI on arrival · values are proposals until a reviewer accepts them</span>
        </div>
        @if (!batch()) {
          <div class="blueprint empty"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
            {{ loading() ? 'Loading…' : 'Create a batch, then upload the scans that belong to it.' }}
          </div>
        } @else if (!docs().length) {
          <div class="blueprint empty"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
            No documents in this batch yet. Upload scans on the left.
          </div>
        } @else {
          <table class="table">
            <thead><tr><th>File</th><th>Read as</th><th>Status</th><th>Fields</th><th></th></tr></thead>
            <tbody>
              @for (d of docs(); track d.id) {
                <tr>
                  <td><div class="num ellipsis" style="max-width:260px" [title]="d.fileName">{{ d.fileName }}</div>
                    <div class="small muted">{{ d.pages ? d.pages + ' p. · ' : '' }}{{ size(d.size) }}</div></td>
                  <td>@if (d.docTypeLabel) { <div>{{ d.docTypeLabel }}{{ d.ref ? ' ' + d.ref : '' }}</div><div class="small muted ellipsis" style="max-width:260px">{{ d.property || '' }}</div> } @else { <span class="muted">—</span> }</td>
                  <td><span class="tag" [class.tag-accent]="d.status === 'ready' || d.status === 'filed'" [class.tag-danger]="d.status === 'failed'" [class.tag-neutral]="d.status !== 'ready' && d.status !== 'filed' && d.status !== 'failed'">{{ label(d) }}</span>
                    @if (d.status === 'failed' && d.extractionError) { <div class="small" style="color:var(--danger-fg);max-width:240px">{{ d.extractionError }}</div> }
                    @if (d.status === 'filed' && d.edrmsNo) { <div class="small muted num">{{ d.edrmsNo }}</div> }
                    @if (d.status === 'rejected' && d.rejectedReason) { <div class="small muted" style="max-width:240px">{{ d.rejectedReason }}</div> }</td>
                  <td class="small">@if (d.total) { {{ d.reviewed }}/{{ d.total }} reviewed @if (d.status === 'ready' && needs(d)) { <div style="color:var(--color-accent-800)">{{ needs(d) }} to check</div> } } @else { <span class="muted">—</span> }</td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="btn btn-secondary btn-icon" title="Open the scan" (click)="openFile(d)"><app-icon name="eye" [size]="15" /></button>
                    @if (d.status === 'failed') { <button class="btn btn-secondary" appCan="verify.edit" (click)="retry(d)">Retry</button> }
                    @if (d.status === 'ready') { <button class="btn btn-primary" appCan="verify.view" (click)="router.navigate(['/verify'], { queryParams: { doc: d.id } })">Review →</button> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    </div>
  `,
    changeDetection: ChangeDetectionStrategy.Eager,
    styles: [`
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 32px; align-items: start; }
    .empty { padding: 44px; text-align: center; color: var(--color-neutral-700); font-size: 14px; border-style: dashed; }
    .drop { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 26px 16px; text-align: center; border: 1.5px dashed var(--color-neutral-400); border-radius: var(--radius-lg); background: var(--color-surface); cursor: pointer; }
    .drop:hover, .drop.over { border-color: var(--color-accent); background: var(--color-accent-100); }
    .drop input { display: none; }
    .up { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; padding: 6px 10px; border-left: 2px solid var(--color-divider); font-size: 13px; }
    .up.err { border-left-color: var(--danger-bd); }
    .up.err .small { color: var(--danger-fg); }
    .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
  `]
})
export class CaptureComponent {
  private intake = inject(IntakeApi);
  private toast = inject(ToastService);
  rbac = inject(RbacService);
  router = inject(Router);

  batches = signal<IntakeBatch[]>([]);
  batchId = signal('');
  docs = signal<IntakeSummary[]>([]);
  uploads = signal<Upload[]>([]);
  newBatch = signal<string | null>(null);
  dragOver = signal(false);
  loading = signal(true);
  busy = signal(false);

  batch = computed(() => this.batches().find(b => b.id === this.batchId()) || null);
  working = computed(() => this.docs().some(d => IN_PROGRESS.includes(d.status)));
  uploading = computed(() => this.uploads().some(u => u.state === 'waiting' || u.state === 'uploading'));
  tally = computed(() => ({ ready: this.docs().filter(d => d.status === 'ready').length, filed: this.docs().filter(d => d.status === 'filed').length }));

  fmt = fmtTime;
  needs = needsChecks;
  private seq = 0;
  private timer: any = null;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; clearTimeout(this.timer); });
    this.loadBatches();
  }

  label(d: IntakeSummary) { return d.status === 'ready' && d.escalated ? 'In review · read twice' : STATUS_LABEL[d.status]; }
  size(n: number) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  async loadBatches(select?: string) {
    try {
      const { batches } = await this.intake.batches();
      this.batches.set([...batches].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
      const keep = select || this.batchId();
      const target = this.batches().some(b => b.id === keep) ? keep : this.batches()[0]?.id || '';
      if (target !== this.batchId() || !this.docs().length) await this.selectBatch(target);
    } catch (e) { this.fail('Could not load batches', e); } finally { this.loading.set(false); }
  }

  async selectBatch(id: string) {
    this.batchId.set(id);
    this.docs.set([]);
    await this.refresh();
  }

  /** Reload the batch's documents; keeps polling while any is still being read. */
  async refresh() {
    clearTimeout(this.timer);
    const id = this.batchId();
    if (!id || this.destroyed) return;
    try {
      const { items } = await this.intake.documents({ batchId: id });
      if (id !== this.batchId()) return;
      this.docs.set(items);
    } catch (e) { this.fail('Could not load the batch', e); return; }
    if (!this.destroyed && (this.working() || this.uploading())) this.timer = setTimeout(() => this.refresh(), POLL_MS);
  }

  async createBatch() {
    this.busy.set(true);
    try {
      const b = await this.intake.createBatch((this.newBatch() || '').trim());
      this.newBatch.set(null);
      this.toast.show('success', `Batch ${b.id} created`, 'Upload the scans that belong to it.');
      await this.loadBatches(b.id);
    } catch (e) { this.fail('Could not create the batch', e); } finally { this.busy.set(false); }
  }

  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    this.upload(Array.from(input.files || []));
    input.value = '';
  }

  onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragOver.set(false);
    if (!this.rbac.can('capture.scan')) { this.rbac.deny('capture.scan'); return; }
    this.upload(Array.from(e.dataTransfer?.files || []));
  }

  /** Upload one file at a time, in the order chosen; a refused file does not stop the rest. */
  private async upload(files: File[]) {
    const batchId = this.batchId();
    if (!files.length || !batchId) return;
    const items: Upload[] = files.map(f => ({ key: ++this.seq, name: f.name, state: 'waiting' }));
    this.uploads.update(u => [...items, ...u]);
    const set = (key: number, patch: Partial<Upload>) => this.uploads.update(list => list.map(u => u.key === key ? { ...u, ...patch } : u));
    for (const [i, f] of files.entries()) {
      const key = items[i].key;
      if (!ACCEPT.includes(f.type)) { set(key, { state: 'error', message: 'Not a PDF, PNG or JPEG (convert TIFF first)' }); continue; }
      set(key, { state: 'uploading' });
      try {
        await this.intake.upload(batchId, f);
        set(key, { state: 'done' });
      } catch (e) {
        set(key, { state: 'error', message: e instanceof ApiError ? e.message : String(e) });
      }
      if (batchId === this.batchId()) await this.refresh();
    }
    await this.loadBatches();
  }

  async openFile(d: IntakeSummary) {
    try {
      const { url } = await this.intake.fileLink(d.id);
      window.open(url, '_blank', 'noopener');
    } catch (e) { this.fail('Could not open the scan', e); }
  }

  async retry(d: IntakeSummary) {
    try {
      await this.intake.extract(d.id);
      this.toast.show('info', `${d.fileName} queued again`);
      await this.refresh();
    } catch (e) { this.fail('Could not queue the document', e); }
  }

  private fail(title: string, e: unknown) {
    this.toast.show('danger', title, e instanceof ApiError ? e.message : String(e), 7000);
  }
}
