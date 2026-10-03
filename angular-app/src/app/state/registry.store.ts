import { Injectable, computed, inject, signal } from '@angular/core';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { ApiService } from '../api/api.service';
import { AuditEntry, FieldEdit, FieldStatus, LandDoc, LinkState, DocField } from '../data/models';
import { DOCS, TOTAL, ROLE, hash, VIEWDOCS, ALL_DOCS, LAND_RECORDS, LandRecordRow, QUEUE } from '../data/mock-data';

export interface Owner { name: string; nid: string; frac: string; pct: number; note: string; }
export interface RecordComment { who: string; role: string; time: string; text: string; }
export type RecordStatus = 'draft' | 'scanned' | 'verified' | 'finalized';
export interface Check { label: string; detail: string; state: 'ok' | 'warn' | 'none'; }

/** Single source of truth for the demo. Replace with API calls (EDRMS + ERP) in production. */
@Injectable({ providedIn: 'root' })
export class RegistryStore {
  readonly threshold = signal(0.85);
  readonly src = signal<'live' | 'hot'>('live');
  readonly pages = signal(0);
  readonly scanning = signal(false);
  readonly filed = signal<Record<string, boolean>>({});
  readonly linked = signal<Record<string, boolean>>({});
  readonly rejected = signal<Record<string, boolean>>({});
  readonly fs = signal<Record<string, Record<string, FieldEdit>>>({});
  readonly log = signal<AuditEntry[]>([]);
  readonly audited = signal<Record<string, 'ok' | 'finding'>>({});
  readonly committed = signal(false);
  readonly flaggedPages = signal<Record<string, boolean>>({});
  readonly scanDone = computed(() => this.pages() >= TOTAL);
  private timer: any;
  private clock = 0;
  private toast = inject(ToastService);
  private auth = inject(AuthService);
  private api = inject(ApiService);

  // ---------- bridge to the live EDRMS ----------
  /** EDRMS numbers of demo documents that were filed for real (see syncWithEdrms). */
  readonly realEdrms = signal<Record<string, string>>({});
  private syncing: Promise<void> | null = null;

  /**
   * Erf 1873's documents (T 2210/2008, SG A 412/2007, T 4521/2019) count as filed once a reviewer
   * has filed a document with the same reference in the live EDRMS (Capture → Verify), with the
   * values the reviewer filed (e.g. a corrected ID number). Until the land-records service exists,
   * this lets testers take the sample documents from upload to a finalized record. The rest of the
   * Land record and Audit screens stays demo data.
   */
  syncWithEdrms(): Promise<void> {
    return (this.syncing ??= (async () => {
      for (const d of DOCS) {
        if (this.filed()[d.id]) continue;
        let doc: { edrmsNo: string; fields?: { k: string; v: string }[] };
        try {
          doc = await this.api.get('/documents/lookup', { instrumentRef: d.ref.replace(/^SG /, '') });
        } catch { continue; }   // not filed (yet), or no access
        for (const f of doc.fields ?? []) {
          const demo = d.fields.find(x => x.k === f.k);
          if (demo && f.v && f.v !== demo.v) this.fs.update(all => ({ ...all, [d.id]: { ...(all[d.id] || {}), [f.k]: { value: f.v, status: 'edited' } } }));
        }
        this.filed.update(m => ({ ...m, [d.id]: true }));
        this.realEdrms.update(m => ({ ...m, [d.id]: doc.edrmsNo }));
      }
    })().finally(() => { this.syncing = null; }));
  }

  /** The document's EDRMS number: the live one if it was filed for real, else the demo's. */
  edrmsNo(doc: LandDoc) { return this.realEdrms()[doc.id] ?? doc.edrms; }

  // ---------- land records (ERP) ----------
  readonly records = signal<LandRecordRow[]>(LAND_RECORDS);
  readonly recordDocs = signal<Record<string, string[]>>(Object.fromEntries(LAND_RECORDS.filter(r => !r.live).map(r => [r.id, [...r.docIds]])));
  readonly removedBase = signal<Record<string, boolean>>({});
  readonly finalizedRec = signal<Record<string, boolean>>(Object.fromEntries(LAND_RECORDS.filter(r => r.batch === 'WDH-B014').map(r => [r.id, true])));
  readonly comments = signal<Record<string, RecordComment[]>>({
    erf1873: [
      { who: '(sample)', role: 'Registrar', time: '25 Sep 2026 14:10', text: 'T 2210/2008 and the 2019 estate transfer have been pulled from Vault 3 for back-scanning. Please confirm the executor\'s authority before finalizing.' },
      { who: '(sample)', role: 'Records officer', time: '26 Sep 2026 09:32', text: "Master's reference E 1830/2018 checked against the estate file. OK to proceed once the SG diagram is linked." }
    ],
    [LAND_RECORDS[1]?.id]: [{ who: '(sample)', role: 'Metadata reviewer', time: '24 Sep 2026 11:05', text: 'Transferee ID on page 2 was hand-corrected on the original. I kept the corrected value.' }]
  });
  private newSeq = 0;

  doc(id: string) { return ALL_DOCS.find(d => d.id === id) || null; }
  record(id: string) { return this.records().find(r => r.id === id) || null; }
  recordDocIds(rid: string): string[] {
    if (rid === 'erf1873') {
      const rb = this.removedBase();
      return [...['g1', 'g2'].filter(id => !rb[id]), ...DOCS.filter(d => this.linked()[d.id]).map(d => d.id)];
    }
    return this.recordDocs()[rid] || [];
  }
  readonly docRecordMap = computed(() => {
    const m: Record<string, string> = {};
    this.linked(); this.removedBase(); this.recordDocs();
    this.records().forEach(r => this.recordDocIds(r.id).forEach(id => m[id] = r.id));
    return m;
  });
  readonly unassigned = computed(() => ALL_DOCS.filter(d => !this.docRecordMap()[d.id]));

  addDocToRecord(rid: string, docId: string) {
    const d = this.doc(docId)!, r = this.record(rid)!;
    if (rid === 'erf1873' && DOCS.some(x => x.id === docId)) { this.rejected.update(m => ({ ...m, [docId]: false })); this.linked.update(m => ({ ...m, [docId]: true })); }
    else if (rid === 'erf1873' && d.isBase) this.removedBase.update(m => ({ ...m, [docId]: false }));
    else this.recordDocs.update(m => ({ ...m, [rid]: [...(m[rid] || []), docId] }));
    this.touch(rid);
    this.addLog(this.actor(), this.actorRole(ROLE.rec), 'Linked', d.ref, '→ ' + r.erf + ', ' + r.township);
    this.toast.show('success', d.ref + ' added to ' + r.erf, 'Ownership and record checks updated.');
  }
  removeDocFromRecord(rid: string, docId: string) {
    const d = this.doc(docId)!, r = this.record(rid)!;
    if (rid === 'erf1873' && DOCS.some(x => x.id === docId)) this.linked.update(m => ({ ...m, [docId]: false }));
    else if (rid === 'erf1873' && d.isBase) this.removedBase.update(m => ({ ...m, [docId]: true }));
    else this.recordDocs.update(m => ({ ...m, [rid]: (m[rid] || []).filter(x => x !== docId) }));
    this.touch(rid);
    this.addLog(this.actor(), this.actorRole(ROLE.rec), 'Unlinked', d.ref, 'Removed from ' + r.erf + ', ' + r.township);
    this.toast.show('warn', d.ref + ' removed from ' + r.erf, 'The document is back in the unlinked pool.');
  }
  private touch(rid: string) {
    if (rid === 'erf1873') this.committed.set(false);
    this.finalizedRec.update(m => ({ ...m, [rid]: false }));
    this.records.update(rs => rs.map(r => r.id === rid ? { ...r, lastActivity: '28 Sep 2026' } : r));
  }
  /** Actions in the demo screens are attributed to whoever is signed in. */
  private actor() { return this.auth.role()?.name || 'You'; }
  /** The signed-in user's roles, or the role the action belongs to when nobody is signed in. */
  private actorRole(fallback: string) { return this.auth.role()?.label || fallback; }
  createRecord(data: { erf: string; township: string; regDiv: string; extent: string; tenure: string }) {
    const id = 'new' + (++this.newSeq);
    this.records.update(rs => [{ id, ...data, region: 'Khomas', owners: [], docs: 0, docIds: [], lastActivity: '28 Sep 2026', batch: '—' }, ...rs]);
    this.recordDocs.update(m => ({ ...m, [id]: [] }));
    this.addLog(this.actor(), this.actorRole(ROLE.rec), 'Created', data.erf + ', ' + data.township, 'New ERP land record (draft)');
    this.toast.show('success', 'Land record created', data.erf + ', ' + data.township + ' · add documents to build the chain of title.');
    return id;
  }
  addComment(rid: string, text: string, who: string, role: string) {
    const now = new Date(), hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
    this.comments.update(c => ({ ...c, [rid]: [...(c[rid] || []), { who, role, text, time: '28 Sep 2026 ' + hh + ':' + mm }] }));
    const r = this.record(rid)!;
    this.addLog(who, role, 'Comment', r.erf + ', ' + r.township, text.length > 60 ? text.slice(0, 57) + '…' : text);
  }
  recordStatus(r: LandRecordRow): RecordStatus {
    if (r.id === 'erf1873') {
      if (this.committed()) return 'finalized';
      const ids = this.recordDocIds(r.id);
      return DOCS.every(d => this.filed()[d.id]) ? 'verified' : ids.length ? 'scanned' : 'draft';
    }
    if (this.finalizedRec()[r.id]) return 'finalized';
    const ids = this.recordDocIds(r.id);
    if (!ids.length) return 'draft';
    return ids.every(id => this.isFiled(this.doc(id)!)) ? 'verified' : 'scanned';
  }
  genericChecks(r: LandRecordRow): Check[] {
    const ids = this.recordDocIds(r.id), docs = ids.map(id => this.doc(id)!);
    const filed = docs.filter(d => this.isFiled(d)).length;
    return [
      { label: 'Documents verified', state: docs.length && filed === docs.length ? 'ok' : docs.length ? 'warn' : 'none', detail: docs.length ? filed + ' of ' + docs.length + ' filed in the EDRMS' : 'No documents linked yet' },
      { label: 'Registered owners', state: r.owners.length ? 'ok' : 'none', detail: r.owners.length ? r.owners.length + ' holder(s) with valid IDs' : 'Derived once a title deed is linked' },
      { label: 'Shares sum to one', state: r.owners.length ? 'ok' : 'none', detail: r.owners.length ? (r.owners.length === 2 ? '½ + ½ = 1' : '1/1') : '—' },
      { label: 'Survey diagram', state: docs.some(d => d.isDiagram) ? 'ok' : 'none', detail: docs.some(d => d.isDiagram) ? 'SG diagram linked · extent confirmed' : 'No SG diagram linked' }
    ];
  }
  canFinalize(r: LandRecordRow): boolean {
    if (r.id === 'erf1873') return this.canCommit();
    const st = this.recordStatus(r);
    return st === 'verified' && this.genericChecks(r).every(c => c.state !== 'warn');
  }
  finalizeRecord(r: LandRecordRow) {
    if (r.id === 'erf1873') { this.commit(); return; }
    this.finalizedRec.update(m => ({ ...m, [r.id]: true }));
    this.addLog(this.actor(), this.actorRole(ROLE.rec), 'Committed', r.erf + ', ' + r.township, 'Record finalized · tokenization-ready');
    this.toast.show('success', r.erf + ', ' + r.township + ' finalized', 'Record is ready for tokenization.');
  }
  readonly recordRows = computed(() => {
    this.fs(); this.filed(); this.committed(); this.pages(); this.linked(); this.recordDocs(); this.finalizedRec(); this.removedBase();
    return this.records().map(r => {
      const st = this.recordStatus(r), ids = this.recordDocIds(r.id);
      const ownerList = r.live ? this.owners().map(o => o.name + ' · ' + o.frac) : r.owners;
      let detail: string;
      if (st === 'finalized') detail = r.live ? 'Record v3 committed · tokenization-ready' : 'Committed · tokenization-ready';
      else if (st === 'draft') detail = 'No documents linked yet';
      else if (st === 'verified') detail = r.live && this.openSuggestions().length ? this.openSuggestions().length + ' suggested document(s) to resolve' : 'Documents verified · ready for records review';
      else if (r.live && this.pages() < TOTAL) detail = 'Capture in progress · ' + this.pages() + '/' + TOTAL + ' pages';
      else { const d = ids.map(id => this.doc(id)!).filter(x => !this.isFiled(x)); detail = d.length + ' document(s) in metadata review'; }
      const label = st === 'finalized' ? 'Finalized' : st === 'verified' ? 'Verified · ready for review' : st === 'draft' ? 'Draft' : 'Scanned';
      const tag = st === 'finalized' ? 'tag-accent' : st === 'verified' ? 'tag-info' : 'tag-neutral';
      return { ...r, docs: r.live ? ids.length + this.openSuggestions().length : ids.length, ownerList, st, label, tag, detail, action: 'Open record' };
    });
  });


  // ---------- capture ----------
  gotPages(doc: LandDoc): number {
    const i = DOCS.indexOf(doc);
    if (i < 0) return doc.pages;
    let o = 0;
    for (let x = 0; x < i; x++) o += DOCS[x].pages;
    return Math.max(0, Math.min(doc.pages, this.pages() - o));
  }
  startScan(speedMs = 400) {
    if (this.scanning()) return;
    this.scanning.set(true);
    this.pages.set(0);
    const speed = this.src() === 'hot' ? speedMs / 2 : speedMs;
    this.timer = setInterval(() => {
      const p = this.pages() + 1;
      if (p >= TOTAL) {
        clearInterval(this.timer);
        this.pages.set(TOTAL);
        this.scanning.set(false);
        this.addLog(this.actor(), this.actorRole(ROLE.scan), 'Captured', 'WDH-B017', TOTAL + ' pages → 3 instruments (' + (this.src() === 'hot' ? 'hot folder' : 'SC-02') + ')');
        this.toast.show('success', 'Batch WDH-B017 captured', TOTAL + ' pages split into 3 instruments and sent to extraction.');
      } else this.pages.set(p);
    }, speed);
  }
  toggleRescan(doc: LandDoc, page: number) {
    const k = doc.id + page;
    const on = !this.flaggedPages()[k];
    this.flaggedPages.update(f => ({ ...f, [k]: on }));
    this.toast.show(on ? 'warn' : 'info', on ? 'Page flagged for rescan' : 'Rescan flag removed', doc.ref + ' · page ' + (page + 1));
  }

  // ---------- verification ----------
  value(doc: LandDoc, f: DocField): string { return this.fs()[doc.id]?.[f.k]?.value ?? f.v; }
  status(doc: LandDoc, f: DocField, i: number): FieldStatus {
    const s = this.fs()[doc.id]?.[f.k]?.status;
    if (s) return s;
    return doc.isBase || doc.preFiled || i < (doc.preReviewed ?? 0) ? 'accepted' : 'pending';
  }
  isEdited(doc: LandDoc, f: DocField) { return this.fs()[doc.id]?.[f.k]?.status === 'edited' && this.value(doc, f) !== f.v; }
  reviewedCount(doc: LandDoc) { return doc.fields.filter((f, i) => this.status(doc, f, i) !== 'pending').length; }
  isFiled(doc: LandDoc) { return !!(this.filed()[doc.id] || doc.preFiled || doc.isBase); }
  setField(docId: string, k: string, patch: FieldEdit) {
    this.fs.update(all => ({ ...all, [docId]: { ...(all[docId] || {}), [k]: { ...(all[docId]?.[k] || {}), ...patch } } }));
    this.committed.set(false);
  }
  fileDoc(doc: LandDoc) {
    const edits = doc.fields.filter(f => this.fs()[doc.id]?.[f.k]?.status === 'edited').length;
    this.filed.update(f => ({ ...f, [doc.id]: true }));
    this.addLog(this.actor(), this.actorRole(ROLE.rev), 'Filed', doc.edrms, doc.ref + ' · ' + doc.fields.length + ' fields, ' + edits + ' corrected');
    this.toast.show('success', doc.ref + ' filed to EDRMS', doc.edrms + ' · ' + edits + ' field(s) corrected');
  }

  // ---------- linking ----------
  linkState(id: string): LinkState {
    if (id === 'g1' || id === 'g2') return 'base';
    if (!this.filed()[id]) return 'pending';
    return this.linked()[id] ? 'linked' : this.rejected()[id] ? 'rejected' : 'suggested';
  }
  link(id: string) { this.decide(id, 'linked'); }
  reject(id: string) { this.decide(id, 'rejected'); }
  undo(id: string) {
    this.linked.update(l => ({ ...l, [id]: false }));
    this.rejected.update(r => ({ ...r, [id]: false }));
    this.committed.set(false);
  }
  private decide(id: string, k: 'linked' | 'rejected') {
    const d = DOCS.find(x => x.id === id)!;
    (k === 'linked' ? this.linked : this.rejected).update(m => ({ ...m, [id]: true }));
    this.committed.set(false);
    this.addLog(this.actor(), this.actorRole(ROLE.rec), k === 'linked' ? 'Linked' : 'Rejected', d.ref, k === 'linked' ? '→ Erf 1873, Klein Windhoek' : 'Returned to unmatched queue');
    this.toast.show(k === 'linked' ? 'success' : 'warn', k === 'linked' ? d.ref + ' linked to Erf 1873' : d.ref + ' rejected', k === 'linked' ? 'Ownership and checks updated.' : 'Returned to the unmatched queue.');
  }
  readonly openSuggestions = computed(() => DOCS.filter(d => this.linkState(d.id) === 'suggested'));
  readonly pendingReview = computed(() => DOCS.filter(d => this.linkState(d.id) === 'pending'));
  readonly linkedCount = computed(() => DOCS.filter(d => this.linked()[d.id]).length);

  readonly owners = computed<Owner[]>(() => {
    const L = this.linked();
    const tomasId = this.fs()['c']?.['tee2Id']?.value || '0111250379';
    if (L['c'] && !L['a']) return [{ name: 'Johannes Shikongo', nid: '61042500187', frac: '1/1', pct: 100, note: 'T 1502/1996 · T 4521/2019 held back' }];
    if (!L['a']) return [{ name: 'Johannes Shikongo', nid: '61042500187', frac: '1/1', pct: 100, note: 'T 1502/1996' }];
    if (!L['c']) return [
      { name: 'Petrus Nghishidi', nid: '72110800345', frac: '½', pct: 50, note: 'T 2210/2008 · in community of property' },
      { name: 'Maria Nghishidi', nid: '75060200418', frac: '½', pct: 50, note: 'T 2210/2008 · in community of property' }];
    return [
      { name: 'Maria Nghishidi', nid: '75060200418', frac: '½', pct: 50, note: 'T 2210/2008' },
      { name: 'Ndapewa Nghishidi', nid: '98030100562', frac: '¼', pct: 25, note: 'T 4521/2019 · inherited' },
      { name: 'Tomas Nghishidi', nid: tomasId, frac: '¼', pct: 25, note: 'T 4521/2019 · inherited' }];
  });
  readonly chainBreak = computed(() => !!(this.linked()['c'] && !this.linked()['a']));
  readonly idInvalid = computed(() => this.owners().find(o => !/^\d{11}$/.test(o.nid)) || null);

  readonly checks = computed<Check[]>(() => {
    const L = this.linked(), owners = this.owners(), bad = this.idInvalid();
    const open = this.openSuggestions().length, pend = this.pendingReview().length;
    return [
      { label: 'Shares sum to one', detail: owners.map(o => o.frac).join(' + ') + ' = 1', state: 'ok' },
      { label: 'Chain of title', state: this.chainBreak() ? 'warn' : L['a'] ? 'ok' : 'none',
        detail: this.chainBreak() ? 'T 4521/2019 cites T 2210/2008, which is not linked' : L['c'] ? 'T 1502/1996 → T 2210/2008 → T 4521/2019, each citing its prior title' : L['a'] ? 'T 1502/1996 → T 2210/2008' : 'No new transfers linked' },
      { label: 'Extent vs. SG diagram', state: L['b'] ? 'ok' : 'none', detail: L['b'] ? 'Title 1 214 m² · diagram A 412/2007 1 214 m²' : 'Diagram not linked' },
      { label: 'Holder identity numbers', state: bad ? 'warn' : 'ok', detail: bad ? bad.name + ': “' + bad.nid + '” is not 11 digits — correct in review' : 'All holders have valid 11-digit IDs' },
      ...(this.removedBase()['g1'] || this.removedBase()['g2'] ? [{ label: 'Root of title', state: 'warn' as const, detail: 'Original grant or prior transfer removed from the record' }] : []),
      { label: 'Open items', state: open + pend === 0 ? 'ok' : 'warn', detail: open + pend === 0 ? 'All documents resolved' : open + ' to confirm · ' + pend + ' in review' }
    ];
  });
  readonly canCommit = computed(() => !this.committed() && this.openSuggestions().length === 0 && this.linkedCount() > 0 && !this.chainBreak() && !this.idInvalid());
  commit() {
    this.committed.set(true);
    this.toast.show('success', 'Erf 1873 record v3 committed', 'Record is ready for tokenization.');
    this.addLog(this.actor(), this.actorRole(ROLE.rec), 'Committed', 'Erf 1873 record v3', this.owners().map(o => o.name.split(' ')[0] + ' ' + o.frac).join(', '));
  }

  // ---------- audit ----------
  addLog(who: string, role: string, action: string, obj: string, detail: string) {
    this.clock++;
    this.log.update(l => [...l, { n: this.clock, who, role, action, obj, detail }]);
  }
  audit(doc: LandDoc, kind: 'ok' | 'finding', edits: number) {
    this.audited.update(a => ({ ...a, [doc.id]: kind }));
    this.toast.show(kind === 'ok' ? 'success' : 'warn', kind === 'ok' ? doc.ref + ' marked audited' : 'Finding raised on ' + doc.ref, 'Recorded in the audit trail.');
    this.addLog(this.actor(), this.actorRole('Auditor'), kind === 'ok' ? 'Audited' : 'Finding', doc.ref,
      kind === 'ok' ? 'Image, metadata and hash reconciled' : edits ? edits + ' reviewer corrections require second check' : 'Metadata discrepancy noted');
  }
  readonly trail = computed(() => {
    const seed: AuditEntry[] = [
      { n: -3, who: 'System', role: ROLE.sys, action: 'Created', obj: 'Erf 1873 record', detail: 'Migrated from legacy register · v1' },
      { n: -2, who: 'System', role: ROLE.sys, action: 'Linked', obj: 'G 88/1978, T 1502/1996', detail: 'Pilot back-scan 2025 · v2' },
      { n: -1, who: '(sample)', role: ROLE.scan, action: 'Opened batch', obj: 'WDH-B017', detail: 'Vault 3 · T-series 2008, 2019' }
    ];
    let prev = 'genesis';
    return [...seed, ...this.log()].map(a => {
      const mins = 8 * 60 + 40 + (a.n + 3) * 7;
      const h = hash(prev + a.action + a.obj + a.detail); prev = h;
      const doc = VIEWDOCS.find(v => (a.obj + ' ' + a.detail).includes(v.ref) || a.obj === v.edrms) || null;
      return { ...a, hash: h, doc, time: '28 Sep 2026 ' + String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0') };
    });
  });
}
