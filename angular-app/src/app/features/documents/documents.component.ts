import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {ApiError, ApiService} from '../../api/api.service';
import {AuthService} from '../../state/auth.service';
import {RbacService, fmtTime} from '../../state/rbac.service';
import {ToastService} from '../../state/toast.service';
import {ConfirmService} from '../../state/confirm.service';
import {TasksService} from '../../state/tasks.service';
import {IconComponent} from '../../shared/icon.component';
import {CanDirective} from '../../shared/can.directive';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {VERIFY_TIPS} from '../audit/verify-wording';
import {DocumentFieldsPanelComponent} from './document-fields-panel.component';
import {DocumentRecordMetaPanelComponent} from './document-record-meta-panel.component';
import {DocumentVersionsPanelComponent} from './document-versions-panel.component';
import {DocDetail, DocRow} from './documents.types';

interface OpenChange {
  id: string;
  status: 'active' | 'error';
  startedById: string;
  startedByName: string;
  startedAt: string;
  errorMessage: string | null;
}

/** The fields of an edrms integrity check (verifyVersion) that this screen shows. */
interface IntegrityCheck {
  version: number;
  intact: boolean;
  contentIntact: boolean;
  sealIntact: boolean;
  checkedAt: string;
}

/**
 * #/documents — the EDRMS: filed documents of record (edrms service). Read-only except for
 * "Request correction", which starts the four-eyes document-amendment process (bpm).
 */
@Component({
  selector: 'app-documents',
  imports: [
    IconComponent,
    CanDirective,
    InfoTipComponent,
    DocumentFieldsPanelComponent,
    DocumentVersionsPanelComponent,
    DocumentRecordMetaPanelComponent,
  ],
  template: `
    <div class="shell">
      <aside class="rail">
        <div class="rail-head">
          <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="EDRMS no., deed no., erf, owner" [value]="q()" (input)="onSearch($any($event.target).value)" aria-label="Search documents"></div>
          <select class="input" (change)="type.set($any($event.target).value); load()" aria-label="Document type">
            <option value="" [selected]="!type()">All document types</option>
            @for (t of docTypes(); track t.id) { <option [value]="t.id" [selected]="t.id === type()">{{ t.label }}</option> }
          </select>
        </div>
        <div class="rail-list">
          @for (d of rows(); track d.id) {
            <button class="drow" [class.on]="d.id === sel()?.id" (click)="select(d.id)">
              <span class="stack" style="gap:1px;min-width:0">
                <span class="h-cond num" style="font-size:15px">{{ d.instrumentRef || d.edrmsNo }}</span>
                <span class="small muted ellipsis">{{ d.edrmsNo }} · {{ d.props['property'] || d.title }}</span>
              </span>
              <span class="small muted num">v{{ d.currentVersion }}.0</span>
            </button>
          } @empty { <div class="small muted" style="padding:28px 16px;text-align:center">{{ loading() ? 'Loading…' : 'No documents found.' }}</div> }
        </div>
        <div class="rail-foot small muted">{{ rows().length }} of {{ total() }} documents</div>
      </aside>

      <section class="main">
        @if (sel(); as d) {
          <header class="doc-head">
            <div class="stack" style="gap:2px;min-width:0;margin-right:auto">
              <span class="card-kicker">{{ d.edrmsNo }} · {{ typeLabel(d.docType) }} · {{ d.registry }}{{ d.batchId ? ' · batch ' + d.batchId : '' }}</span>
              <span class="row" style="gap:10px;align-items:baseline"><span class="h-cond" style="font-size:28px;line-height:1.05">{{ d.instrumentRef || d.title }}</span><span class="small muted">{{ d.title }} · {{ d.pages }} page{{ d.pages === 1 ? '' : 's' }} · v{{ d.currentVersion }}.0</span></span>
            </div>
            <button class="btn btn-secondary" (click)="openFile(d)"><app-icon name="eye" [size]="15" />Open file</button>
            @if (rbac.can('audit.view')) { <span class="row" style="gap:0;align-items:center"><button class="btn btn-secondary" (click)="verify(d)"><app-icon name="shield" [size]="15" />Check integrity</button><app-info-tip label="check integrity" align="right" [text]="verifyTips.integrity" /></span> }
            <button class="btn btn-primary" appCan="verify.edit" [disabled]="!!openChange()" (click)="startCorrection(d)">Request correction</button>
          </header>

          @if (openChange(); as c) {
            <div class="banner" [class.err]="c.status === 'error'">
              <app-icon [name]="c.status === 'error' ? 'alert' : 'clock'" [size]="18" />
              <span class="stack" style="gap:2px">
                @if (c.status === 'active') { <b>Correction awaiting approval</b><span class="small">Requested by {{ c.startedByName }} · {{ fmt(c.startedAt) }}. A second person who can file documents must approve it.</span> }
                @else { <b>An approved correction could not be applied</b><span class="small">{{ c.errorMessage }}</span> }
              </span>
              <span class="spacer"></span>
              @if (c.startedById === auth.me()?.user?.id || rbac.can('verify.file')) { <button class="btn btn-secondary" (click)="withdraw(c)">{{ c.status === 'error' ? 'Close request' : 'Withdraw' }}</button> }
            </div>
          }

          @if (integrity(); as i) {
            <div class="banner" [class.ok]="i.intact" [class.err]="!i.intact">
              <app-icon [name]="i.intact ? 'checkCircle' : 'alert'" [size]="18" />
              <span class="stack" style="gap:2px"><b>{{ i.intact ? 'Integrity verified' : 'Integrity check FAILED' }} · version {{ i.version }}.0</b>
                <span class="small mono">content {{ i.contentIntact ? 'matches' : 'DOES NOT MATCH' }} its SHA-256 · seal {{ i.sealIntact ? 'intact' : 'BROKEN' }} · checked {{ fmt(i.checkedAt) }}</span></span>
            </div>
          }

          <div class="auto-grid">
            <app-document-fields-panel [doc]="d" />

            <section class="stack" style="gap:16px;min-width:0">
              <app-document-versions-panel [doc]="d" />
              <app-document-record-meta-panel [doc]="d" />
            </section>
          </div>
        } @else {
          <div class="panel muted" style="padding:40px;text-align:center">{{ loading() ? 'Loading…' : 'Select a document.' }}</div>
        }
      </section>
    </div>

    @if (draft(); as dr) {
      <div class="dialog-backdrop" (click)="draft.set(null)">
        <form class="dialog" style="width:min(640px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); submitCorrection()">
          <div class="dialog-title">Request a correction · {{ sel()?.edrmsNo }}</div>
          <div class="dialog-body">Change the values that are wrong. A different person who can file documents must approve before the record changes; the approved change becomes version {{ (sel()?.currentVersion || 0) + 1 }}.0 and the current version is kept.</div>
          <div class="fields">
            @for (f of sel()!.fields; track f.k) {
              <label class="fl" [class.changed]="dr.values[f.k] !== f.v"><span class="small muted">{{ f.label }}</span>
                <input class="input" [value]="dr.values[f.k]" (input)="setValue(f.k, $any($event.target).value)"></label>
            }
          </div>
          <div class="field"><label for="why">Reason (required)</label><textarea id="why" class="input" rows="2" [value]="dr.reason" (input)="setReason($any($event.target).value)" placeholder="e.g. Transferee 2 ID hand-corrected on the original"></textarea></div>
          @if (error()) { <div class="errbox" role="alert">{{ error() }}</div> }
          <div class="dialog-actions">
            <span class="small muted" style="margin-right:auto">{{ changedCount() }} field{{ changedCount() === 1 ? '' : 's' }} changed</span>
            <button type="button" class="btn btn-secondary" (click)="draft.set(null)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy() || !changedCount() || dr.reason.trim().length < 5">{{ busy() ? 'Sending…' : 'Send for approval' }}</button>
          </div>
        </form>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    .shell { display: grid; grid-template-columns: 320px minmax(0, 1fr); align-items: start; max-width: 1560px; margin: 0 auto; }
    .rail { border-right: 1px solid var(--color-divider); background: var(--color-surface); display: flex; flex-direction: column; position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); }
    .rail-head { padding: 14px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--color-divider); }
    .search { position: relative; }
    .search app-icon { position: absolute; left: 10px; top: 11px; color: var(--color-neutral-600); }
    .search .input { padding-left: 32px; }
    .rail-list { overflow-y: auto; flex: 1; min-height: 0; }
    .drow { width: 100%; display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 10px 14px; border: 0; border-left: 3px solid transparent; border-bottom: 1px solid var(--color-divider); background: transparent; cursor: pointer; text-align: left; }
    .drow:hover { background: var(--color-accent-100); }
    .drow.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .rail-foot { padding: 8px 14px; border-top: 1px solid var(--color-divider); }
    .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .main { padding: 16px 24px 32px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .doc-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 16px 18px; background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
    .banner { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-radius: var(--radius-lg); background: var(--color-accent-100); border: 1px solid var(--color-accent-300); flex-wrap: wrap; }
    .banner.ok { background: var(--success-bg); border-color: var(--success); }
    .banner.err { background: var(--danger-bg); border-color: var(--danger-bd); color: var(--danger-fg); }
    .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; max-height: 46vh; overflow-y: auto; margin: 10px 0; }
    .fl { display: flex; flex-direction: column; gap: 3px; }
    .fl.changed .input { border-color: var(--color-accent); background: var(--color-accent-100); }
    .errbox { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); font-size: 13.5px; }
    textarea.input { resize: vertical; font: inherit; }
    @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } .rail { position: static; height: 50vh; } .fields { grid-template-columns: 1fr; } }
  `,
  ],
})
export class DocumentsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private tasks = inject(TasksService);
  private router = inject(Router);
  auth = inject(AuthService);
  rbac = inject(RbacService);

  q = signal('');
  type = signal('');
  rows = signal<DocRow[]>([]);
  total = signal(0);
  loading = signal(false);
  docTypes = signal<Array<{id: string; label: string}>>([]);
  sel = signal<DocDetail | null>(null);
  openChange = signal<OpenChange | null>(null);
  integrity = signal<IntegrityCheck | null>(null);
  draft = signal<{values: Record<string, string>; reason: string} | null>(null);
  busy = signal(false);
  error = signal('');
  private searchTimer: ReturnType<typeof setTimeout>;

  fmt = fmtTime;
  protected readonly verifyTips = VERIFY_TIPS;
  changedCount = computed(() => {
    const d = this.draft();
    const s = this.sel();
    return d && s ? s.fields.filter(f => d.values[f.k] !== f.v).length : 0;
  });

  constructor() {
    this.api
      .get<{docTypes: Array<{id: string; label: string}>}>(
        '/document-catalogue',
      )
      .then(c => this.docTypes.set(c.docTypes))
      .catch(() => {});
    const id = inject(ActivatedRoute).snapshot.queryParamMap.get('id');
    this.load(id);
  }

  typeLabel(id: string) {
    return this.docTypes().find(t => t.id === id)?.label || id;
  }

  onSearch(v: string) {
    this.q.set(v);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(), 250);
  }

  async load(selectId?: string | null) {
    this.loading.set(true);
    try {
      const res = await this.api.get<{items: DocRow[]; total: number}>(
        '/documents',
        {q: this.q().trim(), docType: this.type(), limit: 100},
      );
      this.rows.set(res.items);
      this.total.set(res.total);
      const target = selectId || this.sel()?.id || res.items[0]?.id;
      if (target) await this.select(target);
      else this.sel.set(null);
    } catch (e) {
      this.fail('Could not load documents', e);
    } finally {
      this.loading.set(false);
    }
  }

  async select(id: string) {
    try {
      const [doc, active, failed] = await Promise.all([
        this.api.get<DocDetail>(`/documents/${id}`),
        this.api.get<{items: OpenChange[]}>('/process-instances', {
          definitionKey: 'document-amendment',
          businessKey: id,
          status: 'active',
        }),
        this.api.get<{items: OpenChange[]}>('/process-instances', {
          definitionKey: 'document-amendment',
          businessKey: id,
          status: 'error',
        }),
      ]);
      this.sel.set(doc);
      this.openChange.set(active.items[0] || failed.items[0] || null);
      this.integrity.set(null);
      this.router.navigate([], {queryParams: {id}, replaceUrl: true});
    } catch (e) {
      this.fail('Could not open the document', e);
    }
  }

  async openFile(d: DocDetail) {
    try {
      const link = await this.api.get<{url: string}>(
        `/documents/${d.id}/content`,
      );
      window.open(link.url, '_blank', 'noopener');
    } catch (e) {
      this.fail('Could not open the file', e);
    }
  }

  async verify(d: DocDetail) {
    try {
      this.integrity.set(
        await this.api.get<IntegrityCheck>(
          `/documents/${d.id}/versions/${d.currentVersion}/verify`,
        ),
      );
    } catch (e) {
      this.fail('Integrity check failed to run', e);
    }
  }

  startCorrection(d: DocDetail) {
    this.error.set('');
    this.draft.set({
      values: Object.fromEntries(d.fields.map(f => [f.k, f.v])),
      reason: '',
    });
  }
  setValue(k: string, v: string) {
    this.draft.update(d => d && {...d, values: {...d.values, [k]: v}});
  }
  setReason(v: string) {
    this.draft.update(d => d && {...d, reason: v});
  }

  async submitCorrection() {
    const d = this.sel()!;
    const dr = this.draft()!;
    const changes = d.fields
      .filter(f => dr.values[f.k] !== f.v)
      .map(f => ({k: f.k, v: dr.values[f.k]}));
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post('/processes/document-amendment/instances', {
        variables: {
          documentId: d.id,
          expectedVersion: d.currentVersion,
          reason: dr.reason.trim(),
          changes,
        },
      });
      this.draft.set(null);
      this.toast.show(
        'success',
        'Correction sent for approval',
        `${changes.length} field(s) on ${d.edrmsNo}. The record changes once a second person approves.`,
      );
      await this.select(d.id);
      this.tasks.refresh();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async withdraw(c: OpenChange) {
    const ok = await this.confirm.ask({
      title:
        c.status === 'error'
          ? 'Close this correction request?'
          : 'Withdraw the correction request?',
      body: 'The document is not changed. You can request a new correction afterwards.',
      confirmLabel: c.status === 'error' ? 'Close request' : 'Withdraw',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.post(`/process-instances/${c.id}/cancel`, {
        reason: 'Withdrawn from the Documents screen',
      });
      this.toast.show('info', 'Correction request withdrawn');
      await this.select(this.sel()!.id);
      this.tasks.refresh();
    } catch (e) {
      this.fail('Could not withdraw the request', e);
    }
  }

  private fail(title: string, e: unknown) {
    this.toast.show(
      'danger',
      title,
      e instanceof ApiError ? e.message : String(e),
      7000,
    );
  }
}
