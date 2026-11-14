import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {RouterLink} from '@angular/router';
import {toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {
  kindLabel,
  partyLabel,
  rolesLabel,
  stateLabel,
  stateTone,
  toneTagClass,
} from './bl-format';
import type {BlListItem} from './bl.model';
import {LatestRequest} from './latest';
import {injectViewer} from './viewer';

/** How many B/Ls a page shows. */
const PAGE_SIZE = 25;

/** A B/L of the list with the words the table shows. */
interface Row {
  item: BlListItem;
  kind: string;
  state: string;
  tagClass: string;
  holder: string;
  roles: string;
}

/**
 * The home of the shipping app (CB-42): the B/Ls the user's organisation is party to, as carrier,
 * holder, past holder or consignee, its drafts among them, newest first; each opens its page.
 */
@Component({
  selector: 'app-bl-list',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <header>
        <h1 style="margin:4px 0 4px;font-size:36px">Bills of lading</h1>
        <p class="muted" style="margin:0">The B/Ls your organisation carries, holds or held, or is the consignee of.</p>
      </header>
      <section class="panel">
        @if (error(); as e) {
          <div class="note danger" role="alert" style="margin:16px">{{ e }}</div>
        }
        <p class="sr-only" role="status">{{ loading() ? 'Loading…' : '' }}</p>
        <div style="overflow-x:auto">
          <table class="table" style="min-width:860px" aria-label="Bills of lading">
            <thead>
              <tr>
                <th>B/L</th>
                <th>Kind</th>
                <th>State</th>
                <th>Holder</th>
                <th>Your role</th>
                <th><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.item.id) {
                <tr>
                  <td>
                    <a class="rec" [routerLink]="['/bls', r.item.id]">
                      <strong>{{ r.item.label }}</strong><span class="small muted">{{ r.item.recordNo }}</span>
                    </a>
                  </td>
                  <td>{{ r.kind }}</td>
                  <td><span [class]="'tag ' + r.tagClass">{{ r.state }}</span></td>
                  <td class="ell">{{ r.holder }}</td>
                  <td>{{ r.roles }}</td>
                  <td style="text-align:right">
                    <a class="btn btn-secondary" [routerLink]="['/bls', r.item.id]" [attr.aria-label]="'Open ' + r.item.label">Open</a>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="muted" style="padding:22px 16px">{{ loading() ? 'Loading…' : 'Your organisation is not party to any B/L yet.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
        <nav class="row pager" aria-label="Pages">
          <span class="muted">{{ rangeText() }}</span>
          <div class="row" style="gap:6px">
            <button type="button" class="btn btn-secondary" [disabled]="offset() === 0" (click)="previous()">Previous</button>
            <button type="button" class="btn btn-secondary" [disabled]="offset() + pageSize >= total()" (click)="next()">Next</button>
          </div>
        </nav>
      </section>
    </div>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .rec { display: flex; flex-direction: column; min-height: 44px; justify-content: center; text-decoration: none; }
    .ell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pager { padding: 12px 16px; border-top: 1px solid var(--color-divider); justify-content: space-between; gap: 10px; }
  `,
  ],
})
export class BlListComponent {
  private readonly bls = inject(BlApi);
  private readonly viewer = injectViewer();
  private readonly latest = new LatestRequest();

  protected readonly pageSize = PAGE_SIZE;
  protected readonly offset = signal(0);
  protected readonly items = signal<BlListItem[]>([]);
  protected readonly total = signal(0);
  private readonly names = signal<Record<string, string>>({});
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly rows = computed<Row[]>(() =>
    this.items().map(item => ({
      item,
      kind: kindLabel(item.title?.kind),
      state: stateLabel(item),
      tagClass: toneTagClass(stateTone(item)),
      holder: partyLabel(item.title?.holder, this.viewer(), this.names()),
      roles: rolesLabel(item.roles),
    })),
  );

  protected readonly rangeText = computed(() => {
    const total = this.total();
    if (total === 0) {
      return 'No B/Ls';
    }
    const first = this.offset() + 1;
    const last = this.offset() + this.items().length;
    return `${first}–${last} of ${total}`;
  });

  constructor() {
    effect(() => {
      void this.load(this.offset());
    });
  }

  /** Shows the page before. */
  protected previous(): void {
    this.offset.set(Math.max(0, this.offset() - PAGE_SIZE));
  }

  /** Shows the page after. */
  protected next(): void {
    this.offset.set(this.offset() + PAGE_SIZE);
  }

  /**
   * Loads a page of the list.
   * @param offset where the page starts
   * @return when it is shown
   */
  private async load(offset: number): Promise<void> {
    const request = this.latest.begin();
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.bls.list({limit: PAGE_SIZE, offset});
      if (!this.latest.isCurrent(request)) {
        return;
      }
      this.items.set(page.items);
      this.total.set(page.total);
      this.names.set(page.organisationNames ?? {});
    } catch (e) {
      if (!this.latest.isCurrent(request)) {
        return;
      }
      this.items.set([]);
      this.error.set(toApiError(e).message);
    }
    this.loading.set(false);
  }
}
