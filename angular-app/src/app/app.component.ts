import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';
import { ViewerComponent } from './shared/viewer.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ViewerComponent],
  template: `
    <header class="nav shell-head">
      <a routerLink="/" class="nav-brand brand">
        <span>Republic of Namibia · Deeds Registry</span>
        <span class="sub">Land records EDRMS → ERP · Windhoek</span>
      </a>
      <nav class="steps">
        @for (s of steps; track s.path) {
          <a [routerLink]="s.path" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }" class="step">
            <span class="n">{{ s.n }}</span>{{ s.label }}
          </a>
        }
      </nav>
      <div class="row small muted">
        <span class="tag tag-accent">{{ role() }}</span>
        @if (user()) { <span>{{ user() }}</span> }
      </div>
    </header>
    <main><router-outlet /></main>
    <footer class="page small muted" style="padding-top:0">Names, identity numbers and deed references are fictitious sample data.</footer>
    <app-viewer />
  `,
  styles: [`
    .shell-head { border-bottom: 1px solid var(--color-divider); padding: 0 28px; gap: 18px; flex-wrap: wrap; position: sticky; top: 0; z-index: 20; background: var(--color-bg); }
    .brand { display: flex; flex-direction: column; gap: 0; margin-right: 0; padding: 10px 0; text-decoration: none; color: var(--color-text); line-height: 1.15; }
    .brand .sub { font-family: var(--font-body); font-weight: 400; font-size: 12px; color: var(--color-neutral-700); }
    .steps { display: flex; gap: 2px; margin: 0 auto; flex-wrap: wrap; }
    .step { display: flex; align-items: baseline; gap: 8px; padding: 16px 14px 14px; border-bottom: 2px solid transparent; font-family: var(--font-heading); font-weight: 600; font-size: 16px; color: var(--color-neutral-700) !important; }
    .step .n { font-size: 11px; font-family: var(--font-body); font-weight: 500; letter-spacing: .06em; }
    .step:hover { color: var(--color-accent-800) !important; }
    .step.on { color: var(--color-accent-800) !important; border-bottom-color: var(--color-accent); }
  `]
})
export class AppComponent {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  role = signal('Overview');
  user = signal('');
  steps = [
    { n: '00', label: 'Flow', path: '/' },
    { n: '01', label: 'Capture', path: '/capture' },
    { n: '02', label: 'Verify', path: '/verify' },
    { n: '03', label: 'Link to ERP', path: '/link' },
    { n: '04', label: 'Audit', path: '/audit' }
  ];
  constructor() {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
      let r = this.route.firstChild;
      while (r?.firstChild) r = r.firstChild;
      const d = r?.snapshot.data || {};
      this.role.set(d['role'] || 'Overview');
      this.user.set(d['user'] || '');
      window.scrollTo(0, 0);
    });
  }
}
