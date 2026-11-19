import {Injectable, inject} from '@angular/core';
import {ApiService} from '@lrfe/platform';
import type {CarrierOption} from '../bls/carrier-picker';
import {
  newOfficeFor,
  officeOf,
  type InvitationForm,
  type OfficeRef,
  type Organisation,
  type OrganisationForm,
  type StaffMember,
} from './onboarding';

/** What identity answers to an invitation: whether the email went out. */
export interface InvitationResult {
  user: StaffMember;
  email?: {sent: boolean; to: string; reason?: string};
}

/**
 * The calls of the identity service the onboarding screens make (CB-43): organisations, their
 * staff and invitations. Identity checks the administrator's permissions again on every call.
 */
@Injectable({providedIn: 'root'})
export class OrganisationsApi {
  private readonly api = inject(ApiService);

  /**
   * Every organisation of the install, with its counts.
   * @return the organisations, as identity lists them
   */
  async list(): Promise<Organisation[]> {
    const answer = await this.api.get<{organisations: Organisation[]}>(
      '/organisations',
    );
    return answer.organisations;
  }

  /**
   * Adds an organisation.
   * @param form its code and name, cleaned
   * @return the organisation
   */
  create(form: OrganisationForm): Promise<Organisation> {
    return this.api.post<Organisation>('/organisations', form);
  }

  /**
   * Lists the SMDG liner carrier codes (CB-68).
   * @return the carriers, sorted by code
   */
  async carriers(): Promise<CarrierOption[]> {
    const answer = await this.api.get<{items: CarrierOption[]}>(
      '/records/carriers',
    );
    return answer.items;
  }

  /**
   * Sets or clears an organisation's default SMDG carrier code (CB-68).
   * @param id the organisation's id
   * @param carrierCode the SMDG code, or null to clear
   * @return the updated organisation
   */
  setCarrierCode(
    id: string,
    carrierCode: string | null,
  ): Promise<Organisation> {
    return this.api.patch<Organisation>(
      `/organisations/${encodeURIComponent(id)}`,
      {carrierCode},
    );
  }

  /**
   * Every user of the install (the staff list filters them by organisation).
   * @return the users
   */
  async users(): Promise<StaffMember[]> {
    const answer = await this.api.get<{users: StaffMember[]}>('/users');
    return answer.users;
  }

  /**
   * Invites a person into an organisation. Identity puts every user who is not a system
   * administrator into an office, so the organisation's first active office is used, made first
   * when it has none (named after the organisation, with a code no other office has).
   * @param organisation the organisation they join
   * @param form their name, email and roles, cleaned
   * @return the invited user and whether the email went out
   */
  async invite(
    organisation: Organisation,
    form: InvitationForm,
  ): Promise<InvitationResult> {
    const officeId = await this.officeIdFor(organisation);
    return this.api.post<InvitationResult>('/users', {
      ...form,
      officeId,
      organisationId: organisation.id,
    });
  }

  /**
   * The id of the office an organisation's new staff join, made when it has none.
   * @param organisation the organisation
   * @return the office's id
   */
  private async officeIdFor(organisation: Organisation): Promise<string> {
    const {offices} = await this.api.get<{offices: OfficeRef[]}>('/offices');
    const office = officeOf(offices, organisation.id);
    if (office) {
      return office.id;
    }
    // a code no office has: the organisation's, else a free one (its own suspended office's too)
    const created = await this.api.post<OfficeRef>(
      '/offices',
      newOfficeFor(organisation, offices),
    );
    return created.id;
  }
}
