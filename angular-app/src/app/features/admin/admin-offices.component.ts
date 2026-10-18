import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {
  Office,
  OfficeType,
  OFFICE_TYPE_LABEL,
  RbacService,
} from '../../state/rbac.service';
import {ConfirmService} from '../../state/confirm.service';
import {IconComponent} from '../../shared/icon.component';
import {SiteConfigService} from '../../state/site-config.service';
import {ADMIN_SHARED_STYLES} from './admin-shared.styles';

/** Administration, Offices tab: the office list and the add / manage office dialog. */
@Component({
  selector: 'app-admin-offices',
  imports: [IconComponent],
  template: `
    <section class="panel">
      <div class="toolbar">
        <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Code, name or address" [value]="oq()" (input)="oq.set($any($event.target).value)" aria-label="Search offices"></div>
        <span class="spacer"></span>
        <button class="btn btn-primary" (click)="openAddOffice()"><span style="font-size:18px;line-height:0">+</span>Add office</button>
      </div>
      @if (!rbac.offices().length) {
        <div class="empty-o">
          <app-icon name="building" [size]="28" />
          <b>No offices yet</b>
          <span class="small muted">Add your first office location. Users are invited into an office.</span>
          <button class="btn btn-primary" (click)="openAddOffice()">Add office</button>
        </div>
      } @else {
        <div style="overflow-x:auto">
          <table class="table">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Users</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (o of officeRows(); track o.id) {
                <tr class="click" (click)="openEditOffice(o)">
                  <td class="num"><b>{{ o.code }}</b></td>
                  <td><span class="stack" style="gap:0"><span>{{ o.name }}</span>@if (o.address) { <span class="small muted">{{ o.address }}</span> }</span></td>
                  <td class="small">{{ typeLabel(o.type) }}</td>
                  <td class="num">{{ o.users }}</td>
                  <td><span class="tag" [class.tag-accent]="o.status === 'Active'" [class.tag-danger]="o.status === 'Suspended'">{{ o.status }}</span></td>
                  <td style="text-align:right"><button class="btn btn-secondary" style="min-height:32px" (click)="$event.stopPropagation(); openEditOffice(o)">Manage</button></td>
                </tr>
              } @empty { <tr><td colspan="6" class="muted" style="text-align:center;padding:32px">No offices match.</td></tr> }
            </tbody>
          </table>
        </div>
      }
      <div class="foot small muted">{{ officeRows().length }} of {{ rbac.offices().length }} offices · suspended offices take no new invitations; offices are never deleted</div>
    </section>

    <!-- Add / manage office -->
    @if (officeForm(); as f) {
      <div class="dialog-backdrop" (click)="officeForm.set(null)">
        <form class="dialog" style="width:min(520px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); saveOfficeForm()">
          <div class="dialog-title">{{ f.id ? 'Office ' + f.code : 'Add an office' }}</div>
          <div class="dialog-body">{{ f.id ? 'The code cannot be changed.' : 'The code is short and permanent (2 to 5 letters, e.g. WDH); it will appear in batch and document numbers.' }}</div>
          <div class="fg">
            <div class="field"><label>Code</label><input class="input mono" [value]="f.code" [readonly]="!!f.id" maxlength="5" placeholder="WDH" (input)="setOffice('code', $any($event.target).value); $any($event.target).value = officeForm()!.code" required></div>
            <div class="field"><label>Type</label><select class="input" (change)="setOffice('type', $any($event.target).value)">@for (t of officeTypes; track t) { <option [value]="t" [selected]="t === f.type">{{ typeLabel(t) }}</option> }</select></div>
            <div class="field" style="grid-column:1/-1"><label>Name</label><input class="input" [value]="f.name" [placeholder]="site.nameAndPlace()" (input)="setOffice('name', $any($event.target).value)" required></div>
            <div class="field" style="grid-column:1/-1"><label>Address (optional)</label><input class="input" [value]="f.address" (input)="setOffice('address', $any($event.target).value)"></div>
            <div class="field" style="grid-column:1/-1"><label>Contact (optional)</label><input class="input" [value]="f.contact" placeholder="Phone or email" (input)="setOffice('contact', $any($event.target).value)"></div>
          </div>
          <div class="dialog-actions">
            @if (editingOffice(); as o) {
              <button type="button" class="btn btn-secondary" [class.danger]="o.status === 'Active'" style="margin-right:auto" (click)="toggleOffice(o)">{{ o.status === 'Active' ? 'Suspend office' : 'Reactivate office' }}</button>
            }
            <button type="button" class="btn btn-secondary" (click)="officeForm.set(null)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="savingOffice() || !officeValid()">{{ savingOffice() ? 'Saving…' : f.id ? 'Save' : 'Add office' }}</button>
          </div>
        </form>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    ADMIN_SHARED_STYLES,
    `
    :host { display: contents; }
    .empty-o { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 16px; text-align: center; color: var(--color-neutral-700); }
  `,
  ],
})
export class AdminOfficesComponent {
  rbac = inject(RbacService);
  site = inject(SiteConfigService);
  private confirm = inject(ConfirmService);
  officeTypes: OfficeType[] = ['registry', 'external'];
  typeLabel(t: OfficeType) {
    return OFFICE_TYPE_LABEL[t];
  }
  oq = signal('');
  officeRows = computed(() => {
    const q = this.oq().toLowerCase().trim();
    return this.rbac
      .offices()
      .filter(
        o =>
          !q ||
          (o.code + ' ' + o.name + ' ' + o.address).toLowerCase().includes(q),
      );
  });
  /** The add / edit dialog: `id` null when adding. */
  officeForm = signal<{
    id: string | null;
    code: string;
    name: string;
    type: OfficeType;
    address: string;
    contact: string;
  } | null>(null);
  savingOffice = signal(false);
  openAddOffice() {
    this.officeForm.set({
      id: null,
      code: '',
      name: '',
      type: 'registry',
      address: '',
      contact: '',
    });
  }
  openEditOffice(o: Office) {
    this.officeForm.set({
      id: o.id,
      code: o.code,
      name: o.name,
      type: o.type,
      address: o.address,
      contact: o.contact,
    });
  }
  setOffice(k: string, v: string) {
    this.officeForm.update(
      f =>
        f && {
          ...f,
          [k]:
            k === 'code'
              ? v
                  .toUpperCase()
                  .replace(/[^A-Z]/g, '')
                  .slice(0, 5)
              : v,
        },
    );
  }
  officeValid = computed(() => {
    const f = this.officeForm();
    return !!f && /^[A-Z]{2,5}$/.test(f.code) && !!f.name.trim();
  });
  editingOffice = computed(() => {
    const f = this.officeForm();
    return f?.id
      ? (this.rbac.offices().find(o => o.id === f.id) ?? null)
      : null;
  });
  async saveOfficeForm() {
    const f = this.officeForm();
    if (!f || !this.officeValid()) return;
    this.savingOffice.set(true);
    const d = {
      name: f.name.trim(),
      type: f.type,
      address: f.address.trim(),
      contact: f.contact.trim(),
    };
    const ok = f.id
      ? await this.rbac.updateOffice(f.id, d)
      : await this.rbac.addOffice({code: f.code, ...d});
    this.savingOffice.set(false);
    if (ok) this.officeForm.set(null);
  }
  async toggleOffice(o: Office) {
    const suspend = o.status === 'Active';
    if (
      await this.confirm.ask({
        title:
          (suspend ? 'Suspend ' : 'Reactivate ') +
          o.code +
          ' · ' +
          o.name +
          '?',
        body: suspend
          ? 'No new users can be invited into this office, and pending invitations cannot be resent. Its ' +
            o.users +
            ' user(s) and their work are not affected.'
          : 'Users can be invited into this office again.',
        confirmLabel: suspend ? 'Suspend office' : 'Reactivate',
        tone: suspend ? 'danger' : 'primary',
      })
    ) {
      await this.rbac.setOfficeStatus(o, suspend);
      this.officeForm.set(null);
    }
  }
}
