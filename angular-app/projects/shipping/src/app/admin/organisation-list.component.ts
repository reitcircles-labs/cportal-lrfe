import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {Router, RouterLink} from '@angular/router';
import {ToastService, toApiError} from '@lrfe/platform';

import {BL_SHARED_STYLES} from '../bls/bl-shared.styles';
import {
  cleanOrganisation,
  organisationInvalidField,
  organisationProblem,
  sortOrganisations,
  statusTagClass,
  type Organisation,
} from './onboarding';
import {OrganisationsApi} from './organisations.api';

/**
 * The organisations of the install, for the platform administrator (`#/admin/organisations`,
 * CB-43): each with its code, status and staff, opening its page; and adding one, which then
 * opens its page to invite its staff.
 */
@Component({
  selector: 'app-organisation-list',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <header>
        <h1 style="margin:4px 0 4px;font-size:36px">Organisations</h1>
        <p class="muted" style="margin:0">The carriers, shippers, banks and buyers on the platform, and their staff.</p>
      </header>
      <section class="panel">
        @if (error(); as e) {
          <div class="note danger" role="alert" style="margin:16px">{{ e }}</div>
        }
        <p class="sr-only" role="status">{{ loading() ? 'Loading…' : '' }}</p>
        <div style="overflow-x:auto">
          <table class="table" style="min-width:600px" aria-label="Organisations">
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Status</th>
                <th>Staff</th>
                <th><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              @for (o of organisations(); track o.id) {
                <tr>
                  <td>
                    <a class="rec" [routerLink]="['/admin/organisations', o.id]">
                      <strong>{{ o.name }}</strong>
                      <span class="small muted mono">{{ o.code }}@if (o.carrierCode) { · SMDG {{ o.carrierCode }}}</span>
                    </a>
                  </td>
                  <td><span [class]="'tag ' + tagClass(o)">{{ o.status }}</span></td>
                  <td class="num">{{ o.users }}</td>
                  <td style="text-align:right">
                    <a class="btn btn-secondary" [routerLink]="['/admin/organisations', o.id]" [attr.aria-label]="'Open ' + o.name">Open</a>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="4" class="muted" style="padding:22px 16px">{{ loading() ? 'Loading…' : 'No organisations yet.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Add an organisation</h2></div>
        <form class="panel-body add" (submit)="$event.preventDefault(); add()">
          <div class="field">
            <label for="org-name">Name of the organisation</label>
            <input id="org-name" class="input" autocomplete="off" [value]="name()" (input)="name.set($any($event.target).value)" [attr.aria-invalid]="invalid() === 'name' ? 'true' : null" [attr.aria-describedby]="formError() ? 'org-error' : null">
          </div>
          <div class="field">
            <label for="org-code">Code</label>
            <input id="org-code" class="input mono" autocomplete="off" maxlength="5" [value]="code()" (input)="code.set($any($event.target).value)" [attr.aria-invalid]="invalid() === 'code' ? 'true' : null" [attr.aria-describedby]="codeDescribedBy()">
          </div>
          <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Adding…' : 'Add organisation' }}</button>
          <p id="org-code-hint" class="small muted hint">The code is short and permanent: 2 to 5 letters, e.g. ABC.</p>
          @if (formError(); as e) {
            <div id="org-error" class="note danger hint" role="alert">{{ e }}</div>
          }
        </form>
      </section>
    </div>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .rec { display: flex; flex-direction: column; min-height: 44px; justify-content: center; text-decoration: none; }
    .add { display: grid; grid-template-columns: minmax(220px, 2fr) minmax(100px, 1fr) auto; gap: 12px; align-items: end; }
    .add .hint { grid-column: 1 / -1; margin: 0; }
    @media (max-width: 720px) { .add { grid-template-columns: 1fr; } }
  `,
  ],
})
export class OrganisationListComponent {
  private readonly organisationsApi = inject(OrganisationsApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly organisations = signal<Organisation[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  /** The field the form's problem is in, marked invalid for screen readers. */
  protected readonly invalid = signal<'name' | 'code' | null>(null);
  /** The code's hint, and the form's problem when there is one. */
  protected readonly codeDescribedBy = computed(() => {
    if (this.formError()) {
      return 'org-code-hint org-error';
    }
    return 'org-code-hint';
  });

  constructor() {
    void this.load();
  }

  /**
   * The tag class of an organisation's status.
   * @param organisation the organisation
   * @return the class
   */
  protected tagClass(organisation: Organisation): string {
    return statusTagClass(organisation.status);
  }

  /**
   * Adds the organisation of the form and opens its page.
   * @return when it is done
   */
  protected async add(): Promise<void> {
    const form = {code: this.code(), name: this.name()};
    const problem = organisationProblem(form);
    this.formError.set(problem);
    this.invalid.set(organisationInvalidField(form));
    if (problem) {
      return;
    }
    this.saving.set(true);
    try {
      const created = await this.organisationsApi.create(
        cleanOrganisation(form),
      );
      this.toast.show('success', 'Organisation added', created.name);
      await this.router.navigate(['/admin/organisations', created.id]);
    } catch (e) {
      this.formError.set(toApiError(e).message);
    }
    this.saving.set(false);
  }

  /**
   * Loads the organisations.
   * @return when they are shown
   */
  private async load(): Promise<void> {
    try {
      this.organisations.set(
        sortOrganisations(await this.organisationsApi.list()),
      );
    } catch (e) {
      this.error.set(toApiError(e).message);
    }
    this.loading.set(false);
  }
}
