import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {Policies, RbacService, SodRule} from '../../state/rbac.service';
import {ConfirmService} from '../../state/confirm.service';
import {IconComponent} from '../../shared/icon.component';
import {ADMIN_SHARED_STYLES} from './admin-shared.styles';

/** Administration, Security policies tab: authentication, record controls and segregation of duties. */
@Component({
  selector: 'app-admin-policies',
  imports: [IconComponent],
  template: `
    <section class="pgrid">
      <div class="panel">
        <div class="panel-head"><h3>Authentication</h3></div>
        <div class="panel-body stack" style="gap:0">
          <label class="prow"><span><b>Require multi-factor authentication</b><span>All users must enrol an authenticator app or security key.</span></span><input type="checkbox" class="switch" [checked]="wp().mfa" (change)="setPol('mfa', $any($event.target).checked)"></label>
          <label class="prow"><span><b>Allow sign-in with national eID</b><span>Uses the national identity service as a second factor.</span></span><input type="checkbox" class="switch" [checked]="wp().eid" (change)="setPol('eid', $any($event.target).checked)"></label>
          <label class="prow"><span><b>Restrict to government network</b><span>Block sign-in from outside the GRN network and VPN.</span></span><input type="checkbox" class="switch" [checked]="wp().ipAllow" (change)="setPol('ipAllow', $any($event.target).checked)"></label>
          <div class="prow"><span><b>Idle session timeout</b><span>Users are signed out after this long without activity.</span></span>
            <div class="seg">@for (m of [15, 30, 60]; track m) { <label class="seg-opt"><input type="radio" name="to" [checked]="wp().timeout === m" (change)="setPol('timeout', m)">{{ m }} min</label> }</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Record controls</h3></div>
        <div class="panel-body stack" style="gap:0">
          <label class="prow"><span><b>Four-eyes finalization</b><span>The officer who finalizes a land record must differ from the reviewer who filed its documents.</span></span><input type="checkbox" class="switch" [checked]="wp().fourEyes" (change)="setPol('fourEyes', $any($event.target).checked)"></label>
          <div class="prow"><span><b>Audit trail retention</b><span>Permanent, under the Archives Act. Cannot be changed.</span></span><span class="tag tag-neutral"><app-icon name="lock" [size]="12" />Permanent</span></div>
        </div>
      </div>
      <div class="panel wide">
        <div class="panel-head"><div class="stack" style="gap:2px"><h3>Segregation of duties</h3><span class="small muted">Pairs of permissions no single user may hold together. Enabled rules are flagged on users and roles.</span></div></div>
        <div class="panel-body stack" style="gap:0">
          @for (s of ws(); track s.id) {
            <label class="prow">
              <span><b>{{ s.label }}</b><span class="row" style="gap:6px;margin-top:4px"><span class="tag tag-neutral">{{ rbac.permLabel(s.a) }}</span>×<span class="tag tag-neutral">{{ rbac.permLabel(s.b) }}</span>
                @if (affected(s); as n) { <span class="tag" [class.tag-danger]="s.on" [class.tag-neutral]="!s.on">{{ n }} user{{ n === 1 ? '' : 's' }} affected</span> }</span></span>
              <input type="checkbox" class="switch" [checked]="s.on" (change)="setSod(s.id, $any($event.target).checked)">
            </label>
          }
        </div>
      </div>
    </section>
    @if (polDirty()) {
      <div class="savebar"><app-icon name="info" [size]="18" /><span>Unsaved policy changes</span><span class="spacer"></span>
        <button class="btn btn-secondary" (click)="pol.set(null); sod.set(null)">Discard</button><button class="btn btn-primary" (click)="savePolicies()">Save policies</button></div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    ADMIN_SHARED_STYLES,
    `
    :host { display: contents; }
    .pgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 20px; align-items: start; }
    .pgrid .wide { grid-column: 1 / -1; }
    .prow { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px 0; border-bottom: 1px solid var(--color-divider); cursor: pointer; }
    .prow:last-child { border-bottom: 0; }
    .prow > span:first-child { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .prow > span:first-child > span { font-size: 13px; color: var(--color-neutral-700); }
  `,
  ],
})
export class AdminPoliciesComponent {
  rbac = inject(RbacService);
  private confirm = inject(ConfirmService);
  pol = signal<Policies | null>(null);
  sod = signal<SodRule[] | null>(null);
  wp = computed(() => this.pol() ?? this.rbac.policies());
  ws = computed(() => this.sod() ?? this.rbac.sod());
  polDirty = computed(() => !!this.pol() || !!this.sod());
  setPol<K extends keyof Policies>(k: K, v: Policies[K]) {
    this.pol.set({...this.wp(), [k]: v});
  }
  setSod(id: string, on: boolean) {
    this.sod.set(this.ws().map(s => (s.id === id ? {...s, on} : s)));
  }
  affected(s: SodRule) {
    return this.rbac
      .users()
      .filter(
        u =>
          u.status !== 'Suspended' &&
          this.rbac.conflicts(this.rbac.effective(u.roles), [{...s, on: true}])
            .length,
      ).length;
  }
  async savePolicies() {
    if (
      await this.confirm.ask({
        title: 'Save security policies?',
        body: 'Authentication changes apply at each user’s next sign-in. Segregation rules apply immediately.',
        confirmLabel: 'Save policies',
      })
    ) {
      this.rbac.savePolicies(this.wp(), this.ws());
      this.pol.set(null);
      this.sod.set(null);
    }
  }
}
