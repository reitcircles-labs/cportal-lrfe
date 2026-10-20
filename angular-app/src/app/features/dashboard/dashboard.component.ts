import {
  Component,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import {RouterLink} from '@angular/router';
import {BATCHES, QUEUE, TOTAL} from '../../data/mock-data';
import {RegistryStore} from '../../state/registry.store';
import {AuthService} from '../../state/auth.service';
import {IconComponent} from '../../shared/icon.component';
import {SiteConfigService} from '../../state/site-config.service';
import {DashboardActivityComponent} from './dashboard-activity.component';
import {DashboardBatchesComponent} from './dashboard-batches.component';
import {DashboardPipelineComponent} from './dashboard-pipeline.component';
import {DashboardRecordsComponent} from './dashboard-records.component';
import {DashboardThroughputComponent} from './dashboard-throughput.component';

/** The home screen: the work of the registry at a glance, with sample figures. */
@Component({
  selector: 'app-dashboard',
  imports: [
    RouterLink,
    IconComponent,
    DashboardRecordsComponent,
    DashboardPipelineComponent,
    DashboardThroughputComponent,
    DashboardBatchesComponent,
    DashboardActivityComponent,
  ],
  template: `
    <div class="page stack" style="gap:24px">
      <section class="welcome">
        <div>
          <h2 style="margin:0 0 4px">Good morning, {{ firstName() }}</h2>
          <span class="muted">{{ site.nameAndPlace() }} · Monday 28 September 2026 · back-scanning programme, week 38</span>
        </div>
        <div class="row">
          <a class="btn btn-secondary" routerLink="/flow"><app-icon name="flow" [size]="16" />How the process works</a>
          <a class="btn btn-primary" [routerLink]="auth.role()?.home || '/verify'">Open my queue<app-icon name="arrowRight" [size]="16" /></a>
        </div>
      </section>
      <p class="small muted sample-note" role="note">The figures and records on this page are sample data. The other screens use live data.</p>

      <section class="kpis">
        @for (k of kpis(); track k.label) {
          <a class="panel kpi" [routerLink]="k.link">
            <span class="kic" [class]="'kic ' + k.tone"><app-icon [name]="k.icon" [size]="20" /></span>
            <span class="kl">{{ k.label }}</span>
            <span class="kv num">{{ k.value }}</span>
            <span class="kd" [class.up]="k.up">{{ k.delta }}</span>
          </a>
        }
      </section>

      <app-dashboard-records />

      <section class="grid2">
        <app-dashboard-pipeline />
        <app-dashboard-throughput />
      </section>

      <section class="grid2">
        <app-dashboard-batches />
        <app-dashboard-activity />
      </section>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    .sample-note { margin: -12px 0 0; }
    .welcome { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .kpi { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto auto; gap: 2px 14px; padding: 18px; text-decoration: none; color: inherit; transition: box-shadow .15s, transform .15s, border-color .15s; }
    .kpi:hover { box-shadow: var(--shadow-md); border-color: var(--color-accent-300); transform: translateY(-1px); }
    .kic { grid-row: 1 / 4; width: 44px; height: 44px; border-radius: 10px; display: grid; place-items: center; background: var(--color-accent-100); color: var(--color-accent-600); }
    .kic.ok { background: var(--success-bg); color: var(--success); }
    .kic.warn { background: var(--warn-bg); color: var(--warn); }
    .kic.info { background: var(--color-accent-100); color: var(--color-accent-600); flex: none; }
    .kl { font-size: 13px; color: var(--color-neutral-700); font-weight: 500; }
    .kv { font-size: 28px; font-weight: 800; letter-spacing: -.02em; line-height: 1.15; }
    .kd { font-size: 12.5px; color: var(--color-neutral-600); }
    .kd.up { color: var(--success); }
    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 20px; align-items: start; }
  `,
  ],
})
export class DashboardComponent {
  store = inject(RegistryStore);
  auth = inject(AuthService);
  site = inject(SiteConfigService);
  firstName = computed(
    () =>
      (this.auth.role()?.name || '').replace(/^[A-Z]\.\s*/, '') || 'colleague',
  );
  private openDocs = computed(() => {
    this.store.fs();
    this.store.filed();
    return QUEUE.filter(d => !this.store.isFiled(d));
  });
  kpis = computed(() => {
    const th = this.store.threshold();
    const open = this.openDocs();
    const low = open.reduce(
      (a, d) => a + d.fields.filter(f => (f.c ?? 1) < th).length,
      0,
    );
    return [
      {
        label: 'Pages captured · WDH-B017',
        value: this.store.pages() + ' / ' + TOTAL,
        delta: this.store.scanDone() ? 'Batch complete' : 'Scanner SC-02 ready',
        up: this.store.scanDone(),
        icon: 'scan',
        tone: 'info',
        link: '/capture',
      },
      {
        label: 'Documents awaiting review',
        value: String(open.length),
        delta: 'across ' + BATCHES.length + ' batches',
        up: false,
        icon: 'inbox',
        tone: 'info',
        link: '/verify',
      },
      {
        label: 'Low-confidence fields',
        value: String(low),
        delta: 'below ' + Math.round(th * 100) + '% threshold',
        up: false,
        icon: 'alert',
        tone: 'warn',
        link: '/verify',
      },
      {
        label: 'Records finalized',
        value: String(
          this.store.recordRows().filter(r => r.st === 'finalized').length,
        ),
        delta:
          'of ' +
          this.store.recordRows().length +
          ' land records · tokenization-ready',
        up: true,
        icon: 'token',
        tone: 'ok',
        link: '/link',
      },
    ];
  });
}
