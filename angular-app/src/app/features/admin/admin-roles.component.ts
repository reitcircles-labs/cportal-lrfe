import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {PERMS, PERM_GROUPS, RbacService} from '../../state/rbac.service';
import {ConfirmService} from '../../state/confirm.service';
import {IconComponent} from '../../shared/icon.component';
import {ADMIN_SHARED_STYLES} from './admin-shared.styles';

/** Administration, Roles & permissions tab: the role cards and the permission matrix. */
@Component({
  selector: 'app-admin-roles',
  imports: [IconComponent],
  template: `
    <section class="roles">
      @for (r of roleCards(); track r.id) {
        <button class="panel rcard" [class.on]="selRole() === r.id" (click)="selRole.set(selRole() === r.id ? null : r.id)">
          <span class="row" style="justify-content:space-between;gap:6px;flex-wrap:nowrap"><b>{{ r.label }}</b><span class="tag" [class.tag-neutral]="r.system" [class.tag-info]="!r.system">{{ r.system ? 'System' : 'Custom' }}</span></span>
          <span class="small muted rdesc">{{ r.desc }}</span>
          <span class="row small" style="gap:12px;margin-top:auto"><span><b class="num">{{ r.users }}</b> users</span><span><b class="num">{{ r.n }}</b> / {{ perms.length }} permissions</span>
            @if (r.conflict) { <span style="color:var(--danger)" title="This role breaks a segregation-of-duties rule"><app-icon name="alert" [size]="14" /></span> }</span>
        </button>
      }
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="stack" style="gap:2px"><h3>Permission matrix</h3><span class="small muted">Tick to grant. Changes apply to every user holding the role once saved. Highlighted cells break a segregation-of-duties rule.</span></div>
      </div>
      <div style="overflow-x:auto">
        <table class="matrix">
          <thead><tr><th class="pcol">Permission</th>
            @for (r of rbac.roles(); track r.id) { <th [class.hl]="selRole() === r.id" (click)="selRole.set(r.id)"><span>{{ r.label }}</span>@if (colConflict(r.id)) { <i class="cf" title="Conflict">!</i> }</th> }
          </tr></thead>
          <tbody>
            @for (g of groups; track g.name) {
              <tr class="grp"><td [attr.colspan]="rbac.roles().length + 1">{{ g.name }}</td></tr>
              @for (p of g.perms; track p.id) {
                <tr>
                  <td class="pcol"><b>{{ p.label }}</b><span>{{ p.desc }}</span></td>
                  @for (r of rbac.roles(); track r.id) {
                    <td class="cell" [class.hl]="selRole() === r.id" [class.bad]="cellConflict(r.id, p.id)">
                      <input type="checkbox" class="cbx" [checked]="has(r.id, p.id)" [disabled]="locked(r.id, p.id)" (change)="toggle(r.id, p.id)" [attr.aria-label]="r.label + ': ' + p.label" [title]="locked(r.id, p.id) ? 'Locked to prevent administrator lock-out' : ''">
                    </td>
                  }
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    </section>
    @if (changes()) {
      <div class="savebar"><app-icon name="info" [size]="18" /><span><b>{{ changes() }}</b> unsaved permission change{{ changes() === 1 ? '' : 's' }}</span><span class="spacer"></span>
        <button class="btn btn-secondary" (click)="draft.set(null)">Discard</button><button class="btn btn-primary" (click)="saveMatrix()">Save changes</button></div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    ADMIN_SHARED_STYLES,
    `
    :host { display: contents; }
    .roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .rcard { text-align: left; padding: 14px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; min-height: 128px; border-top: 3px solid var(--color-divider) !important; transition: border-color .15s, box-shadow .15s; }
    .rcard:hover { box-shadow: var(--shadow-md); }
    .rcard.on { border-color: var(--color-accent-300) !important; border-top-color: var(--color-accent) !important; background: var(--color-accent-100); }
    .rcard.add { align-items: center; justify-content: center; text-align: center; border-style: dashed !important; color: var(--color-accent-600); box-shadow: none; }
    .rdesc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .matrix { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13.5px; min-width: 900px; }
    .matrix th { position: sticky; top: 0; background: var(--color-surface-2); padding: 10px 8px; font-size: 12px; font-weight: 700; color: var(--color-neutral-800); border-bottom: 1px solid var(--color-divider); text-align: center; vertical-align: bottom; cursor: pointer; min-width: 104px; }
    .matrix th span { display: block; line-height: 1.3; }
    .matrix th.pcol, .matrix td.pcol { text-align: left; min-width: 280px; cursor: default; padding-left: 18px; }
    .matrix td { padding: 9px 8px; border-bottom: 1px solid var(--color-divider); }
    .matrix td.pcol b { display: block; font-weight: 600; }
    .matrix td.pcol span { font-size: 12px; color: var(--color-neutral-600); }
    .matrix .cell { text-align: center; }
    .matrix .hl { background: var(--color-accent-100); }
    .matrix .bad { background: var(--danger-bg); }
    .matrix .grp td { background: var(--color-surface-2); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-neutral-700); padding: 8px 18px; }
    .matrix tbody tr:not(.grp):hover td { background: var(--color-neutral-100); }
    .cf { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--danger); color: #fff; font-style: normal; font-size: 10px; margin-top: 4px; }
  `,
  ],
})
export class AdminRolesComponent {
  rbac = inject(RbacService);
  private confirm = inject(ConfirmService);
  perms = PERMS;
  groups = PERM_GROUPS.map(name => ({
    name,
    perms: PERMS.filter(p => p.group === name),
  }));

  selRole = signal<string | null>(null);
  draft = signal<Record<string, string[]> | null>(null);
  working = computed<Record<string, string[]>>(
    () =>
      this.draft() ??
      Object.fromEntries(this.rbac.roles().map(r => [r.id, r.perms])),
  );
  has(r: string, p: string) {
    return (this.working()[r] || []).includes(p);
  }
  locked(r: string, p: string) {
    return r === 'adm' && (p === 'admin.roles' || p === 'admin.users');
  }
  toggle(r: string, p: string) {
    if (this.locked(r, p)) return;
    const w = {...this.working()};
    const cur = w[r] || [];
    w[r] = cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p];
    this.draft.set(w);
  }
  colConflict(r: string) {
    return this.rbac.conflicts(this.working()[r] || []).length > 0;
  }
  cellConflict(r: string, p: string) {
    return (
      this.has(r, p) &&
      this.rbac
        .conflicts(this.working()[r] || [])
        .some(c => c.a === p || c.b === p)
    );
  }
  changes = computed(() => {
    const d = this.draft();
    if (!d) return 0;
    let n = 0;
    this.rbac.roles().forEach(r =>
      PERMS.forEach(p => {
        if (r.perms.includes(p.id) !== (d[r.id] || []).includes(p.id)) n++;
      }),
    );
    return n;
  });
  roleCards = computed(() =>
    this.rbac.roles().map(r => ({
      ...r,
      users: this.rbac.users().filter(u => u.roles.includes(r.id)).length,
      n: (this.working()[r.id] || []).length,
      conflict: this.colConflict(r.id),
    })),
  );
  async saveMatrix() {
    const d = this.draft()!;
    const affected = this.rbac.users().filter(u =>
      u.roles.some(
        r =>
          this.rbac
            .roles()
            .find(x => x.id === r)
            ?.perms.join() !== (d[r] || []).join(),
      ),
    ).length;
    if (
      await this.confirm.ask({
        title:
          'Apply ' +
          this.changes() +
          ' permission change' +
          (this.changes() === 1 ? '' : 's') +
          '?',
        body:
          'This affects ' +
          affected +
          ' user' +
          (affected === 1 ? '' : 's') +
          ', at their next token refresh (within 15 minutes). Each change is written to the access log.',
        confirmLabel: 'Save changes',
      })
    ) {
      await this.rbac.saveMatrix(d);
      this.draft.set(null);
    }
  }
}
