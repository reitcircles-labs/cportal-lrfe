import {Injectable, computed, inject, signal} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {DomSanitizer, SafeResourceUrl} from '@angular/platform-browser';
import {ApiError} from '../../api/api.service';
import {
  IN_PROGRESS,
  IntakeApi,
  IntakeDetail,
  IntakeDocType,
  IntakeField,
  IntakeStatus,
  IntakeSummary,
  STATUS_LABEL,
  needsChecks,
} from '../../api/intake.api';
import {AuthService} from '../../state/auth.service';
import {RbacService} from '../../state/rbac.service';
import {ToastService} from '../../state/toast.service';
import {ConfirmService} from '../../state/confirm.service';

type QFilter = 'open' | 'filed' | 'all';
const OPEN: IntakeStatus[] = ['queued', 'extracting', 'ready', 'failed'];
const POLL_MS = 5000;
/** Signed file links live 300 s; fetch a new one before a page change after this age. */
const LINK_MAX_AGE_MS = 240_000;

/**
 * The review screen's state and actions: the queue, the open document and its claim. Provided by
 * VerifyComponent, so the queue rail and the document panel share one instance per visit.
 */
@Injectable()
export class VerifyStore {
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
  filters: Array<{id: QFilter; label: string}> = [
    {id: 'open', label: 'Open'},
    {id: 'filed', label: 'Filed'},
    {id: 'all', label: 'All'},
  ];

  private claimed: string | null = null;
  private linkAt = 0;
  private sent = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor() {
    this.intake
      .catalogue()
      .then(c => this.docTypes.set(c.docTypes))
      .catch(() => {});
    const want = this.route.snapshot.queryParamMap.get('doc');
    this.loadList(want);
  }

  /** The screen is closing: stop polling and release the claimed document. */
  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.releaseClaim();
  }

  // ---------------------------------------------------------------- queue

  visible = computed(() => {
    const q = this.search().toLowerCase().trim();
    const f = this.filter();
    const v = this.list().filter(
      d =>
        (f === 'all' ||
          (f === 'filed' ? d.status === 'filed' : OPEN.includes(d.status))) &&
        (!q ||
          [d.ref, d.fileName, d.property, d.batchId, d.docTypeLabel].some(s =>
            (s || '').toLowerCase().includes(q),
          )),
    );
    return this.sortChecks()
      ? [...v].sort((a, b) => needsChecks(b) - needsChecks(a))
      : v;
  });
  groups = computed(() => {
    const byBatch = new Map<string, IntakeSummary[]>();
    for (const d of this.list()) {
      byBatch.set(d.batchId, [...(byBatch.get(d.batchId) || []), d]);
    }
    return [...byBatch.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([id, all]) => {
        const done = all.filter(
          d => d.status === 'filed' || d.status === 'rejected',
        ).length;
        return {
          id,
          rows: this.visible().filter(d => d.batchId === id),
          count: done + '/' + all.length,
          pct: Math.round((done / all.length) * 100),
        };
      })
      .filter(g => g.rows.length);
  });
  flat = computed(() => this.groups().flatMap(g => g.rows));
  counts = computed(() => {
    const open = this.list().filter(d => OPEN.includes(d.status));
    return {
      open: open.length,
      checks: open.filter(d => d.status === 'ready' && attention(d)).length,
      filed: this.list().filter(d => d.status === 'filed').length,
    };
  });
  pos = computed(() => this.flat().findIndex(d => d.id === this.docId()));
  posLabel = computed(() =>
    this.pos() >= 0
      ? this.pos() + 1 + ' of ' + this.flat().length + ' in view'
      : 'not in current filter',
  );

  statusLabel(s: IntakeStatus) {
    return STATUS_LABEL[s];
  }
  sub(d: IntakeSummary) {
    return [
      d.docTypeLabel ||
        (d.status === 'ready' ? 'Unknown type' : STATUS_LABEL[d.status]),
      (d.property || '').replace(/,.*/, ''),
      d.claimedByName,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  rowAlert(d: IntakeSummary) {
    return d.status === 'failed' || (d.status === 'ready' && attention(d));
  }
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
      const {items} = await this.intake.documents({limit: 500});
      this.list.set(items);
      const target = selectId || this.docId() || this.flat()[0]?.id || null;
      if (target && target !== this.docId()) {
        if (!items.find(d => d.id === target && OPEN.includes(d.status))) {
          this.filter.set('all');
        }
        await this.select(target);
      } else if (
        target &&
        this.doc() &&
        IN_PROGRESS.includes(this.doc()!.status)
      ) {
        // the open document finished reading: show the result and claim it for review
        const s = items.find(d => d.id === target);
        if (s && s.status !== this.doc()!.status) await this.select(target);
      }
    } catch (e) {
      this.fail('Could not load the review queue', e);
    } finally {
      this.loading.set(false);
    }
    if (
      !this.destroyed &&
      this.list().some(d => IN_PROGRESS.includes(d.status))
    ) {
      this.timer = setTimeout(() => this.loadList(), POLL_MS);
    }
  }

  toggle(id: string) {
    this.collapsed.update(c => ({...c, [id]: !c[id]}));
  }
  move(dir: number) {
    const t = this.flat()[this.pos() + dir];
    if (t) this.select(t.id);
  }

  // ---------------------------------------------------------------- one document

  editable = computed(
    () =>
      this.doc()?.status === 'ready' &&
      !this.lockedBy() &&
      this.rbac.can('verify.edit'),
  );
  isPdf = computed(() => this.doc()?.mimeType === 'application/pdf');
  src = computed<SafeResourceUrl | null>(() => {
    const u = this.rawUrl();
    return u
      ? this.sanitizer.bypassSecurityTrustResourceUrl(
          this.isPdf() ? `${u}#page=${this.page()}&view=FitH` : u,
        )
      : null;
  });
  pageText = computed(
    () =>
      this.doc()?.transcription.find(p => p.page === this.page())?.text || null,
  );
  activeKey = computed(() => {
    const f = this.doc()?.fields || [];
    const a = this.active();
    return f.some(x => x.k === a) ? a : (f[0]?.k ?? null);
  });
  reviewed = computed(
    () => (this.doc()?.fields || []).filter(f => f.status !== 'pending').length,
  );
  cleanPending = computed(
    () =>
      (this.doc()?.fields || []).filter(
        f => f.status === 'pending' && f.flag === 'ok' && f.value,
      ).length,
  );
  missingFields = computed(() => {
    const d = this.doc();
    const t = this.docTypes().find(x => x.id === d?.docType);
    return t && d ? t.fields.filter(x => !d.fields.some(f => f.k === x.k)) : [];
  });
  /** Mirrors the service's filing rules, so the button explains itself; the service decides. */
  blockers = computed(() => {
    const d = this.doc();
    if (!d) return [];
    const out: string[] = [];
    if (!d.docTypeLabel) out.push('The document type is not recognised');
    const pending = d.fields.filter(f => f.status === 'pending');
    if (pending.length) {
      out.push(
        `${pending.length} field${pending.length === 1 ? '' : 's'} not reviewed yet`,
      );
    }
    const errors = d.fields.filter(f =>
      f.checks.some(c => c.level === 'error'),
    );
    if (errors.length) {
      out.push('Fix before filing: ' + errors.map(f => f.label).join(', '));
    }
    const missing = d.fields.filter(f => f.required && !f.value);
    if (missing.length) {
      out.push('Required: ' + missing.map(f => f.label).join(', '));
    }
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
      this.router.navigate([], {queryParams: {doc: id}, replaceUrl: true});
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
        if (e instanceof ApiError && e.status === 409) {
          this.lockedBy.set(e.message);
        } else this.fail('Could not open the document for review', e);
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
      if (id === this.docId()) {
        this.doc.set(d);
        this.patchList(d);
      }
    } catch (e) {
      this.fail('Could not open the document', e);
    }
  }

  /** Keep the queue row in step with the open document without reloading the whole list. */
  private patchList(d: IntakeSummary) {
    this.list.update(l => l.map(x => (x.id === d.id ? {...x, ...pick(d)} : x)));
  }

  private async loadLink() {
    const id = this.docId();
    if (!id) return;
    try {
      const {url} = await this.intake.fileLink(id);
      if (id === this.docId()) {
        this.rawUrl.set(url);
        this.linkAt = Date.now();
      }
    } catch (e) {
      this.fail('Could not load the scan', e);
    }
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
      const {url} = await this.intake.fileLink(id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      this.fail('Could not open the scan', e);
    }
  }

  // ---------------------------------------------------------------- review actions

  /** Run a change that returns the updated document; a conflict (changed elsewhere) reloads. */
  private async apply(run: () => Promise<IntakeDetail>, failTitle: string) {
    try {
      const d = await run();
      if (d.id === this.docId()) {
        this.doc.set(d);
        this.patchList(d);
      }
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
    await this.apply(
      () => this.intake.setValue(id, f.k, v),
      `Could not save ${f.label}`,
    );
  }

  /** Enter: save a changed value, or accept the shown one, then go to the next field. */
  async enter(f: IntakeField, value: string) {
    if (!this.editable()) return;
    const v = value.trim();
    if (v !== f.value) await this.save(f, v);
    else if (f.status === 'pending') {
      await this.apply(
        () => this.intake.setStatus(this.docId()!, f.k, 'accepted'),
        `Could not accept ${f.label}`,
      );
    }
    const fields = this.doc()?.fields || [];
    const next = fields[fields.findIndex(x => x.k === f.k) + 1];
    if (next) {
      this.activate(next);
      setTimeout(() =>
        (
          document.getElementById('f-' + next.k) as HTMLInputElement | null
        )?.focus(),
      );
    }
  }

  async toggleAccept(f: IntakeField, e: Event) {
    e.stopPropagation();
    if (!this.editable()) return;
    await this.apply(
      () =>
        this.intake.setStatus(
          this.docId()!,
          f.k,
          f.status === 'pending' ? 'accepted' : 'pending',
        ),
      `Could not update ${f.label}`,
    );
  }

  async addField(k: string) {
    if (!k || !this.editable()) return;
    const ok = await this.apply(
      () => this.intake.setStatus(this.docId()!, k, 'pending'),
      'Could not add the field',
    );
    if (ok) {
      this.active.set(k);
      setTimeout(() =>
        (document.getElementById('f-' + k) as HTMLInputElement | null)?.focus(),
      );
    }
  }

  async acceptClean() {
    this.busy.set(true);
    await this.apply(
      () => this.intake.acceptClean(this.docId()!),
      'Could not accept the clean fields',
    );
    this.busy.set(false);
  }

  async file() {
    const d = this.doc();
    if (!d) return;
    this.busy.set(true);
    try {
      const res = await this.intake.file(d.id);
      this.claimed = null;
      this.toast.show(
        'success',
        `Filed as ${res.edrmsNo}`,
        `${d.ref || d.fileName} is now a sealed document of record.`,
      );
      this.patchList(res);
      const next = this.flat().find(x => x.id !== d.id && x.status === 'ready');
      if (next) await this.select(next.id);
      else await this.reload();
    } catch (e) {
      const blockers: string[] | undefined =
        e instanceof ApiError ? e.details?.blockers : undefined;
      this.fail('Could not file the document', e, blockers?.join(' · '));
      await this.reload();
    } finally {
      this.busy.set(false);
    }
  }

  async reject() {
    const d = this.doc();
    const reason = (this.rejectDraft() || '').trim();
    if (!d || reason.length < 3) return;
    this.busy.set(true);
    try {
      const res = await this.intake.reject(d.id, reason);
      this.claimed = null;
      this.rejectDraft.set(null);
      this.toast.show('info', `${d.ref || d.fileName} rejected`);
      this.patchList(res);
      await this.reload();
    } catch (e) {
      this.fail('Could not reject the document', e);
    } finally {
      this.busy.set(false);
    }
  }

  async reread() {
    const d = this.doc();
    if (
      d?.reviewed &&
      !(await this.confirm.ask({
        title: 'Read this document again?',
        body: `The stronger model reads it again and its result replaces the current fields, including the ${d.reviewed} you have already reviewed.`,
        confirmLabel: 'Re-read',
        tone: 'danger',
      }))
    ) {
      return;
    }
    await this.requeue(true);
  }
  async retry() {
    await this.requeue(false);
  }

  private async requeue(escalate: boolean) {
    const d = this.doc();
    if (!d) return;
    this.busy.set(true);
    try {
      await this.releaseClaim();
      await this.intake.extract(d.id, escalate);
      this.toast.show(
        'info',
        escalate ? 'Queued for a second reading' : 'Queued again',
        'Reviewed values are replaced by the new reading.',
      );
      await this.reload();
      await this.loadList();
    } catch (e) {
      this.fail('Could not queue the document', e);
    } finally {
      this.busy.set(false);
    }
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
  const {
    status,
    docTypeLabel,
    ref,
    property,
    flags,
    reviewed,
    total,
    escalated,
    extractionError,
    claimedById,
    claimedByName,
    edrmsNo,
    filedDocumentId,
    rejectedReason,
  } = d;
  return {
    status,
    docTypeLabel,
    ref,
    property,
    flags,
    reviewed,
    total,
    escalated,
    extractionError,
    claimedById,
    claimedByName,
    edrmsNo,
    filedDocumentId,
    rejectedReason,
  };
}
