import { Injectable, computed, inject, signal } from '@angular/core';
import { ToastService } from './toast.service';
import { AuditEntry, FieldEdit, FieldStatus, LandDoc, LinkState, DocField } from '../data/models';
import { DOCS, TOTAL, ROLE, hash, VIEWDOCS } from '../data/mock-data';

export interface Owner { name: string; nid: string; frac: string; pct: number; note: string; }
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
        this.addLog('K. Iipinge', ROLE.scan, 'Captured', 'WDH-B017', TOTAL + ' pages → 3 instruments (' + (this.src() === 'hot' ? 'hot folder' : 'SC-02') + ')');
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
    this.addLog('A. Mwandingi', ROLE.rev, 'Filed', doc.edrms, doc.ref + ' · ' + doc.fields.length + ' fields, ' + edits + ' corrected');
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
    this.addLog('J. !Gawaseb', ROLE.rec, k === 'linked' ? 'Linked' : 'Rejected', d.ref, k === 'linked' ? '→ Erf 1873, Klein Windhoek' : 'Returned to unmatched queue');
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
      { label: 'Open items', state: open + pend === 0 ? 'ok' : 'warn', detail: open + pend === 0 ? 'All documents resolved' : open + ' to confirm · ' + pend + ' in review' }
    ];
  });
  readonly canCommit = computed(() => !this.committed() && this.openSuggestions().length === 0 && this.linkedCount() > 0 && !this.chainBreak() && !this.idInvalid());
  commit() {
    this.committed.set(true);
    this.toast.show('success', 'Erf 1873 record v3 committed', 'Record is ready for tokenization.');
    this.addLog('J. !Gawaseb', ROLE.rec, 'Committed', 'Erf 1873 record v3', this.owners().map(o => o.name.split(' ')[0] + ' ' + o.frac).join(', '));
  }

  // ---------- audit ----------
  addLog(who: string, role: string, action: string, obj: string, detail: string) {
    this.clock++;
    this.log.update(l => [...l, { n: this.clock, who, role, action, obj, detail }]);
  }
  audit(doc: LandDoc, kind: 'ok' | 'finding', edits: number) {
    this.audited.update(a => ({ ...a, [doc.id]: kind }));
    this.toast.show(kind === 'ok' ? 'success' : 'warn', kind === 'ok' ? doc.ref + ' marked audited' : 'Finding raised on ' + doc.ref, 'Recorded in the audit trail.');
    this.addLog('M. Nakale', 'Auditor', kind === 'ok' ? 'Audited' : 'Finding', doc.ref,
      kind === 'ok' ? 'Image, metadata and hash reconciled' : edits ? edits + ' reviewer corrections require second check' : 'Metadata discrepancy noted');
  }
  readonly trail = computed(() => {
    const seed: AuditEntry[] = [
      { n: -3, who: 'System', role: ROLE.sys, action: 'Created', obj: 'Erf 1873 record', detail: 'Migrated from legacy register · v1' },
      { n: -2, who: 'System', role: ROLE.sys, action: 'Linked', obj: 'G 88/1978, T 1502/1996', detail: 'Pilot back-scan 2025 · v2' },
      { n: -1, who: 'K. Iipinge', role: ROLE.scan, action: 'Opened batch', obj: 'WDH-B017', detail: 'Vault 3 · T-series 2008, 2019' }
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
