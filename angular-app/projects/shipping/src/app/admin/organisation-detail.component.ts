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
import {
  ConfirmService,
  NATIONAL_ROLES,
  RbacService,
  ToastService,
  toApiError,
} from '@lrfe/platform';

import {BL_SHARED_STYLES} from '../bls/bl-shared.styles';
import {LatestRequest} from '../bls/latest';
import {
  apiKeyProblem,
  cleanInvitation,
  invitationInvalidField,
  invitationProblem,
  rolesText,
  selectedApiKeyPerms,
  staffOf,
  staffRoles,
  statusTagClass,
  type Organisation,
  type OrganisationApiKey,
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
  imports: [DatePipe, RouterLink],
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
        <section class="panel" aria-label="Carrier API keys">
          <div class="panel-head"><h2>Carrier API keys ({{ apiKeys().length }})</h2></div>
          <div class="panel-body stack" style="gap:14px">
            <p class="small muted" style="margin:0">Carrier systems exchange an API key at <span class="mono">/api/auth/api-token</span> and submit or issue B/Ls through <span class="mono">/api/records/issuance</span>.</p>
            @if (createdSecret(); as secret) {
              <div class="note secret-box" role="status">
                <strong>API key created — save it now (it is shown only once):</strong>
                <div class="mono" style="margin-top:6px;word-break:break-all">{{ secret }}</div>
              </div>
            }
            @if (o.status === 'Active') {
              <form class="stack" style="gap:10px" (submit)="$event.preventDefault(); createKey(o)">
                <div class="who">
                  <div class="field">
                    <label for="api-key-name">Key name</label>
                    <input id="api-key-name" class="input" maxlength="100" autocomplete="off" placeholder="e.g. Carrier TMS" [value]="keyName()" (input)="keyName.set($any($event.target).value)">
                  </div>
                  <div class="field" style="justify-content:flex-end">
                    <label class="role" style="min-height:auto;align-items:center">
                      <input type="checkbox" [checked]="keyAllowIssue()" (change)="keyAllowIssue.set($any($event.target).checked)">
                      <span>Allow direct B/L issue (<span class="mono small">bl.issue</span>)</span>
                    </label>
                  </div>
                </div>
                @if (keyError(); as ke) {
                  <div class="note danger" role="alert">{{ ke }}</div>
                }
                <div>
                  <button type="submit" class="btn btn-secondary" [disabled]="keyBusy()">{{ keyBusy() ? 'Creating…' : 'Create API key' }}</button>
                </div>
              </form>
            }
            <div style="overflow-x:auto">
              <table class="table" style="min-width:640px" aria-label="API keys">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Prefix</th>
                    <th>Permissions</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (k of apiKeys(); track k.id) {
                    <tr>
                      <td><strong>{{ k.name }}</strong></td>
                      <td class="mono small">{{ k.prefix }}…</td>
                      <td class="mono small">{{ k.perms.join(', ') }}</td>
                      <td><span [class]="k.status === 'Active' ? 'tag tag-accent' : 'tag tag-neutral'">{{ k.status }}</span></td>
                      <td class="small muted">{{ k.createdAt | date: 'mediumDate' }}</td>
                      <td style="text-align:right">
                        @if (k.status === 'Active') {
                          <button type="button" class="btn btn-secondary" [disabled]="keyBusy()" (click)="revokeKey(o, k)">Revoke</button>
                        }
                      </td>
                    </tr>
                  } @empty {
                    <tr><td colspan="6" class="muted" style="padding:18px 16px">No API keys yet.</td></tr>
                  }
                </tbody>
              </table>
            </div>
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
    .who { display: grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap: 12px; }
    .roles { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
    .role { display: flex; gap: 10px; align-items: flex-start; min-height: 44px; }
    .role input { margin-top: 3px; }
    .secret-box { background: var(--color-surface-2); border: 1px solid var(--color-divider); }
    @media (max-width: 720px) { .who { grid-template-columns: 1fr; } }
  `,
  ],
})
export class OrganisationDetailComponent {
  /** The organisation's id, from the route. */
  readonly id = input.required<string>();

  private readonly organisationsApi = inject(OrganisationsApi);
  private readonly rbac = inject(RbacService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly latest = new LatestRequest();

  protected readonly organisation = signal<Organisation | null>(null);
  private readonly members = signal<StaffMember[]>([]);
  protected readonly apiKeys = signal<OrganisationApiKey[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly chosen = signal<string[]>([]);
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly keyName = signal('');
  protected readonly keyAllowIssue = signal(false);
  protected readonly keyBusy = signal(false);
  protected readonly keyError = signal<string | null>(null);
  protected readonly createdSecret = signal<string | null>(null);
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
      const [organisations, users, apiKeys] = await Promise.all([
        this.organisationsApi.list(),
        this.organisationsApi.users(),
        this.organisationsApi.apiKeys(id),
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
      this.apiKeys.set(apiKeys);
    } catch (e) {
      if (!this.latest.isCurrent(request)) {
        return;
      }
      this.error.set(toApiError(e).message);
    }
    this.loading.set(false);
  }

  /**
   * Creates an API key for the organisation and shows its one-time secret (CB-56).
   * @param organisation the organisation
   * @return when created
   */
  protected async createKey(organisation: Organisation): Promise<void> {
    const problem = apiKeyProblem(this.keyName());
    this.keyError.set(problem);
    if (problem) {
      return;
    }
    this.keyBusy.set(true);
    this.createdSecret.set(null);
    try {
      const created = await this.organisationsApi.createApiKey(
        organisation.id,
        this.keyName().trim(),
        selectedApiKeyPerms(this.keyAllowIssue()),
      );
      this.createdSecret.set(created.secret ?? null);
      this.keyName.set('');
      this.keyAllowIssue.set(false);
      this.toast.show('success', 'API key created', created.name);
      await this.load(organisation.id);
    } catch (e) {
      this.keyError.set(toApiError(e).message);
    } finally {
      this.keyBusy.set(false);
    }
  }

  /**
   * Revokes an active API key after confirmation (CB-56).
   * @param organisation the organisation
   * @param key the key to revoke
   * @return when revoked
   */
  protected async revokeKey(
    organisation: Organisation,
    key: OrganisationApiKey,
  ): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: `Revoke API key "${key.name}"?`,
      body: 'Systems using this key will immediately stop being able to issue or submit B/Ls.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!confirmed) {
      return;
    }
    this.keyBusy.set(true);
    this.keyError.set(null);
    try {
      await this.organisationsApi.revokeApiKey(organisation.id, key.id);
      this.toast.show('success', 'API key revoked', key.name);
      await this.load(organisation.id);
    } catch (e) {
      this.keyError.set(toApiError(e).message);
    } finally {
      this.keyBusy.set(false);
    }
  }
}
