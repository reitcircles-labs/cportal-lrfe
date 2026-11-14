import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {DatePipe} from '@angular/common';
import {RouterLink} from '@angular/router';
import {AuthService, ToastService, toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {approvalOf, issueCommands, maySubmit, versionNote} from './bl-actions';
import {
  carrierOf,
  chainRows,
  consigneeLabel,
  draftFacts,
  kindLabel,
  partyLabel,
  rolesLabel,
  stateLabel,
  stateTone,
  toneTagClass,
} from './bl-format';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import type {BlRecord, BlTitleView} from './bl.model';
import {LatestRequest} from './latest';
import {injectViewer} from './viewer';

/** The buttons of the title commands this page offers (CB-44: the issue). */
const COMMAND_LABELS: ReadonlyMap<string, string> = new Map([
  ['issue', 'Issue to the shipper'],
]);

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
 */
@Component({
  selector: 'app-bl-detail',
  imports: [RouterLink, DatePipe],
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
          <!-- the actions on the B/L: CB-44 the draft's and the issue, CB-45..46 the others -->
          <section class="actions row" aria-label="Actions">
            @if (canSubmit()) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="submit()">Submit for approval</button>
            }
            @if (approval() === 'approve') {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="approve()">Approve</button>
            }
            @for (c of commands(); track c.name) {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="run(c.name)">{{ c.label }}</button>
            }
          </section>
        </header>
        @if (actionError(); as e) {
          <div class="note danger" role="alert">{{ e }}</div>
        }
        @if (commands().length > 0) {
          <p class="note info" role="note">Issuing signs the B/L for your organisation and cannot be undone: the shipper becomes its first holder.</p>
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
            <dl class="kv facts">
              <dt>Reference</dt><dd class="mono">{{ v.record.recordNo }}</dd>
              <dt>Carrier code</dt><dd class="mono">{{ v.record.carrierCode }}</dd>
              <dt>Kind</dt><dd>{{ kind() }}</dd>
              <dt>State</dt><dd>{{ state() }}</dd>
              <dt>Your role</dt><dd>{{ roles() }}</dd>
              <dt>Carrier</dt><dd>{{ carrier() }}</dd>
              <dt>Holder</dt><dd>{{ holder() }}</dd>
              <dt>Consignee</dt><dd>{{ consignee() }}</dd>
            </dl>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Chain of title</h2></div>
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
    .warn { display: block; margin-top: 2px; font-size: 13px; color: var(--danger-fg); }
  `,
  ],
})
export class BlDetailComponent {
  /** The B/L's id, from the route. */
  readonly id = input.required<string>();

  private readonly bls = inject(BlApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly viewer = injectViewer();
  private readonly latest = new LatestRequest();

  protected readonly view = signal<BlTitleView | null>(null);
  /** The B/L's record with its open draft, before issue and for its own organisation only. */
  protected readonly record = signal<BlRecord | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  /** The organisations' names by id, for the parties the version is linked to. */
  private readonly names = signal<Record<string, string>>({});

  /** The open draft, when the user's organisation drafts this B/L. */
  private readonly draft = computed(() => this.record()?.draft ?? null);
  /** The version the panel shows before issue: the open draft, else the approved one. */
  protected readonly shown = computed(
    () => this.record()?.draft ?? this.record()?.current ?? null,
  );
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
  protected readonly canSubmit = computed(() =>
    maySubmit(this.draft(), this.auth.perms()),
  );
  protected readonly commands = computed(() =>
    issueCommands(this.view()?.allowedCommands ?? []).map(name => ({
      name,
      label: COMMAND_LABELS.get(name) ?? name,
    })),
  );

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
  protected readonly roles = computed(() =>
    rolesLabel(this.view()?.roles ?? []),
  );
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
  protected readonly holder = computed(() =>
    partyLabel(
      this.view()?.title?.holder,
      this.viewer(),
      this.view()?.organisationNames,
    ),
  );
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
  protected readonly chain = computed(() =>
    chainRows(
      this.view()?.chain ?? [],
      this.viewer(),
      this.view()?.organisationNames,
    ),
  );

  constructor() {
    effect(() => {
      void this.load(this.id());
    });
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
      this.bls.approve(this.id(), draft.versionNumber),
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
   * Runs an action, then shows the B/L as it is now; a refusal is shown on the page.
   * @param done what the toast says once it is done
   * @param action the call
   * @return when the page shows the B/L again
   */
  private async act(
    done: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await action();
      this.toast.show('success', done, this.view()?.record.label ?? '');
      await this.load(this.id());
    } catch (e) {
      this.actionError.set(toApiError(e).message);
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
    }
    try {
      const view = await this.bls.title(id);
      let record: BlRecord | null = null;
      if (view.title === null) {
        record = await this.bls.record(id);
      }
      if (this.latest.isCurrent(request)) {
        this.view.set(view);
        this.record.set(record);
      }
      if (record !== null) {
        void this.loadNames();
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
