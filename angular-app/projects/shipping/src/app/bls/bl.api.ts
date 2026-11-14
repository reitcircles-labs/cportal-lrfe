import {Injectable, inject} from '@angular/core';
import {ApiService} from '@lrfe/platform';
import type {DraftRequest} from './bl-draft';
import {endorseRequest} from './bl-endorse';
import type {
  BlPage,
  BlRecord,
  BlTitleView,
  PartyOrganisation,
} from './bl.model';

/**
 * The calls of the shipping record service the B/L screens make (gateway prefix /api/records).
 * The organisation is always the session's: no call names one. Drafting, submitting, approving
 * and issuing a B/L since CB-44; endorsing it to a named organisation since CB-45.
 */
@Injectable({providedIn: 'root'})
export class BlApi {
  private readonly api = inject(ApiService);

  /**
   * A page of the B/Ls the user's organisation is party to, newest first (CB-42).
   * @param page the page: how many, from where
   * @return the page and the total
   */
  list(page: {limit: number; offset: number}): Promise<BlPage> {
    return this.api.get<BlPage>('/records/title', page);
  }

  /**
   * One B/L's title, the user's roles on it and its chain of title; 404 for a B/L the
   * organisation does not see.
   * @param id the B/L's id
   * @return the title view
   */
  title(id: string): Promise<BlTitleView> {
    return this.api.get<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title`,
    );
  }

  /**
   * One B/L of the user's own organisation with its open draft (CB-44); 404 for another's.
   * @param id the B/L's id
   * @return the record
   */
  record(id: string): Promise<BlRecord> {
    return this.api.get<BlRecord>(`/records/${encodeURIComponent(id)}`);
  }

  /**
   * The organisations registered and active, whom a new B/L may name (CB-44) and its holder may
   * endorse it to (CB-45).
   * @return the organisations
   */
  async organisations(): Promise<PartyOrganisation[]> {
    const answer = await this.api.get<{items: PartyOrganisation[]}>(
      '/records/organisations',
    );
    return answer.items;
  }

  /**
   * Creates a B/L of the user's organisation, its first version a draft (CB-44).
   * @param request the document and its parties' organisations
   * @return the record
   */
  create(request: DraftRequest): Promise<BlRecord> {
    return this.api.post<BlRecord>('/records', request);
  }

  /**
   * Submits a draft for approval by a second person (CB-44).
   * @param id the B/L's id
   * @param version the draft's version number
   * @return the record
   */
  submit(id: string, version: number): Promise<BlRecord> {
    return this.api.post<BlRecord>(
      `/records/${encodeURIComponent(id)}/versions/${version}/submit`,
    );
  }

  /**
   * Approves a draft in review: a second person of the carrier, never its drafter (CB-44).
   * @param id the B/L's id
   * @param version the version in review
   * @return the record, its version committed
   */
  approve(id: string, version: number): Promise<BlRecord> {
    return this.api.post<BlRecord>(
      `/records/${encodeURIComponent(id)}/versions/${version}/approve`,
    );
  }

  /**
   * Runs a title command on a B/L as the user's organisation (CB-44: the issue).
   * @param id the B/L's id
   * @param command the command's name, one of the title's allowedCommands
   * @return the title view after it
   */
  command(id: string, command: string): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/${encodeURIComponent(command)}`,
    );
  }

  /**
   * Endorses a B/L the user's organisation holds to a named organisation, which becomes its
   * holder at once (CB-45).
   * @param id the B/L's id
   * @param to the id of the organisation picked
   * @return the title view after it
   */
  endorse(id: string, to: string): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/endorse`,
      endorseRequest(to),
    );
  }
}
