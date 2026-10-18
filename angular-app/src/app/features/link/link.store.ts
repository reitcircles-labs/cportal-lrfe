import {Injectable, computed, inject, signal} from '@angular/core';
import {Router} from '@angular/router';
import {ApiError} from '../../api/api.service';
import {
  Check,
  Comment,
  Encumbrance,
  FoundDocument,
  History,
  LandRecord,
  Owner,
  Parcel,
  ParcelKind,
  PinnedDocument,
  RecordSummary,
  RecordsApi,
  Review,
} from '../../api/records.api';
import {ConfirmService} from '../../state/confirm.service';
import {ToastService} from '../../state/toast.service';
import {AuthService} from '../../state/auth.service';
import {TasksService} from '../../state/tasks.service';
import {RbacService, fmtTime} from '../../state/rbac.service';
import {anchoringLabel, anchoringTag} from '../../shared/anchoring';
import {
  EncumbranceOffer,
  encumbranceKey,
  encumbranceOffer,
} from './encumbrance-suggestion';
import {
  DiscussionEvent,
  DiscussionVersion,
  discussionEvents,
  groupByVersion,
  isDecision,
} from './discussion';

type Tab =
  'documents' | 'chain' | 'details' | 'history' | 'discussion' | 'review';
type DFilter = 'all' | 'comments' | 'decisions';
type SFilter = 'all' | 'draft' | 'in_review' | 'committed' | 'needs_review';

const PARCEL_LABELS: Record<string, string> = {
  number: 'Erf number',
  portion: 'Portion',
  township: 'Township',
  regDiv: 'Registration division',
  region: 'Region',
  farmName: 'Farm name',
  farmNumber: 'Farm number',
  schemeName: 'Scheme name',
  schemeNumber: 'Scheme number',
  unit: 'Unit',
  participationQuota: 'Participation quota',
};
const ownerKey = (list: Owner[] | null | undefined) =>
  JSON.stringify(
    (list || [])
      .map(o => [o.name.toLowerCase(), o.share, o.idNo ?? null])
      .sort(),
  );

/**
 * The land record page's state and actions: the list, the open record, its tabs, drafts, review
 * and dialogs. Provided by LinkComponent, so the page's parts share one instance per visit.
 */
@Injectable()
export class LinkStore {
  private records$ = inject(RecordsApi);
  rbac = inject(RbacService);
  auth = inject(AuthService);
  private confirm = inject(ConfirmService);
  private toast = inject(ToastService);
  private router = inject(Router);
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
  // create dialog
  createOpen = signal(false);
  cmode = signal<'doc' | 'parcel'>('doc');
  cq = signal('');
  cfound = signal<FoundDocument[]>([]);
  cpick = signal<string | null>(null);
  kinds = signal<ParcelKind[]>([]);
  ckind = signal('erf');
  cparcel = signal<Record<string, string>>({});

  private timers: Record<string, ReturnType<typeof setTimeout>> = {};
  // dropdown options: each <option> is marked [selected] (API-612/614), so the shown value is the one held
  readonly tenures = [
    {id: '', label: '—'},
    {id: 'freehold', label: 'Freehold'},
    {id: 'leasehold', label: 'Leasehold'},
    {id: 'other', label: 'Other'},
  ];
  readonly units = [
    {id: 'm2', label: 'm²'},
    {id: 'ha', label: 'ha'},
  ];
  readonly encumbranceTypes = [
    {id: 'bond', label: 'Bond'},
    {id: 'servitude', label: 'Servitude'},
    {id: 'other', label: 'Other'},
  ];
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
    return !!r?.draft && r.draft.state === 'draft';
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
  suggestedOwnersDiffer = computed(() => {
    const s = this.shown()?.derived?.owners;
    return !!s?.length && ownerKey(s) !== ownerKey(this.owners());
  });
  suggestedOwnersText = computed(() =>
    (this.shown()?.derived?.owners || [])
      .map(o => `${o.name} ${o.share}`)
      .join(', '),
  );
  suggestedExtentDiffers = computed(() => {
    const s = this.shown()?.derived?.extent;
    const e = this.data()?.extent;
    return !!s && (!e || s.value !== e.value || s.unit !== e.unit);
  });
  /** Bonds the linked mortgage bonds suggest that the saved draft does not have yet. */
  offeredEncumbrances = computed(() =>
    encumbranceOffer(
      this.shown()?.derived?.encumbrances,
      this.data()?.encumbrances,
    ),
  );
  extentByHand = computed(() => {
    const f = this.df();
    const s = this.shown()?.derived?.extent;
    const e = this.data()?.extent;
    const v = Number(String(f.extent).replace(/\s/g, '').replace(',', '.'));
    if (!f.extent || (e && e.value === v && e.unit === f.unit)) return false;
    return !s || s.value !== v || s.unit !== f.unit;
  });
  events = computed(() => discussionEvents(this.versions(), this.comments()));
  dfilters = computed(() => {
    const all = this.events();
    const decisions = all.filter(isDecision).length;
    return [
      {id: 'all' as DFilter, label: 'All', n: all.length},
      {id: 'comments' as DFilter, label: 'Comments', n: all.length - decisions},
      {id: 'decisions' as DFilter, label: 'Decisions', n: decisions},
    ];
  });
  groups = computed(() => {
    const f = this.dfilter();
    return groupByVersion(
      this.events().filter(
        e => f === 'all' || (f === 'decisions') === isDecision(e),
      ),
    );
  });
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
  versionEvents = computed<DiscussionEvent[]>(() => {
    const n = this.rec()?.draft?.versionNumber;
    return this.events().filter(e => e.versionNumber === n);
  });
  submissions = computed(
    () => this.versionEvents().filter(e => e.kind === 'submitted').length,
  );
  /** Who submitted and approved the current version, and the approver's comment. */
  lastApproval = computed(() => {
    const c = this.rec()?.current;
    if (!c) return null;
    return {
      versionNumber: c.versionNumber,
      submittedBy: `${c.submittedByName || '—'} · ${this.fmt(c.submittedAt)}`,
      approvedBy: `${c.approvedByName || '—'} · ${this.fmt(c.committedAt)}`,
      comment: c.reviewComment,
    };
  });
  /** Who returned the open draft, and why, when that was the last decision on it. */
  lastReturn = computed(() => {
    const last = this.versionEvents().filter(isDecision).at(-1);
    return last?.kind === 'returned' ? last : null;
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
    const n = (f: SFilter) => rows.filter(r => this.matches(r, f)).length;
    return [
      {id: 'all' as SFilter, label: 'All', n: rows.length},
      {id: 'draft' as SFilter, label: 'Draft', n: n('draft')},
      {id: 'in_review' as SFilter, label: 'In review', n: n('in_review')},
      {id: 'committed' as SFilter, label: 'Committed', n: n('committed')},
      {
        id: 'needs_review' as SFilter,
        label: 'Needs review',
        n: n('needs_review'),
      },
    ];
  });
  visible = computed(() =>
    this.records().filter(r => this.matches(r, this.sf())),
  );
  kindFields = computed(() => {
    const k = this.kinds().find(x => x.id === this.ckind());
    if (!k) return [];
    const p = k.schema.properties.parcel;
    return Object.keys(p.properties)
      .filter(f => f !== 'kind')
      .map(f => ({k: f, required: (p.required || []).includes(f)}));
  });
  canCreate = computed(() =>
    this.cmode() === 'doc'
      ? !!this.cpick()
      : this.kindFields()
          .filter(f => f.required)
          .every(f => (this.cparcel()[f.k] || '').trim()),
  );
  parcelKeys = computed(() =>
    Object.keys(this.data()?.parcel || {}).filter(
      k =>
        k !== 'kind' &&
        this.data()!.parcel[k] !== null &&
        this.data()!.parcel[k] !== '',
    ),
  );

  matches(r: RecordSummary, f: SFilter) {
    if (f === 'all') return true;
    if (f === 'draft') return r.status === 'draft';
    if (f === 'committed') return r.status === 'committed';
    if (f === 'in_review') return r.draftState === 'in_review';
    return r.needsReview;
  }
  statusOf(r: RecordSummary): {label: string; tag: string} {
    if (r.needsReview) return {label: 'Needs review', tag: 'tag-outline'};
    if (r.draftState === 'in_review') {
      return {label: 'In review', tag: 'tag-info'};
    }
    if (r.status === 'draft') return {label: 'Draft', tag: 'tag-neutral'};
    if (r.draftVersion) {
      return {label: 'Change in progress', tag: 'tag-neutral'};
    }
    return {label: 'Committed', tag: 'tag-accent'};
  }
  dot(r: RecordSummary) {
    return r.needsReview
      ? 'flag'
      : r.draftState === 'in_review'
        ? 'review'
        : r.status === 'committed'
          ? 'committed'
          : 'draft';
  }
  typeLabel(id: string) {
    return (
      this.docTypes().find(t => t.id === id)?.label || id.replace(/_/g, ' ')
    );
  }
  parcelLabel(k: string) {
    return PARCEL_LABELS[k] || k;
  }
  tenureLabel(t?: string) {
    return t ? t[0].toUpperCase() + t.slice(1) : 'Tenure not set';
  }
  extentText(e?: {value: number; unit: string} | null) {
    return e
      ? `${e.value.toLocaleString('en-ZA')} ${e.unit === 'm2' ? 'm²' : 'ha'}`
      : '—';
  }
  initials(n: string) {
    return n
      .replace(/[^A-Za-z ]/g, '')
      .split(' ')
      .filter(Boolean)
      .map(s => s[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }
  linkedText(p: FoundDocument) {
    return p.linkedTo.map(l => `${l.label} (${l.recordNo})`).join(', ');
  }
  newer(d: PinnedDocument) {
    const f = this.rec()?.flags.find(
      x => x.edrmsDocumentId === d.edrmsDocumentId && x.to > d.version,
    );
    return f ? f.to : null;
  }
  checkLabel(c: Check) {
    return (
      (
        {
          shares_sum: 'Shares add up to 1',
          chain_of_title: 'Chain of title',
          extent_vs_sg: 'Extent matches the SG diagram',
          id_numbers: 'ID numbers',
          parcel_match: 'Documents describe this parcel',
          documents_current: 'Documents are current',
          overrides: 'Values from the documents',
        } as Record<string, string>
      )[c.id] || c.id
    );
  }

  // ---------------------------------------------------------------- loading

  async loadList() {
    try {
      const {items} = await this.records$.list(this.q().trim() || undefined);
      this.records.set(items);
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
  private show(r: LandRecord) {
    this.rec.set(r);
    const {current, draft, draftDiff, ...summary} = r;
    this.records.update(list =>
      list.some(x => x.id === r.id)
        ? list.map(x => (x.id === r.id ? summary : x))
        : [summary, ...list],
    );
  }
  private async reload() {
    const id = this.selId();
    if (id) this.show(await this.records$.get(id));
  }

  /** Run a change; a stale revision reloads the record, other errors are shown. */
  private async act(fn: (r: LandRecord) => Promise<LandRecord>, done?: string) {
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
  private fail(title: string, e: unknown) {
    const err = e instanceof ApiError ? e : null;
    const list = err?.details?.problems?.length
      ? ' ' + err.details.problems.join('; ')
      : '';
    this.toast.show('danger', title, (err?.message || String(e)) + list, 7000);
  }
  private debounce(key: string, fn: () => void, ms = 250) {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(fn, ms);
  }

  // ---------------------------------------------------------------- documents

  setMode(m: 'match' | 'search') {
    this.mode.set(m);
    this.loadFound();
  }
  searchDocs(v: string) {
    this.dq.set(v);
    this.debounce('docs', () => this.loadFound());
  }
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
  async add(p: FoundDocument) {
    if (
      await this.act(
        r => this.records$.link(r.id, r.draft!.revision, p.edrmsDocumentId),
        `${p.ref || p.edrmsNo} added to ${this.rec()!.label}`,
      )
    ) {
      this.loadFound();
    }
  }
  async remove(d: PinnedDocument) {
    const r = this.rec()!;
    if (
      !(await this.confirm.ask({
        title: `Remove ${d.ref || d.edrmsNo} from ${r.label}?`,
        body: 'The document stays in the EDRMS. Owners and checks are recalculated.',
        confirmLabel: 'Remove document',
        tone: 'danger',
      }))
    ) {
      return;
    }
    if (
      await this.act(
        x => this.records$.unlink(x.id, x.draft!.revision, d.edrmsDocumentId),
        `${d.ref || d.edrmsNo} removed`,
      )
    ) {
      this.loadFound();
    }
  }
  refresh(d: PinnedDocument) {
    return this.act(
      r => this.records$.refresh(r.id, r.draft!.revision, d.edrmsDocumentId),
      `${d.ref || d.edrmsNo} updated to the newer version`,
    );
  }
  async view(edrmsDocumentId: string, version?: number) {
    try {
      window.open(
        (await this.records$.contentLink(edrmsDocumentId, version)).url,
        '_blank',
        'noopener',
      );
    } catch (e) {
      this.fail('Could not open the document', e);
    }
  }
  viewByNo(edrmsNo: string) {
    const d = this.docs().find(x => x.edrmsNo === edrmsNo);
    if (d) this.view(d.edrmsDocumentId, d.version);
  }

  // ---------------------------------------------------------------- owners, extent, details

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
  /** Take the offered bonds from the documents; encumbrances entered by hand, saved or not, stay. */
  async acceptEncumbrances(o: EncumbranceOffer) {
    const done = await this.act(
      r =>
        this.records$.edit(
          r.id,
          o.accept
            ? {revision: r.draft!.revision, accept: ['encumbrances']}
            : {
                revision: r.draft!.revision,
                changes: {encumbrances: o.encumbrances},
              },
        ),
      'Encumbrances taken from the documents',
    );
    if (!done) return;
    // add them to the form without losing rows the officer has not saved yet
    this.df.update(f => {
      const have = new Set(f.encumbrances.map(encumbranceKey));
      return {
        ...f,
        encumbrances: [
          ...f.encumbrances,
          ...o.missing
            .filter(e => !have.has(encumbranceKey(e)))
            .map(e => ({...e})),
        ],
      };
    });
  }
  editOwners() {
    this.ownerForm.set({
      owners: structuredClone(
        this.owners().length
          ? this.owners()
          : (this.shown()?.derived?.owners ?? []),
      ),
      reason: '',
    });
  }
  setOwner(i: number, k: 'name' | 'idNo' | 'share', v: string) {
    this.ownerForm.update(
      f =>
        f && {
          ...f,
          owners: f.owners.map((o, j) => (j === i ? {...o, [k]: v} : o)),
        },
    );
  }
  addOwner() {
    this.ownerForm.update(
      f => f && {...f, owners: [...f.owners, {name: '', share: ''}]},
    );
  }
  removeOwner(i: number) {
    this.ownerForm.update(
      f => f && {...f, owners: f.owners.filter((_, j) => j !== i)},
    );
  }
  setOwnerReason(v: string) {
    this.ownerForm.update(f => f && {...f, reason: v});
  }
  async saveOwners() {
    const f = this.ownerForm()!;
    const owners = f.owners
      .filter(o => o.name.trim())
      .map(o => ({
        ...o,
        name: o.name.trim(),
        share: o.share.trim(),
        ...(o.idNo?.trim() ? {idNo: o.idNo.trim()} : {idNo: undefined}),
      }))
      .map(({idNo, ...o}) => (idNo ? {...o, idNo} : o));
    if (
      await this.act(
        r =>
          this.records$.edit(r.id, {
            revision: r.draft!.revision,
            changes: {owners},
            ...(f.reason.trim() ? {reason: f.reason.trim()} : {}),
          }),
        'Owners saved',
      )
    ) {
      this.ownerForm.set(null);
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
  setDf(k: string, v: string) {
    this.df.update(f => ({...f, [k]: v}));
  }
  setEnc(i: number, k: string, v: string) {
    this.df.update(f => ({
      ...f,
      encumbrances: f.encumbrances.map((e, j) =>
        j === i ? {...e, [k]: v} : e,
      ),
    }));
  }
  addEnc() {
    this.df.update(f => ({
      ...f,
      encumbrances: [...f.encumbrances, {type: 'servitude', ref: ''}],
    }));
  }
  removeEnc(i: number) {
    this.df.update(f => ({
      ...f,
      encumbrances: f.encumbrances.filter((_, j) => j !== i),
    }));
  }
  setAttr(i: number, k: 'k' | 'v', v: string) {
    this.df.update(f => ({
      ...f,
      attributes: f.attributes.map((a, j) => (j === i ? {...a, [k]: v} : a)),
    }));
  }
  addAttr() {
    this.df.update(f => ({
      ...f,
      attributes: [...f.attributes, {k: '', v: ''}],
    }));
  }
  removeAttr(i: number) {
    this.df.update(f => ({
      ...f,
      attributes: f.attributes.filter((_, j) => j !== i),
    }));
  }
  async saveDetails() {
    const f = this.df();
    const d = this.data()!;
    const changes: Record<string, unknown> = {};
    if ((f.tenure || null) !== (d.tenure ?? null)) {
      changes['tenure'] = f.tenure || null;
    }
    const value = Number(String(f.extent).replace(/\s/g, '').replace(',', '.'));
    if (
      f.extent &&
      (!d.extent || d.extent.value !== value || d.extent.unit !== f.unit)
    ) {
      changes['extent'] = {value, unit: f.unit};
    }
    if (!f.extent && d.extent) changes['extent'] = null;
    const enc = f.encumbrances
      .filter(e => (e.ref || '').trim())
      .map(e => ({
        type: e.type,
        ref: e.ref.trim(),
        ...(e.inFavourOf?.trim() ? {inFavourOf: e.inFavourOf.trim()} : {}),
        ...(e.note ? {note: e.note} : {}),
      }));
    if (JSON.stringify(enc) !== JSON.stringify(d.encumbrances ?? [])) {
      changes['encumbrances'] = enc;
    }
    // a value shown as JSON and left unchanged keeps its type (number, list, object)
    const attributes = Object.fromEntries(
      f.attributes
        .filter(a => a.k.trim())
        .map(a => [
          a.k.trim(),
          a.orig !== undefined &&
          typeof a.orig !== 'string' &&
          a.v === JSON.stringify(a.orig)
            ? a.orig
            : a.v,
        ]),
    );
    if (JSON.stringify(attributes) !== JSON.stringify(d.attributes ?? {})) {
      changes['attributes'] = Object.keys(attributes).length
        ? attributes
        : null;
    }
    if (!Object.keys(changes).length) {
      this.toast.show('info', 'Nothing to save');
      return;
    }
    if (
      await this.act(
        r =>
          this.records$.edit(r.id, {
            revision: r.draft!.revision,
            changes,
            ...(f.reason.trim() ? {reason: f.reason.trim()} : {}),
          }),
        'Details saved',
      )
    ) {
      this.resetDetails();
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async submit() {
    const r = this.rec()!;
    const owners =
      this.owners()
        .map(o => `${o.name} ${o.share}`)
        .join(', ') || 'none';
    if (
      !(await this.confirm.ask({
        title: `Submit ${r.label} for review?`,
        body: `Owners: ${owners}. A second person who can finalize records approves or returns it. It cannot be edited while in review.`,
        confirmLabel: 'Submit for review',
      }))
    ) {
      return;
    }
    if (
      await this.act(
        x => this.records$.submit(x.id, x.draft!.revision),
        `${r.label} submitted for review`,
      )
    ) {
      this.loadDiscussion();
      this.refreshReview();
    }
  }
  async withdraw() {
    const r = this.rec()!;
    if (
      !(await this.confirm.ask({
        title: `Withdraw ${r.label} from review?`,
        body: 'The approval task is removed and the draft can be edited again.',
        confirmLabel: 'Withdraw',
      }))
    ) {
      return;
    }
    if (
      await this.act(x => this.records$.withdraw(x.id), 'Withdrawn from review')
    ) {
      this.loadFound();
      this.loadDiscussion();
      this.refreshReview();
    }
  }
  async change() {
    if (
      await this.act(
        r => this.records$.openDraft(r.id),
        'A new draft is open; the committed version stays current until the change is approved',
      )
    ) {
      this.addOpen.set(true);
      this.loadFound();
    }
  }

  // ---------------------------------------------------------------- history

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
  async post() {
    const t = this.draftText().trim();
    const id = this.selId();
    if (!t || !id || !this.rbac.can('record.comment')) return;
    try {
      const c = await this.records$.comment(id, t);
      this.comments.update(l => [...l, c]);
      this.draftText.set('');
    } catch (e) {
      this.fail('Could not post the comment', e);
    }
  }

  // ---------------------------------------------------------------- review & approve

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
  private refreshReview() {
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

  /** Approve or return the version in review: the same approval task as in the task inbox. */
  async decide(outcome: 'approved' | 'rejected') {
    const t = this.myTask();
    const r = this.rec();
    if (!t || !r?.draft || this.busy()) return;
    const comment = this.decisionText().trim();
    const version = r.draft.versionNumber;
    if (outcome === 'rejected' && !comment) {
      this.decisionError.set('Say what the records officer should fix.');
      return;
    }
    if (
      outcome === 'approved' &&
      !(await this.confirm.ask({
        title: `Approve version ${version} of ${r.label}?`,
        body: 'It becomes the current version of the land record and is sealed.',
        confirmLabel: `Approve version ${version}`,
      }))
    ) {
      return;
    }
    this.busy.set(true);
    this.decisionError.set('');
    try {
      const inst = await this.tasks.complete(
        t.id,
        outcome,
        comment || undefined,
      );
      if (inst.status === 'error') {
        this.toast.show(
          'warn',
          'Decision recorded, but the change could not be applied',
          inst.errorMessage || 'See the process for details.',
          9000,
        );
      } else if (outcome === 'approved') {
        this.toast.show(
          'success',
          `${r.label} approved: version ${version} is now current`,
          r.recordNo,
        );
      } else {
        this.toast.show(
          'info',
          `${r.label} returned to the records officer`,
          r.recordNo,
        );
      }
      this.decisionText.set('');
    } catch (e) {
      // e.g. decided meanwhile in the bell or by someone else, or withdrawn: the error, and the record as it is now
      this.decisionError.set(e instanceof ApiError ? e.message : String(e));
      this.fail('Could not record the decision', e); // the form, and the error in it, may be gone after the reload
      this.tasks.refresh();
    } finally {
      this.busy.set(false);
    }
    await this.reload().catch(e =>
      this.fail('Could not reload the land record', e),
    );
    this.refreshReview();
    this.loadDiscussion();
  }

  // ---------------------------------------------------------------- new record

  openCreate() {
    this.cmode.set('doc');
    this.cq.set('');
    this.cfound.set([]);
    this.cpick.set(null);
    this.cparcel.set({});
    if (!this.kinds().length) {
      this.records$
        .catalogue()
        .then(c => this.kinds.set(c.parcelKinds))
        .catch(e => this.fail('Could not load parcel kinds', e));
    }
    this.createOpen.set(true);
  }
  searchCreate(v: string) {
    this.cq.set(v);
    this.debounce('create', async () => {
      try {
        this.cfound.set(
          this.cq().trim()
            ? (await this.records$.searchDocuments(this.cq().trim())).items
            : [],
        );
      } catch (e) {
        this.fail('Could not search the EDRMS', e);
      }
    });
  }
  setParcel(k: string, v: string) {
    this.cparcel.update(p => ({...p, [k]: v}));
  }
  async create() {
    if (!this.canCreate() || this.busy()) return;
    this.busy.set(true);
    try {
      let body: {parcel?: Parcel; edrmsDocumentId?: string};
      if (this.cmode() === 'doc') body = {edrmsDocumentId: this.cpick()!};
      else {
        const parcel: Parcel = {kind: this.ckind()};
        for (const f of this.kindFields()) {
          const v = (this.cparcel()[f.k] || '').trim();
          if (v) parcel[f.k] = f.k === 'participationQuota' ? Number(v) : v;
        }
        body = {parcel};
      }
      const r = await this.records$.create(body);
      this.createOpen.set(false);
      this.sf.set('all');
      this.show(r);
      this.selId.set(r.id);
      this.tab.set('documents');
      this.mode.set('match');
      this.addOpen.set(true);
      this.loadFound();
      this.comments.set([]);
      this.versions.set([]);
      this.router.navigate([], {queryParams: {record: r.id}, replaceUrl: true});
      this.toast.show('success', `${r.label} created`, r.recordNo);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409 && err.details?.recordId) {
        this.createOpen.set(false);
        this.select(err.details.recordId);
      }
      this.fail('Could not create the record', e);
    } finally {
      this.busy.set(false);
    }
  }
}
