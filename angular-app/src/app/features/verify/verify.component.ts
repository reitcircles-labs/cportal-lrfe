import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiError } from '../../api/api.service';
import { IN_PROGRESS, IntakeApi, IntakeDetail, IntakeDocType, IntakeField, IntakeStatus, IntakeSummary, STATUS_LABEL, needsChecks } from '../../api/intake.api';
import { AuthService } from '../../state/auth.service';
import { RbacService } from '../../state/rbac.service';
import { ToastService } from '../../state/toast.service';
import { ConfirmService } from '../../state/confirm.service';
import { IconComponent } from '../../shared/icon.component';
import { CanDirective } from '../../shared/can.directive';

type QFilter = 'open' | 'filed' | 'all';
const OPEN: IntakeStatus[] = ['queued', 'extracting', 'ready', 'failed'];
const POLL_MS = 5000;
/** Signed file links live 300 s; fetch a new one before a page change after this age. */
const LINK_MAX_AGE_MS = 240_000;

/**
 * #/verify — review AI extraction field by field against the scan, its evidence and the checks,
 * then file the verified values into the EDRMS (intake service). Opening a document claims it,
 * so two reviewers do not work on the same one; the claim is released on leaving it.
 */
@Component({
  selector: 'app-verify',
  standalone: true,
  imports: [IconComponent, CanDirective],
  template: `
    <div class="shell" [class.collapsed]="!railOpen()">
      @if (railOpen()) {
        <aside class="rail">
          <div class="rail-head">
            <div class="row" style="justify-content:space-between"><h4 style="margin:0">Review queue</h4>
              <button class="btn btn-ghost btn-icon" style="width:28px;height:28px" title="Collapse queue" (click)="railOpen.set(false)"><app-icon name="panelClose" /></button></div>
            <div class="stats">
              <div><b class="num">{{ counts().open }}</b><span>Open</span></div>
              <div><b class="num">{{ counts().checks }}</b><span>Need checks</span></div>
              <div><b class="num">{{ counts().filed }}</b><span>Filed</span></div>
            </div>
            <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, file, batch" [value]="search()" (input)="search.set($any($event.target).value)"></div>
            <div class="row" style="justify-content:space-between">
              <div class="seg">
                @for (f of filters; track f.id) {
                  <label class="seg-opt sm"><input type="radio" name="qf" [checked]="filter() === f.id" (change)="filter.set(f.id)">{{ f.label }}</label>
                }
              </div>
              <button class="btn btn-ghost small" (click)="sortChecks.set(!sortChecks())"><app-icon name="sort" [size]="14" />{{ sortChecks() ? 'Most checks' : 'Batch order' }}</button>
            </div>
          </div>
          <div class="rail-list">
            @for (g of groups(); track g.id) {
              <button class="grp" (click)="toggle(g.id)">
                <span class="chev" [class.open]="!collapsed()[g.id]">▶</span>
                <span class="stack" style="gap:4px;min-width:0">
                  <span class="h-cond" style="font-size:14px">{{ g.id }}</span>
                  <span class="bar"><span [style.width.%]="g.pct"></span></span>
                </span>
                <span class="small muted num">{{ g.count }}</span>
              </button>
              @if (!collapsed()[g.id]) {
                @for (d of g.rows; track d.id) {
                  <button class="qrow" [class.on]="d.id === docId()" (click)="select(d.id)">
                    <span class="status-sq" [class.filed]="d.status === 'filed'" [class.progress]="d.status === 'ready' && d.reviewed > 0" [title]="statusLabel(d.status)"></span>
                    <span class="stack" style="gap:0;min-width:0">
                      <span class="h-cond num ellipsis" style="font-size:15px;line-height:1.2">{{ d.ref || d.fileName }}</span>
                      <span class="small muted ellipsis" style="font-size:11px">{{ sub(d) }}</span>
                    </span>
                    <span class="stack" style="gap:1px;align-items:flex-end">
                      <span class="num" style="font-size:11px" [style.color]="rowAlert(d) ? 'var(--color-accent-800)' : 'var(--color-neutral-700)'">{{ rowState(d) }}</span>
                      @if (d.status === 'ready') { <span class="num" style="font-size:10px;color:var(--color-neutral-600)">{{ d.reviewed }}/{{ d.total }}</span> }
                    </span>
                  </button>
                }
              }
            } @empty { <div class="small muted" style="padding:28px 16px;text-align:center">{{ loading() ? 'Loading…' : 'No documents match.' }}</div> }
          </div>
          <div class="rail-foot small muted"><span>Showing {{ visible().length }} of {{ list().length }}</span><span>□ open · ▣ in progress · ■ filed</span></div>
        </aside>
      } @else {
        <aside class="rail-min">
          <button class="btn btn-ghost btn-icon" title="Show queue" (click)="railOpen.set(true)"><app-icon name="panelOpen" /></button>
          <span class="vert">Queue · {{ counts().open }} open</span>
        </aside>
      }

      <section class="main">
        @if (doc(); as d) {
          <header class="doc-head">
            <div class="stack" style="gap:2px;min-width:0;margin-right:auto">
              <span class="card-kicker">{{ d.batchId }} · {{ posLabel() }}</span>
              <span class="row" style="gap:10px;align-items:baseline"><span class="h-cond" style="font-size:28px;line-height:1.05">{{ d.ref || d.fileName }}</span>
                <span style="font-size:13px;color:var(--color-neutral-800)" [title]="d.docTypeReason || ''">{{ d.docTypeLabel || 'Type not recognised' }}{{ d.property ? ' · ' + d.property : '' }}</span></span>
            </div>
            <button class="btn btn-secondary" (click)="openFile()"><app-icon name="eye" [size]="15" />Open scan</button>
            @if (d.status === 'ready' || d.status === 'failed') {
              <button class="btn btn-secondary" appCan="verify.edit" [disabled]="busy()" (click)="reread()" title="Read the document again with the stronger model">Re-read</button>
              <button class="btn btn-secondary" appCan="verify.file" [disabled]="busy() || !!lockedBy()" (click)="rejectDraft.set('')">Reject</button>
            }
            <div class="row" style="gap:4px">
              <button class="btn btn-secondary btn-icon" [disabled]="pos() <= 0" (click)="move(-1)" title="Previous document"><app-icon name="up" /></button>
              <button class="btn btn-secondary btn-icon" [disabled]="pos() < 0 || pos() >= flat().length - 1" (click)="move(1)" title="Next document"><app-icon name="down" /></button>
            </div>
          </header>

          @if (lockedBy()) {
            <div class="banner"><app-icon name="lock" [size]="18" /><span>{{ lockedBy() }}. You can look, but not change it.</span></div>
          }
          @for (n of d.notes; track n.code) {
            <div class="banner" [class.err]="n.level === 'error'" [class.quiet]="n.level === 'info'"><app-icon [name]="n.level === 'info' ? 'info' : 'alert'" [size]="18" /><span class="small">{{ n.message }}</span></div>
          }

          @switch (d.status) {
            @case ('queued') { <div class="panel state">Waiting to be read by the AI. This page updates by itself.</div> }
            @case ('extracting') { <div class="panel state">The AI is reading this document. This page updates by itself.</div> }
            @case ('failed') {
              <div class="banner err"><app-icon name="alert" [size]="18" /><span class="stack" style="gap:2px"><b>Reading failed</b><span class="small">{{ d.extractionError }}</span></span>
                <span class="spacer"></span><button class="btn btn-secondary" appCan="verify.edit" [disabled]="busy()" (click)="retry()">Retry</button></div>
            }
            @case ('rejected') { <div class="banner err"><app-icon name="x" [size]="18" /><span class="stack" style="gap:2px"><b>Rejected</b><span class="small">{{ d.rejectedReason }}</span></span></div> }
            @case ('filed') {
              <div class="banner ok"><app-icon name="checkCircle" [size]="18" /><span><b>Filed as {{ d.edrmsNo }}</b></span><span class="spacer"></span>
                @if (d.filedDocumentId) { <button class="btn btn-secondary" (click)="router.navigate(['/documents'], { queryParams: { id: d.filedDocumentId } })">Open in Documents →</button> }</div>
            }
          }

          @if (d.status === 'ready' || d.status === 'filed' || d.status === 'rejected') {
            <div class="review">
              <div class="stack" style="gap:8px;min-width:0">
                <div class="row small muted" style="justify-content:space-between"><span>Scan{{ d.pages ? ' · ' + d.pages + ' page' + (d.pages === 1 ? '' : 's') : '' }}{{ isPdf() ? ' · showing page ' + page() : '' }}</span><span>Selecting a field opens the page its evidence is on</span></div>
                <div class="scan">
                  @if (src(); as s) {
                    @if (isPdf()) { <iframe [src]="s" title="Scanned document"></iframe> } @else { <img [src]="rawUrl()" alt="Scanned document"> }
                  } @else { <div class="small muted" style="padding:40px;text-align:center">Loading the scan…</div> }
                </div>
                @if (pageText(); as t) {
                  <details class="transcript"><summary class="small">AI transcription of page {{ page() }}</summary><p class="small">{{ t }}</p></details>
                }
              </div>

              <div class="stack sticky" style="gap:10px">
                <div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">Extracted metadata</h3><span class="small muted">{{ reviewed() }} of {{ d.fields.length }} reviewed</span></div>
                <div class="row" style="gap:8px;flex-wrap:wrap">
                  <span class="tag tag-neutral">{{ d.docTypeLabel || 'Unknown type' }}</span>
                  @if (d.flags.conflict) { <span class="tag tag-danger">{{ d.flags.conflict }} conflict</span> }
                  @if (d.flags.check + d.flags.missing) { <span class="tag tag-outline">{{ d.flags.check + d.flags.missing }} to check</span> }
                  @if (d.escalated) { <span class="tag tag-info">read by two models</span> }
                </div>
                @if (!d.fields.length) {
                  <div class="small muted">No fields: the document type was not recognised. Re-read it with the stronger model, or reject it.</div>
                }
                <div class="fields">
                  @for (f of d.fields; track f.k) {
                    <div class="frow" [class.on]="f.k === activeKey()" (click)="activate(f)">
                      <div class="row small" style="gap:8px;min-width:0"><span class="muted">{{ f.label }}{{ f.required ? ' *' : '' }}</span>
                        @if (f.flag !== 'ok' && f.status === 'pending') { <span class="flag" [class.bad]="f.flag === 'conflict'">· {{ f.flag }}</span> }
                        @if (f.status === 'edited') { <span class="flag ok">· corrected</span> }</div>
                      <span></span>
                      <input class="input" [id]="'f-' + f.k" [readonly]="!editable()" [value]="f.value" (focus)="activate(f)"
                             (change)="save(f, $any($event.target).value)" (keydown.enter)="enter(f, $any($event.target).value)">
                      <button class="btn btn-icon" [class.btn-primary]="f.status !== 'pending'" [class.btn-secondary]="f.status === 'pending'" style="width:40px;height:32px"
                              [title]="f.status === 'pending' ? 'Accept' : 'Undo accept'" appCan="verify.edit" [disabled]="!editable()" (click)="toggleAccept(f, $event)"><app-icon name="check" /></button>
                      @if (f.k === activeKey()) {
                        <div class="detail">
                          @if (f.evidence?.text) { <div class="small"><span class="muted">Evidence{{ f.evidence?.page ? ', page ' + f.evidence?.page : '' }}:</span> “{{ f.evidence?.text }}”</div> }
                          @else if (f.extracted === null) { <div class="small muted">Not found by the AI{{ f.value ? '; entered by a reviewer' : '' }}.</div> }
                          @if (f.status === 'edited' && f.extracted !== null && f.extracted !== f.value) { <div class="small muted">AI read “{{ f.extracted }}”</div> }
                          @for (c of f.checks; track $index) { <div class="small chk" [class.err]="c.level === 'error'" [class.warn]="c.level === 'warn'">{{ c.message }}</div> }
                          @if (f.alt; as a) {
                            <div class="small row" style="gap:8px">{{ a.model }} read “{{ a.value }}”
                              @if (editable()) { <button class="btn btn-ghost small" (click)="save(f, a.value); $event.stopPropagation()">Use this reading</button> }</div>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
                @if (editable() && missingFields().length) {
                  <select class="input" style="font-size:13px" (change)="addField($any($event.target).value); $any($event.target).value = ''">
                    <option value="">Add a field the AI did not find…</option>
                    @for (m of missingFields(); track m.k) { <option [value]="m.k">{{ m.label }}</option> }
                  </select>
                }
                @if (d.status === 'ready') {
                  @if (blockers().length) { <ul class="blockers small">@for (b of blockers(); track b) { <li>{{ b }}</li> }</ul> }
                  <div class="row" style="margin-top:4px">
                    <button class="btn btn-secondary" appCan="verify.edit" [disabled]="!editable() || busy() || !cleanPending()" (click)="acceptClean()">Accept {{ cleanPending() || '' }} clean field{{ cleanPending() === 1 ? '' : 's' }}</button>
                    <span class="spacer"></span>
                    <button class="btn btn-primary" appCan="verify.file" [disabled]="!editable() || busy() || blockers().length > 0" (click)="file()">{{ busy() ? 'Working…' : 'Approve & file to EDRMS' }}</button>
                  </div>
                }
              </div>
            </div>
          }
        } @else {
          <div class="panel muted" style="padding:40px;text-align:center">{{ loading() ? 'Loading…' : list().length ? 'Select a document from the queue.' : 'Nothing to review yet. Upload scans on the Capture screen.' }}</div>
        }
      </section>
    </div>

    @if (rejectDraft() !== null) {
      <div class="dialog-backdrop" (click)="rejectDraft.set(null)">
        <form class="dialog" style="width:min(520px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); reject()">
          <div class="dialog-title">Reject {{ doc()?.ref || doc()?.fileName }}?</div>
          <div class="dialog-body">The document is kept, but will not be filed. Say why, for example: not a land-registry instrument, a duplicate, unreadable.</div>
          <div class="field"><label for="why">Reason (required)</label><textarea id="why" class="input" rows="2" [value]="rejectDraft()" (input)="rejectDraft.set($any($event.target).value)"></textarea></div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="rejectDraft.set(null)">Cancel</button>
            <button type="submit" class="btn btn-danger" [disabled]="busy() || rejectDraft()!.trim().length < 3">Reject</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    .shell { display: grid; grid-template-columns: 300px minmax(0, 1fr); align-items: start; max-width: 1560px; margin: 0 auto; }
    .shell.collapsed { grid-template-columns: 44px minmax(0, 1fr); }
    .rail { border-right: 1px solid var(--color-divider); background: var(--color-surface); display: flex; flex-direction: column; position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); }
    .rail-head { padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--color-divider); }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--color-divider); border-radius: 10px; overflow: hidden; }
    .stats > div { padding: 7px 9px; border-right: 1px solid var(--color-divider); display: flex; flex-direction: column; gap: 3px; }
    .stats > div:last-child { border-right: 0; }
    .stats b { font-family: var(--font-heading); font-weight: 800; font-size: 20px; line-height: 1; }
    .stats span { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--color-neutral-700); }
    .search { position: relative; }
    .search app-icon { position: absolute; left: 10px; top: 10px; color: var(--color-neutral-600); }
    .search .input { padding-left: 32px; min-height: 34px; font-size: 13px; }
    .seg-opt.sm { padding: 5px 9px; font-size: 12px; }
    .rail-list { overflow-y: auto; flex: 1; min-height: 0; }
    .grp { position: sticky; top: 0; z-index: 1; width: 100%; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 10px 14px 9px; background: var(--color-surface-2); border: 0; border-bottom: 1px solid var(--color-divider); cursor: pointer; text-align: left; }
    .chev { font-size: 10px; color: var(--color-neutral-700); transition: transform .15s; }
    .chev.open { transform: rotate(90deg); }
    .qrow { width: 100%; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 14px; border: 0; border-left: 3px solid transparent; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 6%, transparent); background: transparent; cursor: pointer; text-align: left; }
    .qrow:hover { background: var(--color-accent-100); }
    .qrow.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .rail-foot { padding: 8px 14px; border-top: 1px solid var(--color-divider); display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
    .rail-min { border-right: 1px solid var(--color-divider); background: var(--color-surface); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 0; position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); }
    .vert { writing-mode: vertical-rl; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-neutral-700); }
    .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .main { padding: 16px 24px 32px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .doc-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 16px 18px; background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
    .banner { display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-radius: var(--radius-lg); background: var(--warn-bg); border: 1px solid var(--warn-bd); color: var(--warn-fg); flex-wrap: wrap; }
    .banner.quiet { background: var(--color-surface); border-color: var(--color-divider); color: var(--color-text); }
    .banner.ok { background: var(--success-bg); border-color: var(--success); color: var(--color-text); }
    .banner.err { background: var(--danger-bg); border-color: var(--danger-bd); color: var(--danger-fg); }
    .state { padding: 40px; text-align: center; color: var(--color-neutral-700); }
    .review { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 440px); gap: 24px; align-items: start; }
    .sticky { position: sticky; top: calc(var(--topbar-h) + 16px); }
    .scan { height: calc(100vh - var(--topbar-h) - 220px); min-height: 420px; border: 1px solid var(--color-divider); border-radius: var(--radius-lg); background: var(--color-surface-2); overflow: auto; }
    .scan iframe { width: 100%; height: 100%; border: 0; display: block; }
    .scan img { width: 100%; display: block; }
    .transcript summary { cursor: pointer; color: var(--color-neutral-700); }
    .transcript p { white-space: pre-wrap; margin: 8px 0 0; max-height: 220px; overflow-y: auto; }
    .fields { border-top: 1px solid var(--color-divider); max-height: calc(100vh - var(--topbar-h) - 300px); overflow-y: auto; }
    .frow { display: grid; grid-template-columns: minmax(0, 1fr) 40px; gap: 4px 10px; padding: 10px 14px; border-bottom: 1px solid var(--color-divider); border-left: 3px solid transparent; background: var(--color-surface); }
    .frow.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .frow .input { min-height: 32px; padding: 4px 8px; background: transparent; }
    .flag { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-accent-800); }
    .flag.bad { color: var(--danger-fg); }
    .flag.ok { color: var(--success-fg); }
    .detail { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
    .chk { padding-left: 8px; border-left: 2px solid var(--color-divider); color: var(--color-neutral-800); }
    .chk.warn { border-left-color: var(--warn-bd); }
    .chk.err { border-left-color: var(--danger-bd); color: var(--danger-fg); }
    .blockers { margin: 4px 0 0; padding-left: 18px; color: var(--color-neutral-800); }
    textarea.input { resize: vertical; font: inherit; }
    @media (max-width: 1180px) { .review { grid-template-columns: 1fr; } .sticky { position: static; } .fields { max-height: none; } }
    @media (max-width: 900px) { .shell { grid-template-columns: 44px minmax(0, 1fr); } .scan { height: 60vh; } }
  `]
})
export class VerifyComponent {
  private intake = inject(IntakeApi);
  private toast = inject(ToastService);
  private sanitizer = inject(DomSanitizer);
  private route = inject(ActivatedRoute);
  private auth = inject(AuthService);
  private confirm = inject(ConfirmService);
  rbac = inject(RbacService);
  router = inject(Router);

  list = signal<IntakeSummary[]>([]);
  docTypes = signal<IntakeDocType[]>([]);
  docId = signal<string | null>(null);
  doc = signal<IntakeDetail | null>(null);
  active = signal<string | null>(null);
  page = signal(1);
  rawUrl = signal<string | null>(null);
  lockedBy = signal<string | null>(null);
  loading = signal(true);
  busy = signal(false);
  rejectDraft = signal<string | null>(null);
  railOpen = signal(window.innerWidth > 900);
  search = signal('');
  filter = signal<QFilter>('open');
  sortChecks = signal(false);
  collapsed = signal<Record<string, boolean>>({});
  filters: { id: QFilter; label: string }[] = [{ id: 'open', label: 'Open' }, { id: 'filed', label: 'Filed' }, { id: 'all', label: 'All' }];

  private claimed: string | null = null;
  private linkAt = 0;
  private sent = new Map<string, string>();
  private timer: any = null;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; clearTimeout(this.timer); this.releaseClaim(); });
    this.intake.catalogue().then(c => this.docTypes.set(c.docTypes)).catch(() => {});
    const want = this.route.snapshot.queryParamMap.get('doc');
    this.loadList(want);
  }

  // ---------------------------------------------------------------- queue

  visible = computed(() => {
    const q = this.search().toLowerCase().trim(), f = this.filter();
    const v = this.list().filter(d =>
      (f === 'all' || (f === 'filed' ? d.status === 'filed' : OPEN.includes(d.status))) &&
      (!q || [d.ref, d.fileName, d.property, d.batchId, d.docTypeLabel].some(s => (s || '').toLowerCase().includes(q))));
    return this.sortChecks() ? [...v].sort((a, b) => needsChecks(b) - needsChecks(a)) : v;
  });
  groups = computed(() => {
    const byBatch = new Map<string, IntakeSummary[]>();
    for (const d of this.list()) byBatch.set(d.batchId, [...(byBatch.get(d.batchId) || []), d]);
    return [...byBatch.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([id, all]) => {
      const done = all.filter(d => d.status === 'filed' || d.status === 'rejected').length;
      return { id, rows: this.visible().filter(d => d.batchId === id), count: done + '/' + all.length, pct: Math.round(done / all.length * 100) };
    }).filter(g => g.rows.length);
  });
  flat = computed(() => this.groups().flatMap(g => g.rows));
  counts = computed(() => {
    const open = this.list().filter(d => OPEN.includes(d.status));
    return { open: open.length, checks: open.filter(d => d.status === 'ready' && attention(d)).length, filed: this.list().filter(d => d.status === 'filed').length };
  });
  pos = computed(() => this.flat().findIndex(d => d.id === this.docId()));
  posLabel = computed(() => this.pos() >= 0 ? (this.pos() + 1) + ' of ' + this.flat().length + ' in view' : 'not in current filter');

  statusLabel(s: IntakeStatus) { return STATUS_LABEL[s]; }
  sub(d: IntakeSummary) {
    return [d.docTypeLabel || (d.status === 'ready' ? 'Unknown type' : STATUS_LABEL[d.status]), (d.property || '').replace(/,.*/, ''), d.claimedByName].filter(Boolean).join(' · ');
  }
  rowAlert(d: IntakeSummary) { return d.status === 'failed' || (d.status === 'ready' && attention(d)); }
  rowState(d: IntakeSummary) {
    if (d.status !== 'ready') return STATUS_LABEL[d.status];
    if (d.flags.conflict) return d.flags.conflict + ' conflict';
    if (d.reviewed === d.total) return 'Reviewed';
    const n = needsChecks(d);
    return n ? n + ' to check' : 'Clean';
  }

  async loadList(selectId?: string | null) {
    clearTimeout(this.timer);
    try {
      const { items } = await this.intake.documents({ limit: 500 });
      this.list.set(items);
      const target = selectId || this.docId() || this.flat()[0]?.id || null;
      if (target && target !== this.docId()) {
        if (!items.find(d => d.id === target && OPEN.includes(d.status))) this.filter.set('all');
        await this.select(target);
      } else if (target && this.doc() && IN_PROGRESS.includes(this.doc()!.status)) {
        // the open document finished reading: show the result and claim it for review
        const s = items.find(d => d.id === target);
        if (s && s.status !== this.doc()!.status) await this.select(target);
      }
    } catch (e) { this.fail('Could not load the review queue', e); } finally { this.loading.set(false); }
    if (!this.destroyed && this.list().some(d => IN_PROGRESS.includes(d.status))) this.timer = setTimeout(() => this.loadList(), POLL_MS);
  }

  toggle(id: string) { this.collapsed.update(c => ({ ...c, [id]: !c[id] })); }
  move(dir: number) { const t = this.flat()[this.pos() + dir]; if (t) this.select(t.id); }

  // ---------------------------------------------------------------- one document

  editable = computed(() => this.doc()?.status === 'ready' && !this.lockedBy() && this.rbac.can('verify.edit'));
  isPdf = computed(() => this.doc()?.mimeType === 'application/pdf');
  src = computed<SafeResourceUrl | null>(() => {
    const u = this.rawUrl();
    return u ? this.sanitizer.bypassSecurityTrustResourceUrl(this.isPdf() ? `${u}#page=${this.page()}&view=FitH` : u) : null;
  });
  pageText = computed(() => this.doc()?.transcription.find(p => p.page === this.page())?.text || null);
  activeKey = computed(() => { const f = this.doc()?.fields || [], a = this.active(); return f.some(x => x.k === a) ? a : f[0]?.k ?? null; });
  reviewed = computed(() => (this.doc()?.fields || []).filter(f => f.status !== 'pending').length);
  cleanPending = computed(() => (this.doc()?.fields || []).filter(f => f.status === 'pending' && f.flag === 'ok' && f.value).length);
  missingFields = computed(() => {
    const d = this.doc(), t = this.docTypes().find(x => x.id === d?.docType);
    return t && d ? t.fields.filter(x => !d.fields.some(f => f.k === x.k)) : [];
  });
  /** Mirrors the service's filing rules, so the button explains itself; the service decides. */
  blockers = computed(() => {
    const d = this.doc();
    if (!d) return [];
    const out: string[] = [];
    if (!d.docTypeLabel) out.push('The document type is not recognised');
    const pending = d.fields.filter(f => f.status === 'pending');
    if (pending.length) out.push(`${pending.length} field${pending.length === 1 ? '' : 's'} not reviewed yet`);
    const errors = d.fields.filter(f => f.checks.some(c => c.level === 'error'));
    if (errors.length) out.push('Fix before filing: ' + errors.map(f => f.label).join(', '));
    const missing = d.fields.filter(f => f.required && !f.value);
    if (missing.length) out.push('Required: ' + missing.map(f => f.label).join(', '));
    return out;
  });

  async select(id: string) {
    if (id !== this.docId()) {
      await this.releaseClaim();
      this.docId.set(id);
      this.doc.set(null);
      this.active.set(null);
      this.rawUrl.set(null);
      this.lockedBy.set(null);
      this.sent.clear();
      this.router.navigate([], { queryParams: { doc: id }, replaceUrl: true });
    }
    await this.reload();
    const d = this.doc();
    if (!d || d.id !== id) return;
    this.page.set(1);
    await this.loadLink();
    if (d.status === 'ready' && this.rbac.can('verify.edit')) {
      try {
        await this.intake.claim(id);
        this.claimed = id;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) this.lockedBy.set(e.message);
        else this.fail('Could not open the document for review', e);
      }
    } else if (d.claimedById && d.claimedById !== this.auth.me()?.user?.id) {
      this.lockedBy.set(`${d.claimedByName} is reviewing this document`);
    }
  }

  private async reload() {
    const id = this.docId();
    if (!id) return;
    try {
      const d = await this.intake.document(id);
      if (id === this.docId()) { this.doc.set(d); this.patchList(d); }
    } catch (e) { this.fail('Could not open the document', e); }
  }

  /** Keep the queue row in step with the open document without reloading the whole list. */
  private patchList(d: IntakeSummary) {
    this.list.update(l => l.map(x => x.id === d.id ? { ...x, ...pick(d) } : x));
  }

  private async loadLink() {
    const id = this.docId();
    if (!id) return;
    try {
      const { url } = await this.intake.fileLink(id);
      if (id === this.docId()) { this.rawUrl.set(url); this.linkAt = Date.now(); }
    } catch (e) { this.fail('Could not load the scan', e); }
  }

  private async releaseClaim() {
    const id = this.claimed;
    this.claimed = null;
    if (id) await this.intake.release(id).catch(() => {});
  }

  activate(f: IntakeField) {
    this.active.set(f.k);
    const p = f.evidence?.page;
    if (p && p !== this.page() && this.isPdf()) {
      if (Date.now() - this.linkAt > LINK_MAX_AGE_MS) this.loadLink();
      this.page.set(p);
    }
  }

  async openFile() {
    const id = this.docId();
    if (!id) return;
    try {
      const { url } = await this.intake.fileLink(id);
      window.open(url, '_blank', 'noopener');
    } catch (e) { this.fail('Could not open the scan', e); }
  }

  // ---------------------------------------------------------------- review actions

  /** Run a change that returns the updated document; a conflict (changed elsewhere) reloads. */
  private async apply(run: () => Promise<IntakeDetail>, failTitle: string) {
    try {
      const d = await run();
      if (d.id === this.docId()) { this.doc.set(d); this.patchList(d); }
      return true;
    } catch (e) {
      this.fail(failTitle, e);
      if (e instanceof ApiError && e.status === 409) await this.reload();
      return false;
    }
  }

  /** Save a typed value. Change and Enter can both fire for one edit; send each value once. */
  async save(f: IntakeField, value: string) {
    const id = this.docId();
    if (!id || !this.editable()) return;
    const v = value.trim();
    if (v === f.value || this.sent.get(f.k) === v) return;
    this.sent.set(f.k, v);
    await this.apply(() => this.intake.setValue(id, f.k, v), `Could not save ${f.label}`);
  }

  /** Enter: save a changed value, or accept the shown one, then go to the next field. */
  async enter(f: IntakeField, value: string) {
    if (!this.editable()) return;
    const v = value.trim();
    if (v !== f.value) await this.save(f, v);
    else if (f.status === 'pending') await this.apply(() => this.intake.setStatus(this.docId()!, f.k, 'accepted'), `Could not accept ${f.label}`);
    const fields = this.doc()?.fields || [];
    const next = fields[fields.findIndex(x => x.k === f.k) + 1];
    if (next) { this.activate(next); setTimeout(() => (document.getElementById('f-' + next.k) as HTMLInputElement | null)?.focus()); }
  }

  async toggleAccept(f: IntakeField, e: Event) {
    e.stopPropagation();
    if (!this.editable()) return;
    await this.apply(() => this.intake.setStatus(this.docId()!, f.k, f.status === 'pending' ? 'accepted' : 'pending'), `Could not update ${f.label}`);
  }

  async addField(k: string) {
    if (!k || !this.editable()) return;
    const ok = await this.apply(() => this.intake.setStatus(this.docId()!, k, 'pending'), 'Could not add the field');
    if (ok) { this.active.set(k); setTimeout(() => (document.getElementById('f-' + k) as HTMLInputElement | null)?.focus()); }
  }

  async acceptClean() {
    this.busy.set(true);
    await this.apply(() => this.intake.acceptClean(this.docId()!), 'Could not accept the clean fields');
    this.busy.set(false);
  }

  async file() {
    const d = this.doc();
    if (!d) return;
    this.busy.set(true);
    try {
      const res = await this.intake.file(d.id);
      this.claimed = null;
      this.toast.show('success', `Filed as ${res.edrmsNo}`, `${d.ref || d.fileName} is now a sealed document of record.`);
      this.patchList(res);
      const next = this.flat().find(x => x.id !== d.id && x.status === 'ready');
      if (next) await this.select(next.id); else await this.reload();
    } catch (e) {
      const blockers: string[] | undefined = e instanceof ApiError ? e.details?.blockers : undefined;
      this.fail('Could not file the document', e, blockers?.join(' · '));
      await this.reload();
    } finally { this.busy.set(false); }
  }

  async reject() {
    const d = this.doc(), reason = (this.rejectDraft() || '').trim();
    if (!d || reason.length < 3) return;
    this.busy.set(true);
    try {
      const res = await this.intake.reject(d.id, reason);
      this.claimed = null;
      this.rejectDraft.set(null);
      this.toast.show('info', `${d.ref || d.fileName} rejected`);
      this.patchList(res);
      await this.reload();
    } catch (e) { this.fail('Could not reject the document', e); } finally { this.busy.set(false); }
  }

  async reread() {
    const d = this.doc();
    if (d?.reviewed && !(await this.confirm.ask({
      title: 'Read this document again?',
      body: `The stronger model reads it again and its result replaces the current fields, including the ${d.reviewed} you have already reviewed.`,
      confirmLabel: 'Re-read', tone: 'danger'
    }))) return;
    await this.requeue(true);
  }
  async retry() { await this.requeue(false); }

  private async requeue(escalate: boolean) {
    const d = this.doc();
    if (!d) return;
    this.busy.set(true);
    try {
      await this.releaseClaim();
      await this.intake.extract(d.id, escalate);
      this.toast.show('info', escalate ? 'Queued for a second reading' : 'Queued again', 'Reviewed values are replaced by the new reading.');
      await this.reload();
      await this.loadList();
    } catch (e) { this.fail('Could not queue the document', e); } finally { this.busy.set(false); }
  }

  private fail(title: string, e: unknown, extra?: string) {
    const msg = e instanceof ApiError ? e.message : String(e);
    this.toast.show('danger', title, extra ? `${msg}: ${extra}` : msg, 8000);
  }
}

/** A document in review that still needs a person's judgement: a conflict, or unreviewed fields with warnings. */
function attention(d: IntakeSummary) {
  return d.flags.conflict > 0 || (d.reviewed < d.total && needsChecks(d) > 0);
}

/** The summary fields of a document (what the queue rows show). */
function pick(d: IntakeSummary): Partial<IntakeSummary> {
  const { status, docTypeLabel, ref, property, flags, reviewed, total, escalated, extractionError, claimedById, claimedByName, edrmsNo, filedDocumentId, rejectedReason } = d;
  return { status, docTypeLabel, ref, property, flags, reviewed, total, escalated, extractionError, claimedById, claimedByName, edrmsNo, filedDocumentId, rejectedReason };
}
