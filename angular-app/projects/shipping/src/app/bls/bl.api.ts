import {Injectable, inject} from '@angular/core';
import type {Port} from './bl-ports';
import {ApiService} from '@lrfe/platform';
import type {AmendRequest} from './bl-amend';
import type {DraftRequest} from './bl-draft';
import type {SplitRequest} from './bl-split';
import type {Jwks, TitleProof} from './bl-check';
import {endorseRequest, type EndorseMode} from './bl-endorse';
import type {
  BlLink,
  BlListItem,
  BlPage,
  BlRecord,
  BlTitleView,
  PartyOrganisation,
} from './bl.model';

/**
 * The calls of the shipping record service the B/L screens make (gateway prefix /api/records).
 * The organisation is always the session's: no call names one. Drafting, submitting, approving
 * and issuing a B/L since CB-44; endorsing it to a named organisation since CB-45; surrendering
 * it and releasing its goods since CB-46; finding one by its number, its proof file and the
 * platform's keys since CB-47; amending it and splitting it into new B/Ls since CB-50.
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
   * The B/Ls of a number among those the user's organisation is party to (CB-47): none for a
   * number nobody uses and for another organisation's B/L alike; two carriers may use the same.
   * @param number the B/L number, as typed without the spaces around it
   * @return the B/Ls found
   */
  async findByNumber(number: string): Promise<BlListItem[]> {
    const page = await this.api.get<BlPage>('/records/title', {number});
    return page.items;
  }

  /**
   * One B/L's proof file (`lrfe-title-proof/1`, CB-47): its chain of title, the platform's keys
   * and the proof of the latest step on the blockchain; 503 while that proof cannot be read.
   * @param id the B/L's id
   * @return the proof file
   */
  proof(id: string): Promise<TitleProof> {
    return this.api.get<TitleProof>(
      `/records/${encodeURIComponent(id)}/title/proof`,
    );
  }

  /**
   * The platform's public keys of the chain of title, as it publishes them (CB-47): their
   * fingerprint pins them in the offline check.
   * @return the key set
   */
  titleKeys(): Promise<Jwks> {
    return this.api.get<Jwks>('/records/title/keys');
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
   * Searches the port list by code or name (CB-63).
   * @param query part of a code or a port's name
   * @return the matching ports, at most 20
   */
  async ports(query: string): Promise<Port[]> {
    const answer = await this.api.get<{items: Port[]}>(
      `/records/ports?q=${encodeURIComponent(query)}`,
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
   * Runs a title command on a B/L as the user's organisation (CB-44: the issue;
   * CB-46: the surrender and the release).
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
   * Switches a B/L to paper (the holder) or voids it (the carrier) (CB-51); a blank-endorsed B/L
   * switched to paper carries the bearer confirmation.
   * @param id the B/L's id
   * @param command the switch to paper or the void
   * @param body the bearer confirmation, undefined when there is none
   * @return the title view after it
   */
  close(
    id: string,
    command: string,
    body: {confirmBearer: true} | undefined,
  ): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/${encodeURIComponent(command)}`,
      body,
    );
  }

  /**
   * Endorses a B/L the user's organisation holds to a named organisation, which becomes its
   * holder at once (CB-45), by name or in blank (CB-52).
   * @param id the B/L's id
   * @param to the id of the organisation picked
   * @param mode by name or in blank
   * @return the title view after it
   */
  endorse(id: string, to: string, mode: EndorseMode): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/endorse`,
      endorseRequest(to, mode),
    );
  }

  /**
   * Transfers a blank-endorsed B/L the user's organisation holds to another organisation, which
   * becomes its holder at once (CB-52).
   * @param id the B/L's id
   * @param to the id of the organisation picked
   * @return the title view after it
   */
  transfer(id: string, to: string): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/transfer`,
      {to},
    );
  }

  /**
   * Amends a B/L the carrier holds for a change: its new document becomes the next version, and
   * the B/L goes back to the holder who asked (CB-50).
   * @param id the B/L's id
   * @param request the format and the new document
   * @return the title view after it
   */
  amend(id: string, request: AmendRequest): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/amend`,
      request,
    );
  }

  /**
   * Splits a B/L the carrier holds for a change into new B/Ls, one per document, issued to the
   * holder who asked; the B/L is closed (CB-50).
   * @param id the B/L's id
   * @param request one document per new B/L
   * @return the parent's title view after it, with its children
   */
  split(
    id: string,
    request: SplitRequest,
  ): Promise<BlTitleView & {children: BlLink[]}> {
    return this.api.post<BlTitleView & {children: BlLink[]}>(
      `/records/${encodeURIComponent(id)}/title/split`,
      request,
    );
  }
}
