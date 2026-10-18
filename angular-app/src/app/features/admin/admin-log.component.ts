import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {AccessKind, RbacService} from '../../state/rbac.service';
import {IconComponent} from '../../shared/icon.component';
import {ADMIN_SHARED_STYLES} from './admin-shared.styles';

const KIND: Record<AccessKind, [string, string]> = {
  role: ['Role', 'tag-info'],
  user: ['User', 'tag-neutral'],
  policy: ['Policy', 'tag-outline'],
  denied: ['Denied', 'tag-danger'],
  session: ['Session', 'tag-neutral'],
  office: ['Office', 'tag-info'],
};

/** Administration, Access log tab: role, user, office, policy and sign-in events. */
@Component({
  selector: 'app-admin-log',
  imports: [IconComponent],
  template: `
    <section class="panel">
      <div class="toolbar">
        <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Actor, target or detail" [value]="lq()" (input)="lq.set($any($event.target).value)" aria-label="Search access log"></div>
        <div class="seg">@for (k of kinds; track k.id) { <label class="seg-opt"><input type="radio" name="lk" [checked]="lk() === k.id" (change)="lk.set(k.id)">{{ k.label }}</label> }</div>
        <span class="spacer"></span><span class="small muted">{{ logRows().length }} events</span>
      </div>
      <div style="overflow-x:auto">
        <table class="table" style="min-width:820px">
          <thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>
            @for (e of logRows(); track $index) {
              <tr><td class="num small" style="white-space:nowrap">{{ e.time }}</td><td>{{ e.actor }}</td><td><span class="tag" [class]="'tag ' + kindTag(e.kind)">{{ kindLabel(e.kind) }}</span></td><td style="font-weight:600">{{ e.action }}</td><td>{{ e.target }}</td><td class="small" style="color:var(--color-neutral-800)">{{ e.detail }}</td></tr>
            } @empty { <tr><td colspan="6" class="muted" style="text-align:center;padding:32px">No events match.</td></tr> }
          </tbody>
        </table>
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    ADMIN_SHARED_STYLES,
    `
    :host { display: contents; }
  `,
  ],
})
export class AdminLogComponent {
  rbac = inject(RbacService);
  kinds: Array<{id: 'all' | AccessKind; label: string}> = [
    {id: 'all', label: 'All'},
    {id: 'role', label: 'Roles'},
    {id: 'user', label: 'Users'},
    {id: 'office', label: 'Offices'},
    {id: 'policy', label: 'Policies'},
    {id: 'denied', label: 'Denied'},
    {id: 'session', label: 'Sign-ins'},
  ];
  lq = signal('');
  lk = signal<'all' | AccessKind>('all');
  logRows = computed(() => {
    const q = this.lq().toLowerCase().trim();
    const k = this.lk();
    return this.rbac
      .log()
      .filter(
        e =>
          (k === 'all' || e.kind === k) &&
          (!q ||
            (e.actor + ' ' + e.target + ' ' + e.detail + ' ' + e.action)
              .toLowerCase()
              .includes(q)),
      );
  });
  kindTag(k: AccessKind) {
    return KIND[k][1];
  }
  kindLabel(k: AccessKind) {
    return KIND[k][0];
  }
}
