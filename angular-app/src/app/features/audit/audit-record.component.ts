import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { AuditApi, CheckDocument, CheckVersion, Checkpoint, Finding } from '../../api/audit.api';
import { IntakeApi, IntakeDocType } from '../../api/intake.api';
import { History, LandRecord, PinnedDocument, RecordsApi, Version } from '../../api/records.api';
import { InfoTipComponent } from '../../shared/info-tip.component';
import { ProofLinkComponent } from '../../shared/proof-link.component';
import { RecordDiffComponent } from '../../shared/record-diff.component';
import { ConfirmService } from '../../state/confirm.service';
import { RbacService } from '../../state/rbac.service';
import { ToastService } from '../../state/toast.service';
import { AuditReviewComponent } from './audit-review.component';
import { AuditTrailComponent } from './audit-trail.component';
import {
  ANCHORING, CHANGED_SINCE_REVIEW, MATCH, TIPS, findingNumber, lockedNote, openIssues, proofLabel, rangeLabel,
  shortDate, shortDateTime, signoffBlock, toneClass, versionState
} from './audit-wording';
import { FindingReply, FindingThreadComponent } from './finding-thread.component';

/** What the detail panel shows. */
type Selection = { kind: 'checkpoint' } | { kind: 'version'; n: number } | { kind: 'doc'; id: string };

/** The documents table's filters. */
type DocFilter = 'attention' | 'new' | 'all';

const DOC_FILTERS: { id: DocFilter; label: string }[] = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'new', label: 'New in this audit' },
  { id: 'all', label: 'All' }
];

/** A document of the version shown, as the table and the panel use it. */
interface DocRow {
  pin: PinnedDocument;
  addedIn: number;
  check: CheckDocument | null;
  findings: Finding[];
  changed: boolean;
  issues: string[];
  checkLabel: string;
  checkTone: string;
}

/**
 * One land record's audit (`#/audit/records/:id`, API-661): the open checkpoint (every version since
 * the last audit sign-off), checked against the blockchain automatically; the versions and their
 * changes; the documents with their open issues; the review of one document; findings; the trail;
 * the evidence pack; and the one audit sign-off.
 */
@Component({
  selector: 'app-audit-record',
  imports: [RouterLink, InfoTipComponent, ProofLinkComponent, RecordDiffComponent, FindingThreadComponent, AuditReviewComponent, AuditTrailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './audit-record.component.html',
  styleUrl: './audit-record.component.css'
})
export class AuditRecordComponent {
  private readonly audit = inject(AuditApi);
  private readonly records = inject(RecordsApi);
  private readonly intake = inject(IntakeApi);
  private readonly rbac = inject(RbacService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);

  /** The land record's id, from the route. */
  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map(p => p.get('id') ?? '')), { initialValue: '' });

  protected readonly tips = TIPS;
  protected readonly docFilters = DOC_FILTERS;
  protected readonly changedSinceReview = CHANGED_SINCE_REVIEW;

  protected readonly record = signal<LandRecord | null>(null);
  protected readonly check = signal<Checkpoint | null>(null);
  protected readonly history = signal<History | null>(null);
  protected readonly versions = signal<Version[]>([]);
  protected readonly findings = signal<Finding[]>([]);
  protected readonly chainIntact = signal<boolean | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly trailKey = signal(0);

  protected readonly selected = signal<Selection>({ kind: 'checkpoint' });
  protected readonly tab = signal<'proof' | 'meta' | 'issues'>('proof');
  protected readonly shownVersion = signal<number | null>(null);
  protected readonly docFilter = signal<DocFilter>('new');
  protected readonly docQuery = signal('');
  /** The versions whose changes the auditor has checked on this screen (not stored: API-680). */
  protected readonly checked = signal<ReadonlySet<number>>(new Set());
  protected readonly reviewing = signal<string | null>(null);
  protected readonly raising = signal<{ documentId: string | null; about: string } | null>(null);
  protected readonly findingText = signal('');
  protected readonly exported = signal<{ fileName: string; checksum: string } | null>(null);
  /** The document types with their labels and their fields' labels (the intake catalogue). */
  private readonly docTypes = signal<IntakeDocType[]>([]);

  protected readonly canAct = computed(() => this.rbac.can('audit.signoff'));
  protected readonly canExport = computed(() => this.rbac.can('audit.export'));

  protected readonly current = computed(() => this.record()?.currentVersion ?? 0);
  protected readonly owners = computed(() => (this.record()?.current?.data.owners || []).map(o => o.name).join(', '));
  protected readonly range = computed(() => this.check()?.range ?? null);
  protected readonly rangeText = computed(() => {
    const r = this.range();
    return r ? rangeLabel(r) : '';
  });
  protected readonly lastSignoffText = computed(() => {
    const last = this.check()?.lastSignoff;
    if (!last) {
      return 'none yet';
    }
    return `v${last.toVersion}, ${shortDateTime(last.signedAt)}, ${last.signedByName ?? 'an auditor'}`;
  });

  // ------------------------------------------------ versions

  /** Every committed version, newest first, with its proof status and how far the auditor has got. */
  protected readonly versionRows = computed(() => {
    const check = this.check();
    const lastTo = check?.lastSignoff?.toVersion ?? 0;
    const lastDate = shortDate(check?.lastSignoff?.signedAt);
    const newestFirst = [...(this.history()?.versions ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);
    return newestFirst.map(h => {
      const inRange = check?.versions.find(v => v.versionNumber === h.versionNumber) ?? null;
      const proof = h.anchoring ? proofLabel(h.anchoring.status) : null;
      const state = versionState({
        match: inRange?.match ?? 'matches',
        checked: this.checked().has(h.versionNumber),
        signedOffAt: h.versionNumber <= lastTo ? lastDate : null
      });
      return {
        n: h.versionNumber,
        summary: `Committed ${shortDate(h.committedAt)} · approved by ${h.approvedByName ?? '—'}`,
        proofLabel: inRange ? ANCHORING[inRange.anchoring].label : proof?.label ?? '',
        proofClass: inRange ? toneClass(ANCHORING[inRange.anchoring].tone) : toneClass(proof?.tone ?? 'neutral'),
        state,
        stateClass: 'small tone-' + state.tone,
        on: this.isSelected({ kind: 'version', n: h.versionNumber })
      };
    });
  });

  /** The versions in the open checkpoint whose changes still need checking. */
  protected readonly uncheckedVersions = computed(() => (this.check()?.versions ?? [])
    .filter(v => !v.superseded && !this.checked().has(v.versionNumber))
    .map(v => v.versionNumber));

  // ------------------------------------------------ documents

  /** The version whose documents the table shows: the one picked, or the newest. */
  protected readonly shownN = computed(() => this.shownVersion() ?? this.current());

  /** The version that first pinned each document version ("documentId:version" → n). */
  private readonly addedIn = computed(() => {
    const out = new Map<string, number>();
    for (const v of [...this.versions()].sort((a, b) => a.versionNumber - b.versionNumber)) {
      for (const pin of v.data.documents || []) {
        const key = `${pin.edrmsDocumentId}:${pin.version}`;
        if (!out.has(key)) {
          out.set(key, v.versionNumber);
        }
      }
    }
    return out;
  });

  private readonly allDocRows = computed<DocRow[]>(() => {
    const version = this.versions().find(v => v.versionNumber === this.shownN());
    const check = this.check();
    return (version?.data.documents || []).map(pin => {
      const entry = check?.documents.find(d => d.documentId === pin.edrmsDocumentId && d.version === pin.version) ?? null;
      const findings = this.findings().filter(f => f.documentId === pin.edrmsDocumentId);
      const changed = entry?.match === 'changed' && !entry.superseded;
      const open = findings.filter(f => f.status === 'open').map(f => findingNumber(f.id));
      const matchInfo = entry ? MATCH[entry.match] : { label: 'Checked at an earlier audit', tone: 'neutral' as const };
      return {
        pin,
        addedIn: this.addedIn().get(`${pin.edrmsDocumentId}:${pin.version}`) ?? this.shownN(),
        check: entry,
        findings,
        changed,
        issues: openIssues(changed, open),
        checkLabel: matchInfo.label,
        checkTone: 'tone-' + matchInfo.tone
      };
    });
  });

  protected readonly docCounts = computed(() => {
    const rows = this.allDocRows();
    return {
      attention: rows.filter(r => r.issues.length).length,
      new: rows.filter(r => r.check).length,
      all: rows.length
    };
  });

  /** The documents of the version shown, filtered and searched, grouped by kind. */
  protected readonly docGroups = computed(() => {
    const query = this.docQuery().trim().toLowerCase();
    const filter = this.docFilter();
    const rows = this.allDocRows()
      .filter(r => filter === 'all' || (filter === 'new' ? !!r.check : r.issues.length > 0))
      .filter(r => !query || `${r.pin.ref ?? ''} ${r.pin.edrmsNo} ${r.pin.docType}`.toLowerCase().includes(query));
    const groups = new Map<string, DocRow[]>();
    for (const r of rows) {
      const kind = this.docTypeLabel(r.pin.docType);
      groups.set(kind, [...(groups.get(kind) ?? []), r]);
    }
    return [...groups.entries()].map(([kind, docs]) => ({ kind, docs }));
  });

  protected readonly matchingNew = computed(() => (this.check()?.documents ?? []).filter(d => d.match === 'matches').length);

  // ------------------------------------------------ the selected item

  protected readonly selectedVersion = computed<{ n: number; inRange: CheckVersion | null; earlier: boolean } | null>(() => {
    const s = this.selected();
    if (s.kind !== 'version') {
      return null;
    }
    const inRange = this.check()?.versions.find(v => v.versionNumber === s.n) ?? null;
    return { n: s.n, inRange, earlier: !inRange };
  });

  protected readonly selectedDoc = computed<DocRow | null>(() => {
    const s = this.selected();
    if (s.kind !== 'doc') {
      return null;
    }
    return this.allDocRows().find(r => r.pin.edrmsDocumentId === s.id) ?? null;
  });

  protected readonly selectedDiff = computed(() => {
    const v = this.selectedVersion();
    return v ? this.history()?.versions.find(h => h.versionNumber === v.n)?.diff ?? null : null;
  });

  protected readonly versionLocked = computed(() => {
    const v = this.selectedVersion()?.inRange;
    return v && v.match !== 'matches' ? lockedNote(v.match) : '';
  });

  // ------------------------------------------------ the audit sign-off

  protected readonly checklist = computed(() => {
    const check = this.check();
    if (!check?.range) {
      return [];
    }
    const items = [...check.versions, ...check.documents];
    const notInBlock = items.filter(i => !ANCHORING[i.anchoring].canSignOff);
    const changed = items.filter(i => i.match === 'changed' && !i.superseded);
    const unchecked = this.uncheckedVersions();
    const toCheck = check.versions.filter(v => !v.superseded).length;
    return [
      { label: 'Everything on the blockchain', detail: notInBlock.length ? `${notInBlock.length} items not yet, including ${notInBlock[0].label}` : 'Yes', done: !notInBlock.length },
      { label: 'Everything matches the blockchain', detail: changed.length ? `Changed since review: ${changed.map(i => i.label).join(', ')}` : 'Checked automatically', done: !changed.length && !notInBlock.length },
      { label: 'No open findings', detail: check.openFindings.length ? `${check.openFindings.length} open` : 'None open', done: !check.openFindings.length },
      { label: 'Every version’s changes checked', detail: `${toCheck - unchecked.length} of ${toCheck} · by you`, done: !unchecked.length }
    ];
  });

  /** Findings on a land record version (not on a document): shown in the audit sign-off card. */
  protected readonly recordFindings = computed(() => this.findings().filter(f => !f.documentId));

  protected readonly changedItems = computed(() => [...(this.check()?.versions ?? []), ...(this.check()?.documents ?? [])]
    .filter(i => i.match === 'changed' && !i.superseded)
    .map(i => i.label));

  protected readonly signReason = computed(() => {
    const check = this.check();
    return check ? signoffBlock(check, this.uncheckedVersions()) : null;
  });

  // ------------------------------------------------ the document review

  /** Every document of the version shown, in table order: the review's Previous and Next. */
  private readonly reviewOrder = computed(() => this.allDocRows().map(r => r.pin.edrmsDocumentId));
  protected readonly reviewCount = computed(() => this.reviewOrder().length);
  protected readonly reviewRow = computed(() => this.allDocRows().find(r => r.pin.edrmsDocumentId === this.reviewing()) ?? null);
  protected readonly reviewPosition = computed(() => this.reviewOrder().indexOf(this.reviewing() ?? '') + 1);

  constructor() {
    effect(() => {
      if (this.id()) {
        const id = this.id();
        // only the id starts a load: the signals load() reads must not start it again
        untracked(() => void this.load(id));
      }
    });
  }

  // ------------------------------------------------ actions

  protected select(selection: Selection): void {
    this.selected.set(selection);
    if (selection.kind === 'doc') {
      const row = this.allDocRows().find(r => r.pin.edrmsDocumentId === selection.id);
      this.tab.set(row?.issues.length ? 'issues' : 'proof');
    } else {
      this.tab.set(selection.kind === 'version' && this.selectedVersionMatches(selection.n) ? 'meta' : 'proof');
    }
  }

  protected isSelected(selection: Selection): boolean {
    return JSON.stringify(this.selected()) === JSON.stringify(selection);
  }

  protected pickVersion(n: number): void {
    this.select({ kind: 'version', n });
    this.shownVersion.set(n);
    this.docFilter.set('all');
  }

  protected showNewest(): void {
    this.shownVersion.set(null);
    this.docFilter.set('new');
  }

  protected selectCheckpoint(): void {
    this.select({ kind: 'checkpoint' });
    this.showNewest();
  }

  /** A document type's name, e.g. "SG diagram" for sg_diagram. */
  protected docTypeLabel(id: string): string {
    return this.docTypes().find(t => t.id === id)?.label ?? id.replace(/_/g, ' ');
  }

  /** A document's sealed fields with their names, as the intake catalogue gives them. */
  protected fieldsOf(pin: PinnedDocument): { k: string; v: string }[] {
    const type = this.docTypes().find(t => t.id === pin.docType);
    return Object.entries(pin.fields || {}).map(([k, v]) => ({ k: type?.fields.find(f => f.k === k)?.label ?? k, v }));
  }

  @HostListener('document:keydown.escape')
  protected closeDialog(): void {
    this.raising.set(null);
  }

  protected anchoringText(state: CheckVersion['anchoring']): string {
    return ANCHORING[state].label;
  }

  protected anchoringClass(state: CheckVersion['anchoring']): string {
    return toneClass(ANCHORING[state].tone);
  }

  protected dateTime(iso: string): string {
    return shortDateTime(iso);
  }

  protected markChecked(n: number): void {
    this.checked.update(s => new Set([...s, n]));
  }

  protected typeDocQuery(event: Event): void {
    this.docQuery.set((event.target as HTMLInputElement).value);
  }

  protected review(documentId: string): void {
    this.reviewing.set(documentId);
    this.selected.set({ kind: 'doc', id: documentId });
  }

  protected step(offset: number): void {
    const order = this.reviewOrder();
    const next = order[order.indexOf(this.reviewing() ?? '') + offset];
    if (next) {
      this.review(next);
    }
  }

  protected openRaise(): void {
    const doc = this.selectedDoc();
    const about = doc ? doc.pin.ref || doc.pin.edrmsNo : `${this.record()?.label} · v${this.current()}`;
    this.findingText.set('');
    this.raising.set({ documentId: doc?.pin.edrmsDocumentId ?? null, about });
  }

  protected typeFinding(event: Event): void {
    this.findingText.set((event.target as HTMLTextAreaElement).value);
  }

  protected async raiseFinding(): Promise<void> {
    const target = this.raising();
    if (!target) {
      return;
    }
    await this.act(async () => {
      await this.audit.raiseFinding({
        recordId: this.id(), version: this.current(), description: this.findingText().trim(),
        ...(target.documentId ? { documentId: target.documentId } : {})
      });
      this.raising.set(null);
      this.toast.show('success', 'Finding raised', 'The records officer and the records supervisor each get a task to acknowledge it.');
    });
  }

  protected async replyToFinding(reply: FindingReply): Promise<void> {
    await this.act(async () => {
      if (reply.close) {
        await this.audit.closeFinding(reply.finding.id, reply.close, reply.text);
        this.toast.show('success', 'Finding closed', 'Your answer goes into the audit trail.');
      } else {
        await this.audit.answerFinding(reply.finding.id, reply.text);
        this.toast.show('success', 'Answer added');
      }
    });
  }

  protected async signOff(): Promise<void> {
    const check = this.check();
    if (!check?.range) {
      return;
    }
    const versions = check.versions.map(v => v.label).join(' and ');
    const ok = await this.confirm.ask({
      title: `Sign off ${this.record()?.label}, ${rangeLabel(check.range)}?`,
      body: `You confirm that you checked ${versions}: the documents belong to this land record, nothing is missing, and the record’s details follow from the documents. Every document matches the blockchain. Your sign-off goes into the audit trail and cannot be changed. The next audit starts after v${check.range.to}.`,
      confirmLabel: 'Sign off'
    });
    if (!ok) {
      return;
    }
    await this.act(async () => {
      await this.audit.signOff(this.id());
      this.checked.set(new Set());
      this.toast.show('success', 'Audit signed off', 'It goes on the blockchain with the next batch.');
    });
  }

  protected async exportPack(): Promise<void> {
    await this.act(async () => {
      const pack = await this.audit.evidence(this.id());
      const link = document.createElement('a');
      link.href = URL.createObjectURL(pack.blob);
      link.download = pack.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      this.exported.set({ fileName: pack.fileName, checksum: pack.manifestSha256 });
    }, false);
  }

  // ------------------------------------------------ loading

  private selectedVersionMatches(n: number): boolean {
    return this.check()?.versions.find(v => v.versionNumber === n)?.match === 'matches';
  }

  /** Run an action, then read everything again; a refusal is shown as the server words it. */
  private async act(fn: () => Promise<void>, reload = true): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
      if (reload) {
        await this.load(this.id());
      }
      this.trailKey.update(k => k + 1);
    } catch (e) {
      this.toast.show('danger', 'Not done', (e as Error).message, 8000);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(id: string): Promise<void> {
    if (!this.docTypes().length) {
      this.intake.catalogue().then(c => this.docTypes.set(c.docTypes), () => {});
    }
    try {
      const [record, check, history, findings] = await Promise.all([
        this.records.get(id), this.audit.check(id), this.records.history(id), this.audit.findings(id)
      ]);
      const numbers = history.versions.map(v => v.versionNumber);
      const versions = await Promise.all(numbers.map(n => this.records.version(id, n)));
      this.record.set(record);
      this.check.set(check);
      this.history.set(history);
      this.versions.set(versions);
      this.findings.set(findings.items);
      this.error.set(null);
      this.audit.verifyTrail().then(r => this.chainIntact.set(r.intact), () => this.chainIntact.set(null));
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }
}
