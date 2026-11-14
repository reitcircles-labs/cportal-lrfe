import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {RouterLink} from '@angular/router';
import {
  NATIONAL_ROLES,
  RbacService,
  ToastService,
  toApiError,
} from '@lrfe/platform';

import {BL_SHARED_STYLES} from '../bls/bl-shared.styles';
import {LatestRequest} from '../bls/latest';
import {
  cleanInvitation,
  invitationInvalidField,
  invitationProblem,
  rolesText,
  staffOf,
  staffRoles,
  statusTagClass,
  type Organisation,
  type StaffMember,
} from './onboarding';
import {OrganisationsApi, type InvitationResult} from './organisations.api';

/** A staff member with the words the table shows. */
interface StaffRow {
  member: StaffMember;
  roles: string;
  tagClass: string;
}

/**
 * The page of one organisation, for the platform administrator (`#/admin/organisations/:id`,
 * CB-43): its code and status, its staff with their roles, and inviting a person with the
 * product's roles.
 */
@Component({
  selector: 'app-organisation-detail',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <a class="small" routerLink="/admin/organisations">← All organisations</a>
      @if (error(); as e) {
        <div class="note danger" role="alert">{{ e }}</div>
      } @else if (organisation(); as o) {
        <header>
          <h1 style="margin:4px 0 4px;font-size:32px">{{ o.name }}</h1>
          <span class="row" style="gap:8px">
            <span class="mono small">{{ o.code }}</span>
            <span [class]="'tag ' + tagClass(o.status)">{{ o.status }}</span>
          </span>
        </header>
        <section class="panel">
          <div class="panel-head"><h2>Staff ({{ staff().length }})</h2></div>
          <div style="overflow-x:auto">
            <table class="table" style="min-width:640px" aria-label="Staff">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                @for (r of staff(); track r.member.id) {
                  <tr>
                    <td><strong>{{ r.member.name }}</strong></td>
                    <td class="small">{{ r.member.email }}</td>
                    <td>{{ r.roles }}</td>
                    <td><span [class]="'tag ' + r.tagClass">{{ r.member.status }}</span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="muted" style="padding:22px 16px">{{ loading() ? 'Loading…' : 'No staff yet.' }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Invite a person</h2></div>
          <form class="panel-body stack" style="gap:14px" (submit)="$event.preventDefault(); invite(o)">
            <div class="who">
              <div class="field">
                <label for="person-name">Full name</label>
                <input id="person-name" class="input" autocomplete="off" [value]="name()" (input)="name.set($any($event.target).value)" [attr.aria-invalid]="invalid() === 'name' ? 'true' : null" [attr.aria-describedby]="formError() ? 'person-error' : null">
              </div>
              <div class="field">
                <label for="person-email">Email</label>
                <input id="person-email" class="input" type="email" autocomplete="off" [value]="email()" (input)="email.set($any($event.target).value)" [attr.aria-invalid]="invalid() === 'email' ? 'true' : null" [attr.aria-describedby]="formError() ? 'person-error' : null">
              </div>
            </div>
            <fieldset class="roles" [attr.aria-invalid]="invalid() === 'roles' ? 'true' : null" [attr.aria-describedby]="formError() ? 'person-error' : null">
              <legend class="small"><b>Roles</b></legend>
              @for (role of roles(); track role.id) {
                <label class="role">
                  <input type="checkbox" [checked]="chosen().includes(role.id)" (change)="toggle(role.id, $any($event.target).checked)">
                  <span class="stack" style="gap:0">
                    <span>{{ role.label }}</span>
                    <span class="small muted">{{ role.desc }}</span>
                  </span>
                </label>
              }
            </fieldset>
            <p class="small muted" style="margin:0">They get an email with a link to choose a password and set up their authenticator app.</p>
            @if (formError(); as e) {
              <div id="person-error" class="note danger" role="alert">{{ e }}</div>
            }
            <div>
              <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Sending…' : 'Send invitation' }}</button>
            </div>
          </form>
        </section>
      } @else {
        <p class="muted" role="status">Loading…</p>
      }
    </div>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .who { display: grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap: 12px; }
    .roles { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
    .role { display: flex; gap: 10px; align-items: flex-start; min-height: 44px; }
    .role input { margin-top: 3px; }
    @media (max-width: 720px) { .who { grid-template-columns: 1fr; } }
  `,
  ],
})
export class OrganisationDetailComponent {
  /** The organisation's id, from the route. */
  readonly id = input.required<string>();

  private readonly organisationsApi = inject(OrganisationsApi);
  private readonly rbac = inject(RbacService);
  private readonly toast = inject(ToastService);
  private readonly latest = new LatestRequest();

  protected readonly organisation = signal<Organisation | null>(null);
  private readonly members = signal<StaffMember[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly chosen = signal<string[]>([]);
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  /** The field the form's problem is in, marked invalid for screen readers. */
  protected readonly invalid = signal<'name' | 'email' | 'roles' | null>(null);

  /** The roles a staff member can be given: the product's, not the system administrator's. */
  protected readonly roles = computed(() =>
    staffRoles(this.rbac.roles(), NATIONAL_ROLES),
  );

  protected readonly staff = computed<StaffRow[]>(() =>
    this.members().map(member => ({
      member,
      roles: rolesText(member.roles, this.rbac.roles()),
      tagClass: statusTagClass(member.status),
    })),
  );

  constructor() {
    effect(() => {
      void this.load(this.id());
    });
  }

  /**
   * The tag class of a status.
   * @param status the status
   * @return the class
   */
  protected tagClass(status: StaffMember['status']): string {
    return statusTagClass(status);
  }

  /**
   * Chooses a role for the invitation, or no longer.
   * @param roleId the role
   * @param on whether it is chosen
   */
  protected toggle(roleId: string, on: boolean): void {
    const others = this.chosen().filter(id => id !== roleId);
    if (on) {
      this.chosen.set([...others, roleId]);
    } else {
      this.chosen.set(others);
    }
  }

  /**
   * Invites the person of the form into the organisation, then shows them among its staff.
   * @param organisation the organisation
   * @return when it is done
   */
  protected async invite(organisation: Organisation): Promise<void> {
    const form = {
      name: this.name(),
      email: this.email(),
      roles: this.chosen(),
    };
    const problem = invitationProblem(form);
    this.formError.set(problem);
    this.invalid.set(invitationInvalidField(form));
    if (problem) {
      return;
    }
    this.saving.set(true);
    try {
      const clean = cleanInvitation(form);
      const result = await this.organisationsApi.invite(organisation, clean);
      this.report(clean.name, result);
      this.name.set('');
      this.email.set('');
      this.chosen.set([]);
      await this.load(organisation.id);
    } catch (e) {
      this.formError.set(toApiError(e).message);
    }
    this.saving.set(false);
  }

  /**
   * Tells the administrator whether the invitation email went out.
   * @param name the invited person's name
   * @param result identity's answer
   */
  private report(name: string, result: InvitationResult): void {
    if (result.email?.sent) {
      this.toast.show(
        'success',
        `Invitation sent to ${name}`,
        `Emailed to ${result.email.to}.`,
      );
      return;
    }
    const reason =
      result.email?.reason || 'Email is not configured on the server';
    this.toast.show(
      'warn',
      `${name} was invited, but the email was not sent`,
      `${reason}.`,
      10000,
    );
  }

  /**
   * Loads the organisation and its staff.
   * @param id the organisation's id
   * @return when they are shown
   */
  private async load(id: string): Promise<void> {
    const request = this.latest.begin();
    this.loading.set(true);
    this.error.set(null);
    try {
      const [organisations, users] = await Promise.all([
        this.organisationsApi.list(),
        this.organisationsApi.users(),
      ]);
      if (!this.latest.isCurrent(request)) {
        return;
      }
      const organisation = organisations.find(o => o.id === id) ?? null;
      if (!organisation) {
        this.error.set('Organisation not found');
      }
      this.organisation.set(organisation);
      this.members.set(staffOf(users, id));
    } catch (e) {
      if (!this.latest.isCurrent(request)) {
        return;
      }
      this.error.set(toApiError(e).message);
    }
    this.loading.set(false);
  }
}
