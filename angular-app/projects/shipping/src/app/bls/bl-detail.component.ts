import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {DatePipe} from '@angular/common';
import {Router, RouterLink} from '@angular/router';
import {
  AuthService,
  ConfirmService,
  ToastService,
  toApiError,
} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {BlAmendComponent} from './bl-amend.component';
import {BlCheckComponent} from './bl-check.component';
import {
  approvalOf,
  issueCommands,
  mayArchive,
  mayEdit,
  maySubmit,
  versionNote,
} from './bl-actions';
import {
  type CloseCommand,
  closeCommands,
  closeConfirmation,
  closeNote,
  closeRequest,
} from './bl-close';
import {
  ASK_FOR_CHANGE,
  askForChangeQuestion,
  mayAmend,
  mayAskForChange,
  maySplit,
  pastHolderNote,
  refusalOf,
  seesVersions,
} from './bl-change';
import {
  type EndorseMode,
  type HandOver,
  endorseConfirmation,
  endorseStatus,
  endorseeChoices,
  endorsementLabel,
  handOverWords,
  mayAcceptIncoming,
  mayEndorse,
  mayRetryTransfer,
  mayTransfer,
  mayTransferOut,
} from './bl-endorse';
import {
  type SettlementCommand,
  settlementCommands,
  settlementQuestion,
  titleNote,
} from './bl-surrender';
import {
  carrierOf,
  chainRows,
  changeHolderLabel,
  changeRequestNote,
  consigneeLabel,
  draftFacts,
  interopTitleNote,
  kindLabel,
  partyLabel,
  rolesLabel,
  stateLabel,
  stateTone,
  toneTagClass,
  versionHistory,
} from './bl-format';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {DEFAULT_MAX_SPLIT_PARTS} from './bl-split';
import {BlSplitComponent} from './bl-split.component';
import type {
  BlRecord,
  BlTitleView,
  ConnectedPlatform,
  PartyLookupResult,
  PartyOrganisation,
} from './bl.model';
import {LatestRequest} from './latest';
import {injectViewer} from './viewer';

/** The buttons of the title commands this page offers (CB-44: the issue). */
const COMMAND_LABELS: ReadonlyMap<string, string> = new Map([
  ['issue', 'Issue to the shipper'],
]);

/** The carrier's panels of a change (CB-50): amend the B/L, or split it into new B/Ls. */
type ChangePanel = 'amend' | 'split';

/** What a toast says once a title command is done. */
const COMMAND_DONE: ReadonlyMap<string, string> = new Map([
  ['issue', 'B/L issued'],
]);

/**
 * The page of one B/L (`#/bls/:id`, CB-42): its reference, kind, state, holder, the user's
 * organisation's roles on it and its chain of title. Its "actions" section (CB-44) offers what the
 * user may do now: submit the draft for approval, approve it as the second person of the carrier
 * (never its drafter: the drafter is told so) and issue it to the shipper, from the title's
 * allowedCommands; the other commands come with CB-45..46. Before issue the carrier also sees, in
 * the "Approval" panel, the version being approved and then issued: the organisations it is linked
 * to by name, with a warning where the document names a party otherwise (review of CB-44).
 * The holder endorses the B/L to a named organisation (CB-45, from the CB-12 design): "Endorse
 * to…" opens the "Endorse" panel, where it picks a registered organisation (not its own, not the
 * holder) and confirms; that organisation becomes the holder at once and the chain gains the step.
 * The holder may endorse in blank instead, still to the organisation picked; the holder of a
 * blank-endorsed B/L then transfers it on with "Transfer to…", in the same panel (CB-52).
 * At the end of the journey (CB-46, from the CB-13 design, good weather) the holder surrenders the
 * B/L to the carrier, which then holds it, and the carrier releases the goods: the B/L is
 * accomplished, with no holder and nothing more to do. Both are confirmed first; a note in the
 * B/L box says where it stands, read out as it changes.
 * Once issued, "Check this B/L" (CB-47, bl-check.component.ts) checks the chain of title in the
 * browser, says whether its latest step is on the blockchain and gives the proof to check offline.
 * A change of the B/L (CB-50, first version, from the CB-14 design): the holder asks the carrier
 * for a change ("Ask for a change", confirmed first); the carrier, which then holds the B/L, opens
 * "Amend" (bl-amend.component.ts: the next version, same number) or "Split" (bl-split.component.ts:
 * new B/Ls, the cargo shared out), and the B/L, or its new B/Ls, go back to the holder. The B/L
 * box shows the version and the versions to those who hold it, "Split from" and "Replaced by"
 * with links; an earlier holder is told it was amended or split after it held it, never the new
 * values (the record service gives it none).
 */
@Component({
  selector: 'app-bl-detail',
  imports: [
    RouterLink,
    DatePipe,
    BlAmendComponent,
    BlCheckComponent,
    BlSplitComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <a class="small" routerLink="/">← Bills of lading</a>
      @if (error(); as e) {
        <div class="note danger" role="alert">{{ e }}</div>
      } @else if (view(); as v) {
        <header class="row" style="justify-content:space-between;align-items:flex-end">
          <div>
            <h1 style="margin:4px 0 4px;font-size:32px">{{ v.record.label }}</h1>
            <span [class]="'tag ' + tagClass()">{{ state() }}</span>
          </div>
          <!-- the actions on the B/L: CB-44 the draft's and the issue, CB-45 the endorsement,
               CB-46 the surrender and the release -->
          <section class="actions row" aria-label="Actions">
            @if (canEdit()) {
              <a class="btn btn-secondary" [routerLink]="['/bls', v.recordId, 'edit']">Edit</a>
            }
            @if (canSubmit()) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="submit()">Submit for approval</button>
            }
            @if (canArchive()) {
              <button type="button" class="btn btn-danger" [disabled]="busy()" (click)="archive()">Archive</button>
            }
            @if (approval() === 'approve') {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="approve()">Approve</button>
            }
            @for (c of commands(); track c.name) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="run(c.name)">{{ c.label }}</button>
            }
            @if (canEndorse() && !endorsing()) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="openEndorse('endorse')" #endorseOpen>Endorse to…</button>
            }
            @if (canAcceptIncoming()) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="acceptIncoming()">Keep this B/L</button>
            }
            @if (canRetryTransfer()) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="retryTransfer()">Retry transfer</button>
            }
            <!-- CB-52: the holder of a blank-endorsed B/L transfers it on -->
            @if (canTransfer() && !endorsing()) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="openEndorse('transfer')" #transferOpen>Transfer to…</button>
            }
            @for (s of settlements(); track s.name) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="settle(s)">{{ s.label }}</button>
            }
            <!-- CB-50: the holder asks for a change; the carrier amends or splits the B/L -->
            @if (canAskForChange()) {
              <button type="button" class="btn btn-secondary" [disabled]="busy()" (click)="askForChange()">{{ askLabel }}</button>
            }
            @if (canAmend() && changing() === null) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="openChange('amend')">Amend</button>
            }
            @if (canSplit() && changing() === null) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="openChange('split')">Split</button>
            }
            <!-- CB-51: the holder switches the B/L to paper; the carrier voids it -->
            @for (c of closings(); track c.name) {
              <button type="button" class="btn btn-danger" [disabled]="busy()" (click)="close(c)">{{ c.label }}</button>
            }
          </section>
        </header>
        @if (actionError(); as e) {
          <div class="note danger" role="alert">{{ e }}</div>
        }
        @if (commands().length > 0) {
          <p class="note info" role="note">Issuing signs the B/L for your organisation and cannot be undone: the shipper becomes its first holder.</p>
        }
        @if (handOverOpen()) {
          <section class="panel" [attr.aria-label]="panelWords().region" #endorsePanel>
            <div class="panel-head"><h2 tabindex="-1">{{ panelWords().heading }}</h2></div>
            <div class="panel-body stack" style="gap:12px">
              @if (handOver() === 'endorse' && canTransferOut() && platforms().length > 0) {
                <div class="field" role="radiogroup" aria-label="Endorse target">
                  <span class="label">Where</span>
                  <div class="row" style="gap:12px">
                    <label class="choice">
                      <input type="radio" name="bl-endorse-target" value="local" [checked]="endorseTarget() === 'local'" (change)="pickEndorseTarget('local')" />
                      A party on this platform
                    </label>
                    <label class="choice">
                      <input type="radio" name="bl-endorse-target" value="external" [checked]="endorseTarget() === 'external'" (change)="pickEndorseTarget('external')" />
                      A party on another platform
                    </label>
                  </div>
                </div>
              }
              @if (endorseTarget() === 'external') {
                <div class="stack" style="gap:10px">
                  <div class="field">
                    <label for="bl-peer-platform">Platform</label>
                    <select id="bl-peer-platform" class="input" [value]="peerPlatform()" (change)="pickPeerPlatform($any($event.target).value)">
                      <option value="">Pick a platform</option>
                      @for (p of platforms(); track p.code) {
                        <option [value]="p.code" [selected]="p.code === peerPlatform()">{{ p.name }} ({{ p.code }})</option>
                      }
                    </select>
                  </div>
                  <div class="row" style="align-items:flex-end;gap:10px">
                    <div class="field" style="flex:1;min-width:200px">
                      <label for="bl-peer-party">Party code at that platform</label>
                      <input id="bl-peer-party" class="input mono" autocomplete="off" [value]="peerPartyCode()" (input)="setPeerPartyCode($any($event.target).value)" />
                    </div>
                    <button type="button" class="btn btn-secondary" [disabled]="busy() || checkingPeer() || !peerPlatform() || !peerPartyCode().trim()" (click)="checkPeerReceiver()">{{ checkingPeer() ? 'Checking…' : 'Check receiver' }}</button>
                  </div>
                  @if (peerLookupError(); as lookupError) {
                    <div class="note danger" role="alert">{{ lookupError }}</div>
                  }
                  @if (peerLookup(); as verified) {
                    <div class="note info" role="status">
                      <strong>{{ verified.partyName }}</strong> — confirmed by {{ verified.platformName }}. The other platform and receiver will see this B/L and its full history.
                    </div>
                  }
                  <div class="row" style="gap:8px">
                    <button type="button" class="btn btn-primary" [disabled]="busy() || !peerLookup()" (click)="sendExternal()">Send to platform</button>
                    <button type="button" class="btn btn-secondary" [disabled]="busy()" (click)="cancelEndorse()">Cancel</button>
                  </div>
                </div>
              } @else {
                @if (endorseeError(); as e) {
                  <div class="note danger" role="alert">{{ e }}</div>
                } @else if (endorsees(); as list) {
                  @if (list.length > 0) {
                    <div class="field" role="radiogroup" aria-labelledby="bl-endorsee-label" aria-describedby="bl-endorsee-hint">
                      <span id="bl-endorsee-label" class="label">{{ panelWords().pickLabel }}</span>
                      @for (o of list; track o.id) {
                        <label class="choice">
                          <input type="radio" name="bl-endorsee" [value]="o.id" [checked]="o.id === endorsee()" (change)="pickEndorsee(o.id)" />
                          {{ o.name }}
                        </label>
                      }
                      <span id="bl-endorsee-hint" class="small muted">Organisations registered on the platform.</span>
                    </div>
                    <!-- CB-52: by name or in blank, for an endorsement only -->
                    @if (handOver() === 'endorse') {
                      <div class="field" role="radiogroup" aria-labelledby="bl-endorse-mode-label">
                        <span id="bl-endorse-mode-label" class="label">How</span>
                        <label class="choice">
                          <input type="radio" name="bl-endorse-mode" value="named" [checked]="endorseMode() === 'named'" (change)="pickMode('named')" />
                          To this organisation by name
                        </label>
                        <label class="choice">
                          <input type="radio" name="bl-endorse-mode" value="blank" [checked]="endorseMode() === 'blank'" (change)="pickMode('blank')" />
                          In blank (the B/L names no holder by endorsement)
                        </label>
                      </div>
                    }
                  }
                }
                <!-- present from the start, filled as the panel changes, so that it is read out -->
                <p [class]="endorseStatusClass()" role="status" aria-live="polite" style="margin:0">{{ endorseStatusText() }}</p>
                <div class="row" style="gap:8px">
                  <button type="button" class="btn btn-primary" [disabled]="busy() || endorsee() === ''" (click)="endorse()">{{ panelWords().send }}</button>
                  <button type="button" class="btn btn-secondary" [disabled]="busy()" (click)="cancelEndorse()">Cancel</button>
                </div>
              }
            </div>
          </section>
        }
        @if (changeDocument(); as document) {
          @if (changing() === 'amend' && canAmend()) {
            <app-bl-amend [recordId]="v.recordId" [recordNo]="v.record.recordNo" [carrierCode]="v.record.carrierCode" [version]="currentVersion()" [document]="document" [holderName]="returnToName()" (amended)="changeDone()" (stale)="changeStale($event)" (cancelled)="closeChange()" />
          }
          @if (changing() === 'split' && canSplit()) {
            <app-bl-split [recordId]="v.recordId" [recordNo]="v.record.recordNo" [document]="document" [holderName]="returnToName()" [maxParts]="v.maxSplitChildren ?? defaultMaxSplitParts" (split)="changeDone()" (stale)="changeStale($event)" (cancelled)="closeChange()" />
          }
        }
        @if (shown()) {
          <section class="panel" aria-label="Approval">
            <div class="panel-head"><h2>Approval</h2></div>
            <div class="panel-body stack" style="gap:12px">
              <p [class]="noteClass()" role="status" style="margin:0"><strong>{{ panelNote() }}</strong></p>
              <dl class="kv facts">
                @for (f of facts(); track f.label) {
                  <dt>{{ f.label }}</dt>
                  <dd>
                    {{ f.value }}
                    @if (f.warning) {
                      <span class="warn" role="note">{{ f.warning }}</span>
                    }
                  </dd>
                }
              </dl>
            </div>
          </section>
        }
        <section class="panel">
          <div class="panel-head"><h2>B/L</h2></div>
          <div class="panel-body">
            <!-- present from the start, filled once the B/L is surrendered, so that it is read out -->
            <p [class]="titleNoteClass()" role="status" aria-live="polite" tabindex="-1" #titleNote>{{ titleNoteText() }}</p>
            @if (pastNote(); as n) {
              <p class="title-note note" role="note">{{ n.message }} ({{ n.at | date: 'd MMM y' }}).</p>
            }
            <dl class="kv facts">
              <dt>Reference</dt><dd class="mono">{{ v.record.recordNo }}</dd>
              <dt>Carrier code</dt><dd class="mono">{{ v.record.carrierCode }}</dd>
              <dt>Kind</dt><dd>{{ kind() }}</dd>
              <dt>State</dt><dd>{{ state() }}</dd>
              <dt>Your role</dt><dd>{{ roles() }}</dd>
              <dt>Carrier</dt><dd>{{ carrier() }}</dd>
              <dt>Holder</dt><dd>{{ holder() }}</dd>
              @if (endorsementText(); as endorsed) {
                <dt>Endorsement</dt><dd>{{ endorsed }}</dd>
              }
              <dt>Consignee</dt><dd>{{ consignee() }}</dd>
              @if (latestVersion(); as latest) {
                <dt>Version</dt>
                <dd>
                  Version {{ latest.version }} since {{ latest.at | date: 'd MMM y, HH:mm' }}
                  @if (versions().length > 1) {
                    <ul class="versions" aria-label="Versions">
                      @for (line of versions(); track line.version) {
                        <li>Version {{ line.version }}, {{ line.at | date: 'd MMM y, HH:mm' }}</li>
                      }
                    </ul>
                  }
                </dd>
              }
              @if (v.splitFrom; as parent) {
                <dt>Split from</dt>
                <dd><a class="mono" [routerLink]="['/bls', parent.recordId]">{{ parent.recordNo }}</a></dd>
              }
              @if (splitInto().length > 0) {
                <dt>Replaced by</dt>
                <dd>
                  @for (child of splitInto(); track child.recordId; let last = $last) {
                    <a class="mono" [routerLink]="['/bls', child.recordId]">{{ child.recordNo }}</a>@if (!last) {<span>, </span>}
                  }
                </dd>
              }
            </dl>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head row" style="justify-content:space-between;gap:8px">
            <h2>Chain of title</h2>
            @if (v.chain.length > 0) {
              <a class="btn btn-secondary" [routerLink]="['/bls', v.recordId, 'history']">Full history and checks</a>
            }
          </div>
          <div style="overflow-x:auto">
            <table class="table" aria-label="Chain of title">
              <thead>
                <tr><th>Step</th><th>What</th><th>From</th><th>To</th><th>By</th><th>When</th></tr>
              </thead>
              <tbody>
                @for (r of chain(); track r.seq) {
                  <tr>
                    <td class="num">{{ r.seq }}</td>
                    <td>{{ r.step }}</td>
                    <td>{{ r.from }}</td>
                    <td>{{ r.to }}</td>
                    <td>{{ r.by }}</td>
                    <td class="num">{{ r.at | date: 'd MMM y, HH:mm' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="muted" style="padding:22px 16px">No steps yet: the chain of title starts when the B/L is issued.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
        <!-- CB-47: the chain checked, the proof on the blockchain and its file, once issued -->
        @if (v.title !== null) {
          <app-bl-check [recordId]="v.recordId" [recordNo]="v.record.recordNo" [latestSeq]="chain().length" [names]="v.organisationNames" />
        }
      } @else {
        <p class="muted" role="status">Loading…</p>
      }
    </div>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .panel-head h2 { margin: 0; font-size: 18px; }
    .panel-body { padding: 16px; }
    .facts { margin: 0; }
    .facts dd { margin: 0; }
    .actions:empty { display: none; }
    .actions { gap: 8px; }
    .note.info { background: var(--color-neutral-100, #f4f6f8); border: 1px solid var(--color-divider); }
    .note:not(.danger):not(.info) { border: 1px solid var(--color-divider); }
    .field { display: grid; gap: 6px; max-width: 520px; }
    .field .label { font-weight: 600; font-size: 13px; }
    .choice { display: flex; gap: 8px; align-items: center; cursor: pointer; }
    .title-note { margin: 0 0 12px; }
    .warn { display: block; margin-top: 2px; font-size: 13px; color: var(--danger-fg); }
    .versions { margin: 4px 0 0; padding-left: 18px; font-size: 13px; }
  `,
  ],
})
export class BlDetailComponent {
  /** The B/L's id, from the route. */
  readonly id = input.required<string>();

  private readonly bls = inject(BlApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly viewer = injectViewer();
  private readonly latest = new LatestRequest();
  /** The latest listing of the organisations to endorse to (CB-45 review). */
  private readonly latestEndorsees = new LatestRequest();
  private readonly injector = inject(Injector);
  /** The "Endorse to…" button and the "Endorse" panel, to move the focus (CB-45 review). */
  private readonly endorseOpen =
    viewChild<ElementRef<HTMLButtonElement>>('endorseOpen');
  /** The "Transfer to…" button, to give the focus back (CB-52). */
  private readonly transferOpen =
    viewChild<ElementRef<HTMLButtonElement>>('transferOpen');
  private readonly endorsePanel =
    viewChild<ElementRef<HTMLElement>>('endorsePanel');
  /** The note on where the B/L stands, which takes the focus after a surrender or release. */
  private readonly titleNoteRef =
    viewChild<ElementRef<HTMLElement>>('titleNote');
  /** The page, to move the focus into a panel of a change (CB-50). */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly view = signal<BlTitleView | null>(null);
  /** The B/L's record with its open draft, before issue and for its own organisation only. */
  protected readonly record = signal<BlRecord | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  /** Whether the "Endorse" panel is open (CB-45). */
  protected readonly endorsing = signal(false);
  /** The organisations the holder may endorse to; null while they load. */
  protected readonly endorsees = signal<PartyOrganisation[] | null>(null);
  /** Why the organisations cannot be listed, null when they can. */
  protected readonly endorseeError = signal<string | null>(null);
  /** The id of the organisation picked, '' for none. */
  protected readonly endorsee = signal('');
  /** What the open panel does: endorse, or transfer a blank-endorsed B/L (CB-52). */
  protected readonly handOver = signal<HandOver>('endorse');
  /** How the holder endorses: by name or in blank (CB-52). */
  protected readonly endorseMode = signal<EndorseMode>('named');

  /** The carrier's open panel of a change, null for none (CB-50). */
  protected readonly changing = signal<ChangePanel | null>(null);
  /** The holder's button that asks for a change. */
  protected readonly askLabel = ASK_FOR_CHANGE.label;
  /** Default maximum number of new B/Ls per split (CB-73). */
  protected readonly defaultMaxSplitParts = DEFAULT_MAX_SPLIT_PARTS;

  /** The organisations' names by id, for the parties the version is linked to. */
  private readonly names = signal<Record<string, string>>({});

  /** Whether the B/L is issued: its record, if read, is then for a change only (CB-50). */
  private readonly issued = computed(() => !!this.view()?.title);
  /** Whether this B/L is an archived draft (CB-71). */
  private readonly archived = computed(
    () => this.view()?.record.status === 'archived',
  );
  /** The open draft, when the user's organisation drafts this B/L. */
  private readonly draft = computed(() =>
    this.issued() || this.archived() ? null : (this.record()?.draft ?? null),
  );
  /** The version the panel shows before issue: the open draft, else the approved one. */
  protected readonly shown = computed(() => {
    if (this.issued() || this.archived()) {
      return null;
    }
    return this.record()?.draft ?? this.record()?.current ?? null;
  });
  /** Who looks at the B/L: their id and permissions. */
  private readonly user = computed(() => ({
    id: this.auth.me()?.user.id ?? '',
    perms: this.auth.perms(),
  }));
  protected readonly approval = computed(() =>
    approvalOf(this.draft(), this.user()),
  );
  protected readonly panelNote = computed(() => {
    const version = this.shown();
    if (version === null) {
      return '';
    }
    return versionNote(version, this.user());
  });
  protected readonly noteClass = computed(() => {
    const ready = this.shown()?.state === 'committed';
    if (ready || this.approval() === 'approve') {
      return 'note info';
    }
    return 'note';
  });
  protected readonly facts = computed(() =>
    draftFacts(this.shown(), this.names()),
  );
  protected readonly canEdit = computed(
    () => !this.issued() && mayEdit(this.draft(), this.user()),
  );
  protected readonly canSubmit = computed(() =>
    maySubmit(this.draft(), this.auth.perms()),
  );
  protected readonly canArchive = computed(
    () => !this.issued() && mayArchive(this.blState(), this.auth.perms()),
  );
  protected readonly canEndorse = computed(() =>
    mayEndorse(this.view()?.allowedCommands ?? []),
  );
  protected readonly canTransferOut = computed(() =>
    mayTransferOut(this.view()?.allowedCommands ?? []),
  );
  protected readonly canAcceptIncoming = computed(() =>
    mayAcceptIncoming(this.view()?.allowedCommands ?? []),
  );
  protected readonly canRetryTransfer = computed(() =>
    mayRetryTransfer(
      this.view()?.title?.state,
      this.view()?.roles ?? [],
      this.auth.perms(),
    ),
  );
  protected readonly platforms = signal<ConnectedPlatform[]>([]);
  protected readonly endorseTarget = signal<'local' | 'external'>('local');
  protected readonly peerPlatform = signal('');
  protected readonly peerPartyCode = signal('');
  protected readonly peerLookup = signal<PartyLookupResult | null>(null);
  protected readonly peerLookupError = signal<string | null>(null);
  protected readonly checkingPeer = signal(false);
  /** The name of the organisation picked, '' for none. */
  protected readonly endorseeName = computed(() => {
    const picked = this.endorsees()?.find(o => o.id === this.endorsee());
    return picked?.name ?? '';
  });
  /** Whether the user may transfer the blank-endorsed B/L (CB-52). */
  protected readonly canTransfer = computed(() =>
    mayTransfer(this.view()?.allowedCommands ?? []),
  );
  /** Whether the panel is open and what it does is still offered (CB-52). */
  protected readonly handOverOpen = computed(() => {
    if (!this.endorsing()) {
      return false;
    }
    if (this.handOver() === 'transfer') {
      return this.canTransfer();
    }
    return this.canEndorse();
  });
  /** The mode the confirmation speaks of: a transfer hands over like a named endorsement. */
  private readonly confirmedMode = computed<EndorseMode>(() => {
    if (this.handOver() === 'transfer') {
      return 'named';
    }
    return this.endorseMode();
  });
  /** What the panel's region, heading, list and button say (CB-52). */
  protected readonly panelWords = computed(() => {
    if (this.handOver() === 'transfer') {
      return {
        region: 'Transfer',
        heading: 'Transfer to another organisation',
        pickLabel: 'Transfer to',
        send: 'Transfer',
      };
    }
    return {
      region: 'Endorse',
      heading: 'Endorse to an organisation',
      pickLabel: 'Endorse to',
      send: 'Endorse',
    };
  });
  /** What the page says of the B/L's endorsement, '' before issue (CB-52). */
  protected readonly endorsementText = computed(() =>
    endorsementLabel(this.view()?.title?.endorsement ?? null),
  );
  protected readonly confirmation = computed(() =>
    endorseConfirmation(this.endorseeName(), this.confirmedMode()),
  );
  /** What the panel announces: loading, nobody to pick, or what happens. */
  protected readonly endorseStatusText = computed(() => {
    if (this.endorseeError() !== null) {
      return '';
    }
    return endorseStatus(
      this.endorsees(),
      this.endorseeName(),
      this.confirmedMode(),
    );
  });
  protected readonly endorseStatusClass = computed(() => {
    if (this.endorseeName() !== '') {
      return 'status note info';
    }
    return 'status muted';
  });
  protected readonly commands = computed(() =>
    issueCommands(this.view()?.allowedCommands ?? []).map(name => ({
      name,
      label: COMMAND_LABELS.get(name) ?? name,
    })),
  );

  /** The holder may ask for a change; the carrier may then amend or split the B/L (CB-50). */
  protected readonly canAskForChange = computed(() =>
    mayAskForChange(this.view()?.allowedCommands ?? []),
  );
  protected readonly canAmend = computed(() =>
    mayAmend(this.view()?.allowedCommands ?? []),
  );
  protected readonly canSplit = computed(() =>
    maySplit(this.view()?.allowedCommands ?? []),
  );
  /** The current version's document, for the carrier's panels of a change; null without one. */
  protected readonly changeDocument = computed(() => {
    if (!this.issued()) {
      return null;
    }
    return this.record()?.current?.data?.document ?? null;
  });
  /** The current version's number. */
  protected readonly currentVersion = computed(
    () => this.record()?.current?.versionNumber ?? 1,
  );
  /** The name of the holder the B/L goes back to after a change. */
  protected readonly returnToName = computed(() =>
    partyLabel(
      this.view()?.title?.returnTo,
      this.viewer(),
      this.view()?.organisationNames,
    ),
  );
  /** The versions of the B/L, for those who hold it; none for the others. */
  protected readonly versions = computed(() => {
    const v = this.view();
    if (v === null || !seesVersions(v.roles, v.title, this.viewer())) {
      return [];
    }
    return versionHistory(v.chain, v.title?.issuedVersion ?? 1);
  });
  protected readonly latestVersion = computed(
    () => this.versions().at(-1) ?? null,
  );
  /** The B/Ls the B/L was split into. */
  protected readonly splitInto = computed(() => this.view()?.splitInto ?? []);
  /** What an earlier holder is told of a change after it held the B/L. */
  protected readonly pastNote = computed(() => {
    const v = this.view();
    if (v === null) {
      return null;
    }
    return pastHolderNote(v.chain, v.roles, this.viewer(), this.splitInto());
  });

  /** The surrender for the holder, the release for the carrier of a surrendered B/L (CB-46). */
  protected readonly settlements = computed(() =>
    settlementCommands(this.view()?.allowedCommands ?? []),
  );
  /** The switch to paper for the holder, the void for the carrier (CB-51). */
  protected readonly closings = computed(() =>
    closeCommands(this.view()?.allowedCommands ?? []),
  );
  /**
   * Where the B/L stands once surrendered, accomplished, switched to paper or void, or held for
   * a change; '' else.
   */
  protected readonly titleNoteText = computed(() => {
    const v = this.view();
    if (this.archived()) {
      return 'Archived: this draft is closed and no longer appears in the B/L list.';
    }
    const state = v?.title?.state ?? null;
    const platformNames: Record<string, string> = {};
    for (const platform of this.platforms()) {
      platformNames[platform.code] = platform.name;
    }
    const interop = interopTitleNote(v?.title, platformNames);
    if (interop !== '') {
      return interop;
    }
    const ended = titleNote(state) || closeNote(state);
    if (ended !== '' || v === null) {
      return ended;
    }
    return changeRequestNote(v.title, this.viewer(), v.organisationNames);
  });
  /** The note's look: an information note once there is something to say, else none. */
  protected readonly titleNoteClass = computed(() => {
    if (this.titleNoteText() === '') {
      return '';
    }
    return 'title-note note info';
  });

  /** The B/L's state as the list gives it, from the title view. */
  private readonly blState = computed(() => {
    const v = this.view();
    if (v === null) {
      return null;
    }
    return {
      status: v.record.status,
      draftState: v.record.draftState,
      title: v.title,
    };
  });

  protected readonly state = computed(() => {
    const s = this.blState();
    return s === null ? '' : stateLabel(s);
  });
  protected readonly tagClass = computed(() => {
    const s = this.blState();
    return s === null ? 'tag-neutral' : toneTagClass(stateTone(s));
  });
  /**
   * A fact of the version shown, before issue: the B/L box says what the panel says.
   * @param label the fact's label
   * @return its value, or null
   */
  private factOf(label: string): string | null {
    return this.facts().find(f => f.label === label)?.value ?? null;
  }

  protected readonly kind = computed(() => {
    const title = this.view()?.title;
    if (title) {
      return kindLabel(title.kind);
    }
    return this.factOf('Kind') ?? kindLabel(null);
  });
  /** The viewer's role; the holder who asked for a change is told the B/L comes back to it. */
  protected readonly roles = computed(() => {
    const v = this.view();
    const roles = v?.roles ?? [];
    const organisationId = this.viewer().organisationId;
    const waitsForIt =
      !!organisationId &&
      v?.title?.returnTo === organisationId &&
      !roles.includes('holder');
    return waitsForIt
      ? 'Asked for a change: the B/L comes back to you'
      : rolesLabel(roles);
  });
  protected readonly carrier = computed(() => {
    const v = this.view();
    if (v === null) {
      return '';
    }
    return partyLabel(
      carrierOf(v, this.viewer()),
      this.viewer(),
      v.organisationNames,
    );
  });
  protected readonly holder = computed(() => {
    const v = this.view();
    const held = changeHolderLabel(
      v?.title ?? null,
      this.viewer(),
      v?.organisationNames,
    );
    if (held !== null) {
      return held;
    }
    return partyLabel(v?.title?.holder, this.viewer(), v?.organisationNames);
  });
  protected readonly consignee = computed(() => {
    const title = this.view()?.title;
    if (!title) {
      const planned = this.factOf('Consignee');
      if (planned !== null) {
        return planned;
      }
    }
    return consigneeLabel(
      title ?? null,
      this.viewer(),
      this.view()?.organisationNames,
    );
  });
  protected readonly chain = computed(() => {
    const v = this.view();
    return chainRows(v?.chain ?? [], this.viewer(), v?.organisationNames, {
      issuedVersion: v?.title?.issuedVersion,
      splitInto: v?.splitInto,
      splitFrom: v?.splitFrom,
    });
  });

  constructor() {
    effect(() => {
      const id = this.id();
      // only the id is followed: load() reads the view, and following it would load the B/L
      // again after every load, without end (found by the CB-45 refusal test)
      untracked(() => {
        void this.load(id);
      });
    });
  }

  /**
   * Archives a never-issued draft after confirmation and returns to the B/L list (CB-71).
   * @return when archived
   */
  protected async archive(): Promise<void> {
    const label = this.view()?.record.label ?? 'this B/L';
    const confirmed = await this.confirm.ask({
      title: `Archive ${label}?`,
      body: 'This draft will leave the B/L list and can no longer be edited, submitted or issued. Its number will be free to use again.',
      confirmLabel: 'Archive draft',
      tone: 'danger',
    });
    if (!confirmed) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await this.bls.archive(this.id());
      this.toast.show('success', 'Draft archived', label);
      await this.router.navigate(['/']);
    } catch (e) {
      const refusal = refusalOf(toApiError(e));
      if (refusal.reload) {
        await this.load(this.id());
      }
      this.actionError.set(refusal.message);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Submits the draft for approval by a second person.
   * @return when the page shows it
   */
  protected async submit(): Promise<void> {
    const draft = this.draft();
    if (draft === null) {
      return;
    }
    await this.act('Submitted for approval', () =>
      this.bls.submit(this.id(), draft.versionNumber),
    );
  }

  /**
   * Approves the draft in review, as the second person of the carrier.
   * @return when the page shows it
   */
  protected async approve(): Promise<void> {
    const draft = this.draft();
    if (draft === null) {
      return;
    }
    await this.act('Draft approved', () =>
      this.bls.approve(this.id(), draft.versionNumber, draft.revision),
    );
  }

  /**
   * Runs a title command on the B/L.
   * @param command the command's name
   * @return when the page shows it
   */
  protected async run(command: string): Promise<void> {
    await this.act(COMMAND_DONE.get(command) ?? 'Done', () =>
      this.bls.command(this.id(), command),
    );
  }

  /**
   * Surrenders the B/L to the carrier, or releases its goods, once the user confirms what
   * happens; the focus then moves to the note on where the B/L stands. A refusal is shown, and
   * the B/L is read again (someone may have done it first).
   * @param command the surrender or the release
   * @return when the page shows the B/L again
   */
  protected async settle(command: SettlementCommand): Promise<void> {
    const label = this.view()?.record.label ?? '';
    const confirmed = await this.confirm.ask({
      title: settlementQuestion(command.name, label),
      body: command.body,
      confirmLabel: command.confirmLabel,
    });
    if (!confirmed) {
      return;
    }
    const done = await this.act(command.done, () =>
      this.bls.command(this.id(), command.name),
    );
    if (!done) {
      await this.load(this.id());
      return;
    }
    this.focusAfterRender(() => {
      this.titleNoteRef()?.nativeElement.focus();
    });
  }

  /**
   * Switches the B/L to paper, or voids it, once the user confirms what happens (for a
   * blank-endorsed B/L, that the paper is a bearer document); the focus then moves to the note on
   * where the B/L stands. A refusal is shown in plain words, and the B/L is read again.
   * @param command the switch to paper or the void
   * @return when the page shows the B/L again
   */
  protected async close(command: CloseCommand): Promise<void> {
    const endorsement = this.view()?.title?.endorsement ?? null;
    const asked = closeConfirmation(
      command.name,
      this.view()?.record.label ?? '',
      endorsement,
    );
    const confirmed = await this.confirm.ask({...asked, tone: 'danger'});
    if (!confirmed) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await this.bls.close(
        this.id(),
        command.name,
        closeRequest(command.name, endorsement),
      );
      this.toast.show('success', command.done, this.view()?.record.label ?? '');
    } catch (e) {
      this.actionError.set(refusalOf(toApiError(e)).message);
      return;
    } finally {
      this.busy.set(false);
      await this.load(this.id());
    }
    this.focusAfterRender(() => {
      this.titleNoteRef()?.nativeElement.focus();
    });
  }

  /**
   * Asks the carrier for a change once the holder confirms what happens: the carrier then holds
   * the B/L; the focus moves to the note on where it stands. A refusal is shown in plain words,
   * and the B/L is read again (someone may have acted first).
   * @return when the page shows the B/L again
   */
  protected async askForChange(): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: askForChangeQuestion(this.view()?.record.label ?? ''),
      body: ASK_FOR_CHANGE.body,
      confirmLabel: ASK_FOR_CHANGE.confirmLabel,
    });
    if (!confirmed) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await this.bls.command(this.id(), 'surrender-for-amendment');
      this.toast.show(
        'success',
        ASK_FOR_CHANGE.done,
        this.view()?.record.label ?? '',
      );
    } catch (e) {
      const refusal = refusalOf(toApiError(e));
      this.actionError.set(refusal.message);
      return;
    } finally {
      this.busy.set(false);
      await this.load(this.id());
    }
    this.focusAfterRender(() => {
      this.titleNoteRef()?.nativeElement.focus();
    });
  }

  /**
   * Opens the carrier's panel to amend or split the B/L; the focus moves to its heading.
   * @param panel which one
   */
  protected openChange(panel: ChangePanel): void {
    this.changing.set(panel);
    this.actionError.set(null);
    const label = panel === 'amend' ? 'Amend' : 'Split';
    this.focusAfterRender(() => {
      const heading = this.host.nativeElement.querySelector<HTMLElement>(
        `section[aria-label="${label}"] h2`,
      );
      heading?.focus();
    });
  }

  /** Closes the carrier's panel of a change. */
  protected closeChange(): void {
    this.changing.set(null);
  }

  /**
   * The B/L is amended or split: the panel closes and the page shows the B/L as it is now; the
   * focus moves to the note on where it stands.
   * @return when the page shows it
   */
  protected async changeDone(): Promise<void> {
    this.closeChange();
    await this.load(this.id());
    this.focusAfterRender(() => {
      this.titleNoteRef()?.nativeElement.focus();
    });
  }

  /**
   * Reads the B/L again, after a refusal of an amendment or a split that says it moved on; when
   * the B/L may no longer be changed, its panel closes and the page says why (CB-54).
   * @param reason the refusal, in plain words
   * @return when the page shows it
   */
  protected async changeStale(reason: string): Promise<void> {
    await this.load(this.id());
    if (this.changing() === null) {
      this.actionError.set(reason);
    }
  }

  /**
   * Opens the "Endorse" or "Transfer" panel and lists the organisations the holder may pick.
   * @param action endorse, or transfer a blank-endorsed B/L (CB-52)
   * @return when they are listed, or why they cannot be
   */
  protected async openEndorse(action: HandOver): Promise<void> {
    this.handOver.set(action);
    this.endorseTarget.set('local');
    this.peerPlatform.set('');
    this.peerPartyCode.set('');
    this.peerLookup.set(null);
    this.peerLookupError.set(null);
    this.endorseMode.set('named');
    this.endorsing.set(true);
    this.endorsee.set('');
    this.actionError.set(null);
    await Promise.all([this.loadEndorsees(), this.loadPlatforms()]);
    this.focusAfterRender(() => {
      const panel = this.endorsePanel()?.nativeElement;
      const first = panel?.querySelector<HTMLElement>('input[type=radio]');
      const heading = panel?.querySelector<HTMLElement>('h2');
      (first ?? heading)?.focus();
    });
  }

  /**
   * Lists the organisations the holder may pick, leaving out its own and the current holder;
   * the one picked stays picked while it is still listed. Only the latest listing is shown.
   * @return when they are listed, or why they cannot be
   */
  private async loadEndorsees(): Promise<void> {
    const request = this.latestEndorsees.begin();
    this.endorsees.set(null);
    this.endorseeError.set(null);
    try {
      const organisations = await this.bls.organisations();
      if (!this.latestEndorsees.isCurrent(request)) {
        return;
      }
      const choices = endorseeChoices(organisations, {
        self: this.viewer().organisationId,
        holder: this.view()?.title?.holder ?? null,
      });
      this.endorsees.set(choices);
      if (!choices.some(o => o.id === this.endorsee())) {
        this.endorsee.set('');
      }
    } catch (e) {
      if (this.latestEndorsees.isCurrent(request)) {
        this.endorseeError.set(toApiError(e).message);
      }
    }
  }

  /**
   * Runs a focus move once the page has drawn its latest change.
   * @param move the move
   */
  private focusAfterRender(move: () => void): void {
    afterNextRender(move, {injector: this.injector});
  }

  /**
   * Keeps the organisation picked.
   * @param id its id, '' for none
   */
  protected pickEndorsee(id: string): void {
    this.endorsee.set(id);
  }

  /**
   * Keeps how the holder endorses (CB-52).
   * @param mode by name or in blank
   */
  protected pickMode(mode: EndorseMode): void {
    this.endorseMode.set(mode);
  }

  /** Closes the panel without acting, the focus back on the button that opened it. */
  protected cancelEndorse(): void {
    const action = this.handOver();
    this.closeEndorse();
    this.focusAfterRender(() => {
      if (action === 'transfer') {
        this.transferOpen()?.nativeElement.focus();
      } else {
        this.endorseOpen()?.nativeElement.focus();
      }
    });
  }

  /** Closes the "Endorse" panel. */
  private closeEndorse(): void {
    this.endorsing.set(false);
    this.endorsee.set('');
    this.endorseTarget.set('local');
    this.peerPlatform.set('');
    this.peerPartyCode.set('');
    this.peerLookup.set(null);
    this.peerLookupError.set(null);
    this.endorseMode.set('named');
    // an answer still on its way is no longer shown
    this.latestEndorsees.begin();
  }

  /**
   * Loads active connected eBL platforms for cross-platform endorsement (CB-55).
   * @return when loaded
   */
  private async loadPlatforms(): Promise<void> {
    try {
      this.platforms.set(await this.bls.platforms());
    } catch {
      this.platforms.set([]);
    }
  }

  /**
   * Switches between endorsing locally and sending to another platform (CB-55).
   * @param target local or external
   */
  protected pickEndorseTarget(target: 'local' | 'external'): void {
    this.endorseTarget.set(target);
    this.peerLookup.set(null);
    this.peerLookupError.set(null);
  }

  /**
   * Selects a peer platform and clears prior receiver lookup (CB-55).
   * @param code platform code
   */
  protected pickPeerPlatform(code: string): void {
    this.peerPlatform.set(code);
    this.peerLookup.set(null);
    this.peerLookupError.set(null);
  }

  /**
   * Updates the receiver party code and clears prior confirmation (CB-55).
   * @param value typed party code
   */
  protected setPeerPartyCode(value: string): void {
    this.peerPartyCode.set(value);
    this.peerLookup.set(null);
    this.peerLookupError.set(null);
  }

  /**
   * Queries the peer platform for the receiver party's registered name (CB-55).
   * @return when checked
   */
  protected async checkPeerReceiver(): Promise<void> {
    const platform = this.peerPlatform().trim();
    const partyCode = this.peerPartyCode().trim();
    if (!platform || !partyCode) {
      return;
    }
    this.checkingPeer.set(true);
    this.peerLookup.set(null);
    this.peerLookupError.set(null);
    try {
      this.peerLookup.set(await this.bls.lookupPeerParty(platform, partyCode));
    } catch (e) {
      this.peerLookupError.set(toApiError(e).message);
    } finally {
      this.checkingPeer.set(false);
    }
  }

  /**
   * Sends the B/L to the verified party on the selected peer platform after confirmation (CB-55).
   * @return when completed or refused
   */
  protected async sendExternal(): Promise<void> {
    const verified = this.peerLookup();
    if (!verified) {
      return;
    }
    const label = this.view()?.record.label ?? 'this B/L';
    const confirmed = await this.confirm.ask({
      title: `Send ${label} to ${verified.partyName} on ${verified.platformName}?`,
      body: `${verified.platformName} and ${verified.partyName} will receive this B/L and its full chain of title. Once confirmed, this platform's copy is no longer valid.`,
      confirmLabel: 'Send to platform',
    });
    if (!confirmed) {
      return;
    }
    const done = await this.act('Sent to another platform', () =>
      this.bls.transferOut(this.id(), {
        platform: verified.platform,
        partyCode: verified.partyCode,
        inBlank: false,
      }),
    );
    if (done) {
      this.closeEndorse();
      return;
    }
    await this.load(this.id());
  }

  /**
   * Keeps an arrived B/L from another platform (CB-55).
   * @return when accepted
   */
  protected async acceptIncoming(): Promise<void> {
    const label = this.view()?.record.label ?? 'this B/L';
    const confirmed = await this.confirm.ask({
      title: `Keep ${label}?`,
      body: 'This B/L arrived from another platform. Keeping it lets your organisation endorse or surrender it here.',
      confirmLabel: 'Keep this B/L',
    });
    if (!confirmed) {
      return;
    }
    await this.act('B/L kept by your organisation', () =>
      this.bls.acceptIncoming(this.id()),
    );
  }

  /**
   * Retries a locked outgoing cross-platform transfer with the exact stored envelope (CB-55).
   * @return when retried
   */
  protected async retryTransfer(): Promise<void> {
    await this.act('Transfer confirmed', () =>
      this.bls.retryTransfer(this.id()),
    );
  }

  /**
   * Endorses the B/L to the organisation picked, by name or in blank, or transfers the
   * blank-endorsed B/L to it (CB-52), once the user confirms what happens; the panel closes when
   * it is done. A refusal is shown, and the B/L is read again (someone may have acted on it
   * first): the panel stays, its list read again, only while the user may still act.
   * @return when the page shows the B/L again
   */
  protected async endorse(): Promise<void> {
    const to = this.endorsee();
    const name = this.endorseeName();
    if (to === '') {
      return;
    }
    const action = this.handOver();
    const mode = this.endorseMode();
    const label = this.view()?.record.label ?? 'this B/L';
    const words = handOverWords(action, mode, label, name);
    const confirmed = await this.confirm.ask({
      title: words.title,
      body: this.confirmation(),
      confirmLabel: words.confirmLabel,
    });
    if (!confirmed) {
      return;
    }
    const done = await this.act(words.done, () => {
      if (action === 'transfer') {
        return this.bls.transfer(this.id(), to);
      }
      return this.bls.endorse(this.id(), to, mode);
    });
    if (done) {
      this.closeEndorse();
      return;
    }
    await this.load(this.id());
    if (this.handOverOpen()) {
      await this.loadEndorsees();
    } else {
      this.closeEndorse();
    }
  }

  /**
   * Runs an action, then shows the B/L as it is now; a refusal is shown on the page.
   * @param done what the toast says once it is done
   * @param action the call
   * @return whether the action was done
   */
  private async act(
    done: string,
    action: () => Promise<unknown>,
  ): Promise<boolean> {
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await action();
      this.toast.show('success', done, this.view()?.record.label ?? '');
      await this.load(this.id());
      return true;
    } catch (e) {
      const refusal = refusalOf(toApiError(e));
      if (refusal.reload) {
        // The B/L moved on: show it as it is now, then say why the action was refused.
        await this.load(this.id());
      }
      this.actionError.set(refusal.message);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Loads the names of the organisations a version may be linked to; without them the panel
   * shows the organisations' ids.
   * @return when they are known
   */
  private async loadNames(): Promise<void> {
    try {
      const organisations = await this.bls.organisations();
      this.names.set(
        Object.fromEntries(organisations.map(o => [o.id, o.name])),
      );
    } catch {
      this.names.set({});
    }
  }

  /**
   * Loads the B/L; a B/L the organisation does not see reads as not found. Before issue, its
   * record and open draft too (only its own organisation sees a B/L then).
   * @param id the B/L's id
   * @return when it is shown
   */
  private async load(id: string): Promise<void> {
    const request = this.latest.begin();
    this.error.set(null);
    // another B/L: nothing of the one before stays on screen (a reload after an action keeps it)
    if (this.view()?.recordId !== id) {
      this.view.set(null);
      this.record.set(null);
      this.closeEndorse();
      this.closeChange();
    }
    try {
      const view = await this.bls.title(id);
      // before issue, its record and draft; while the carrier may amend or split it (CB-50), its
      // current version, which only the carrier reads
      const allowed = view.allowedCommands;
      const changing = mayAmend(allowed) || maySplit(allowed);
      let record: BlRecord | null = null;
      if (view.title === null || changing) {
        record = await this.bls.record(id);
      }
      if (this.latest.isCurrent(request)) {
        this.view.set(view);
        this.record.set(record);
        if (!changing) {
          this.closeChange();
        }
      }
      if (record !== null && view.title === null) {
        void this.loadNames();
      }
      if (view.title?.externalPlatform) {
        void this.loadPlatforms();
      }
    } catch (e) {
      if (!this.latest.isCurrent(request)) {
        return;
      }
      const error = toApiError(e);
      if (error.status === 404 || error.status === 400) {
        this.error.set(
          'B/L not found. It does not exist, or your organisation is not party to it.',
        );
      } else {
        this.error.set(error.message);
      }
    }
  }
}
