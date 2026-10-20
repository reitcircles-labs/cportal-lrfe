import {Injectable, computed, inject, signal} from '@angular/core';
import {ApiError} from '../../api/api.service';
import {
  Check,
  Comment,
  Encumbrance,
  Flag,
  FoundDocument,
  History,
  LandRecord,
  Owner,
  ParcelKind,
  PinnedDocument,
  RecordSummary,
  RecordsApi,
  Review,
} from '../../api/records.api';
import {ToastService} from '../../state/toast.service';
import {AuthService} from '../../state/auth.service';
import {TasksService} from '../../state/tasks.service';
import {RbacService, fmtTime} from '../../state/rbac.service';
import {anchoringLabel, anchoringTag} from '../../shared/anchoring';
import {DiscussionVersion, discussionEvents} from './discussion';
import {matches} from './link-format';

export type Tab =
  'documents' | 'chain' | 'details' | 'history' | 'discussion' | 'review';
export type DFilter = 'all' | 'comments' | 'decisions';
export type SFilter =
  | 'all'
  | 'draft'
  | 'in_review'
  | 'committed'
  | 'needs_review'
  | 'new_document'
  | 'in_bin';

/**
 * The land record page's shared state: the list, the open record and its tabs, and the actions
 * several parts use (open a record, run a change, load the documents found, the discussion, the
 * review and the history). Each part's own actions are in its helper (LinkDetailsForm,
 * LinkOwnersEditor, LinkCreateFlow, LinkDocumentsSearch, LinkDiscussion, LinkReviewFlow,
 * LinkLifecycle). Provided by LinkComponent with them, so the page's parts share one instance
 * per visit. act, fail, debounce, show, reload and refreshReview are public for those helpers;
 * templates call the helpers instead.
 */
@Injectable()
export class LinkStore {
  private records$ = inject(RecordsApi);
  rbac = inject(RbacService);
  auth = inject(AuthService);
  private toast = inject(ToastService);
  private tasks = inject(TasksService);

  records = signal<RecordSummary[]>([]);
  loading = signal(true);
  q = signal('');
  sf = signal<SFilter>('all');
  selId = signal<string | null>(null);
  rec = signal<LandRecord | null>(null);
  tab = signal<Tab>('documents');
  listOpen = signal(true);
  busy = signal(false);
  docTypes = signal<Array<{id: string; label: string}>>([]);
  // adding documents
  addOpen = signal(true);
  mode = signal<'match' | 'search'>('match');
  dq = signal('');
  found = signal<FoundDocument[]>([]);
  finding = signal(false);
  // discussion: comments, and the decisions in each version's change log
  comments = signal<Comment[]>([]);
  versions = signal<DiscussionVersion[]>([]);
  dfilter = signal<DFilter>('all');
  // review & approve
  review = signal<Review | null>(null);
  reviewFailed = signal(false);
  decisionText = signal('');
  decisionError = signal('');
  checkingTasks = signal(false);
  history = signal<History | null>(null);
  historyFailed = signal(false);
  draftText = signal('');
  // details form
  df = signal<{
    tenure: string;
    extent: string;
    unit: string;
    reason: string;
    encumbrances: Encumbrance[];
    attributes: Array<{k: string; v: string; orig?: unknown}>;
  }>({
    tenure: '',
    extent: '',
    unit: 'm2',
    reason: '',
    encumbrances: [],
    attributes: [],
  });
  // owners dialog
  ownerForm = signal<{owners: Owner[]; reason: string} | null>(null);
  // dismissing a "new document" flag (API-766)
  dismissing = signal<Flag | null>(null);
  dismissReason = signal('');
  // the bin (API-767): moving the record there, or discarding its open draft
  binning = signal<'record' | 'draft' | null>(null);
  binReason = signal('');
  // create dialog (its own state is in LinkCreateFlow); the kind of parcel is kept between openings
  createOpen = signal(false);
  kinds = signal<ParcelKind[]>([]);
  ckind = signal('erf');

  private timers: Record<string, ReturnType<typeof setTimeout>> = {};
  fmt = fmtTime;
  anchoringLabel = anchoringLabel;
  anchoringTag = anchoringTag;

  // ---------------------------------------------------------------- derived state

  shown = computed(() => {
    const r = this.rec();
    return r ? (r.draft ?? r.current) : null;
  });
  shownKey = computed(() => {
    const v = this.shown();
    return v ? `${v.recordId}:${v.versionNumber}:${v.state}` : '';
  });
  data = computed(() => this.shown()?.data ?? null);
  editable = computed(() => {
    const r = this.rec();
    return !!r?.draft && r.draft.state === 'draft' && !r.inBin;
  });
  docs = computed<PinnedDocument[]>(() => this.data()?.documents ?? []);
  owners = computed<Owner[]>(() => this.data()?.owners ?? []);
  chain = computed(() => this.shown()?.derived?.chain ?? []);
  checks = computed<Check[]>(() => this.shown()?.checks ?? []);
  required = computed(() => this.checks().filter(c => c.level === 'error'));
  failing = computed(() => this.required().filter(c => !c.ok));
  passing = computed(() => this.required().filter(c => c.ok).length);
  isSubmitter = computed(
    () => this.rec()?.draft?.submittedById === this.auth.me()?.user.id,
  );
  events = computed(() => discussionEvents(this.versions(), this.comments()));
  /** The approval task of the version in review, when it is among the signed-in user's tasks. */
  myTask = computed(() => {
    const id =
      this.rec()?.draftState === 'in_review'
        ? this.rec()?.draft?.reviewInstanceId
        : null;
    return id
      ? (this.tasks.tasks().find(t => t.instanceId === id) ?? null)
      : null;
  });
  versionLabel = computed(() => {
    const r = this.rec();
    if (!r) return '';
    if (r.draft) {
      return `${r.draft.state === 'in_review' ? 'Version' : 'Draft version'} ${r.draft.versionNumber}${r.current ? ' · current is version ' + r.current.versionNumber : ''}`;
    }
    return `Version ${r.currentVersion}`;
  });

  filters = computed(() => {
    const rows = this.records();
    const n = (f: SFilter) => rows.filter(r => matches(r, f)).length;
    return [
      {id: 'all' as SFilter, label: 'All', n: n('all')},
      {id: 'draft' as SFilter, label: 'Draft', n: n('draft')},
      {id: 'in_review' as SFilter, label: 'In review', n: n('in_review')},
      {id: 'committed' as SFilter, label: 'Committed', n: n('committed')},
      {
        id: 'needs_review' as SFilter,
        label: 'Needs review',
        n: n('needs_review'),
      },
      {
        id: 'new_document' as SFilter,
        label: 'New document',
        n: n('new_document'),
      },
      {id: 'in_bin' as SFilter, label: 'In the bin', n: n('in_bin')},
    ];
  });
  visible = computed(() => this.records().filter(r => matches(r, this.sf())));

  typeLabel(id: string) {
    return (
      this.docTypes().find(t => t.id === id)?.label || id.replace(/_/g, ' ')
    );
  }

  async loadList() {
    try {
      // the bin is listed apart (API-767); its records show under "In the bin" only
      const q = this.q().trim() || undefined;
      const [{items}, bin] = await Promise.all([
        this.records$.list(q),
        this.records$.list(q, 'in_bin'),
      ]);
      this.records.set([...items, ...bin.items]);
      if (!this.selId() && items.length) this.select(items[0].id);
    } catch (e) {
      this.fail('Could not load land records', e);
    } finally {
      this.loading.set(false);
    }
  }
  search(v: string) {
    this.q.set(v);
    this.debounce('list', () => this.loadList());
  }

  async select(id: string, tab: Tab = 'documents') {
    this.selId.set(id);
    this.tab.set('documents');
    this.dq.set('');
    this.draftText.set('');
    this.comments.set([]);
    this.versions.set([]);
    this.history.set(null);
    this.review.set(null);
    this.decisionText.set('');
    this.decisionError.set('');
    try {
      const r = await this.records$.get(id);
      if (this.selId() !== id) return; // another record was picked meanwhile
      this.rec.set(r);
      this.loadFound();
      this.loadDiscussion();
      if (tab === 'review') this.openReview();
    } catch (e) {
      this.fail('Could not open the land record', e);
    }
  }
  /** The record changed (an action, or someone else): show it, and its row in the list. */
  show(r: LandRecord) {
    this.rec.set(r);
    const {current, draft, draftDiff, ...summary} = r;
    this.records.update(list =>
      list.some(x => x.id === r.id)
        ? list.map(x => (x.id === r.id ? summary : x))
        : [summary, ...list],
    );
  }
  async reload() {
    const id = this.selId();
    if (id) this.show(await this.records$.get(id));
  }

  /** Run a change; a stale revision reloads the record, other errors are shown. */
  async act(fn: (r: LandRecord) => Promise<LandRecord>, done?: string) {
    const r = this.rec();
    if (!r || this.busy()) return null;
    this.busy.set(true);
    try {
      const updated = await fn(r);
      this.show(updated);
      if (done) this.toast.show('success', done);
      return updated;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await this.reload().catch(() => {});
      }
      this.fail(
        e instanceof ApiError && e.status === 409
          ? 'Not saved'
          : 'Could not save',
        e,
      );
      return null;
    } finally {
      this.busy.set(false);
    }
  }
  fail(title: string, e: unknown) {
    const err = e instanceof ApiError ? e : null;
    const list = err?.details?.problems?.length
      ? ' ' + err.details.problems.join('; ')
      : '';
    this.toast.show('danger', title, (err?.message || String(e)) + list, 7000);
  }
  debounce(key: string, fn: () => void, ms = 250) {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(fn, ms);
  }

  // ---------------------------------------------------------------- documents

  async loadFound() {
    const r = this.rec();
    if (!r || !this.editable()) {
      this.found.set([]);
      return;
    }
    this.finding.set(true);
    try {
      if (this.mode() === 'match') {
        this.found.set((await this.records$.suggestions(r.id)).items);
      } else {
        this.found.set(
          this.dq().trim()
            ? (await this.records$.searchDocuments(this.dq().trim(), r.id))
                .items
            : [],
        );
      }
    } catch (e) {
      this.found.set([]);
      this.fail('Could not search the EDRMS', e);
    } finally {
      this.finding.set(false);
    }
  }

  async accept(field: 'owners' | 'extent') {
    const done = await this.act(
      r =>
        this.records$.edit(r.id, {
          revision: r.draft!.revision,
          accept: [field],
        }),
      field === 'owners'
        ? 'Owners taken from the documents'
        : 'Extent taken from the documents',
    );
    if (done && field === 'extent') {
      this.df.update(f => ({
        ...f,
        extent: String(done.draft?.data.extent?.value ?? ''),
        unit: done.draft?.data.extent?.unit ?? 'm2',
        reason: '',
      }));
    }
  }

  resetDetails() {
    const d = this.data();
    this.df.set({
      tenure: d?.tenure ?? '',
      extent: d?.extent ? String(d.extent.value) : '',
      unit: d?.extent?.unit ?? 'm2',
      reason: '',
      encumbrances: structuredClone(d?.encumbrances ?? []),
      attributes: Object.entries(d?.attributes ?? {}).map(([k, v]) => ({
        k,
        v: typeof v === 'string' ? v : JSON.stringify(v),
        orig: v,
      })),
    });
  }

  async loadHistory() {
    const id = this.selId();
    if (!id) return;
    this.historyFailed.set(false);
    try {
      const h = await this.records$.history(id);
      if (this.selId() === id) this.history.set(h);
    } catch (e) {
      if (this.selId() === id) this.historyFailed.set(true);
      this.fail('Could not load the history', e);
    }
  }

  // ---------------------------------------------------------------- comments

  async loadDiscussion() {
    const id = this.selId();
    if (!id) return;
    const [comments, versions] = await Promise.allSettled([
      this.records$.comments(id),
      this.records$.versions(id),
    ]);
    if (this.selId() !== id) return;
    // either part missing is shown as empty
    if (comments.status === 'fulfilled') {
      this.comments.set(comments.value.items);
    }
    if (versions.status === 'fulfilled') this.versions.set(versions.value);
  }

  /** The Review & approve tab, for whoever may finalize records; anyone else stays on the tab they are on. */
  async openReview() {
    if (!this.rbac.can('record.finalize')) return;
    this.tab.set('review');
    this.loadReview();
    this.checkingTasks.set(true);
    try {
      await this.tasks.refresh();
    } finally {
      this.checkingTasks.set(false);
    }
  }
  /** After the record changed state (submitted, withdrawn, decided): the review shown is that of the new state. */
  refreshReview() {
    this.review.set(null);
    if (this.tab() === 'review') this.loadReview();
  }
  private async loadReview() {
    const id = this.selId();
    if (!id || this.rec()?.draftState !== 'in_review') return;
    this.reviewFailed.set(false);
    try {
      const rv = await this.records$.review(id);
      if (this.selId() === id) this.review.set(rv);
    } catch (e) {
      if (this.selId() === id) this.reviewFailed.set(true);
      this.fail('Could not load the review', e);
    }
  }
}
