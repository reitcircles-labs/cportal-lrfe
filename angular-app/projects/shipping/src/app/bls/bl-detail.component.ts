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
import {toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {
  carrierOf,
  chainRows,
  kindLabel,
  partyLabel,
  rolesLabel,
  stateLabel,
  stateTone,
  toneTagClass,
} from './bl-format';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import type {BlTitleView} from './bl.model';
import {LatestRequest} from './latest';
import {injectViewer} from './viewer';

/**
 * The page of one B/L (`#/bls/:id`, CB-42): its reference, kind, state, holder, the user's
 * organisation's roles on it and its chain of title. The actions on it (endorse, surrender,
 * release...) come with CB-44..46, in the "actions" section, from the title's allowedCommands.
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
          <!-- the actions on the B/L (CB-44..46) go here, one button per allowed command -->
          <section class="actions row" aria-label="Actions"></section>
        </header>
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
  `,
  ],
})
export class BlDetailComponent {
  /** The B/L's id, from the route. */
  readonly id = input.required<string>();

  private readonly bls = inject(BlApi);
  private readonly viewer = injectViewer();
  private readonly latest = new LatestRequest();

  protected readonly view = signal<BlTitleView | null>(null);
  protected readonly error = signal<string | null>(null);

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
  protected readonly kind = computed(() => kindLabel(this.view()?.title?.kind));
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
  protected readonly consignee = computed(() =>
    partyLabel(
      this.view()?.title?.consignee,
      this.viewer(),
      this.view()?.organisationNames,
    ),
  );
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
   * Loads the B/L; a B/L the organisation does not see reads as not found.
   * @param id the B/L's id
   * @return when it is shown
   */
  private async load(id: string): Promise<void> {
    const request = this.latest.begin();
    this.view.set(null);
    this.error.set(null);
    try {
      const view = await this.bls.title(id);
      if (this.latest.isCurrent(request)) {
        this.view.set(view);
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
