import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {Injectable, inject} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import type {Port} from './bl-ports';
import type {CarrierOption} from './carrier-picker';
import {ApiError, ApiService, toApiError} from '@lrfe/platform';
import type {AmendRequest} from './bl-amend';
import type {DraftRequest, PaperReading} from './bl-draft';
import type {SplitRequest} from './bl-split';
import type {Jwks, TitleProof} from './bl-check';
import {endorseRequest, type EndorseMode} from './bl-endorse';
import type {
  BlLink,
  BlListItem,
  BlPage,
  BlRecord,
  BlTitleView,
  ConnectedPlatform,
  PartyLookupResult,
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
  private readonly http = inject(HttpClient);

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
   * Replaces the open draft of a B/L (CB-70): by its author only, before approval.
   * @param id the B/L's id
   * @param request the document, parties' organisations and optional revision
   * @return the record
   */
  saveDraft(
    id: string,
    request: DraftRequest & {revision?: number},
  ): Promise<BlRecord> {
    return this.api.put<BlRecord>(
      `/records/${encodeURIComponent(id)}/draft`,
      request,
    );
  }

  /**
   * Archives a never-issued draft B/L (CB-71): frees its number and hides it from lists.
   * @param id the B/L's id
   * @return the record
   */
  archive(id: string): Promise<BlRecord> {
    return this.api.post<BlRecord>(
      `/records/${encodeURIComponent(id)}/archive`,
    );
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
   * @param revision the revision the approver saw (CB-70)
   * @return the record, its version committed
   */
  approve(id: string, version: number, revision?: number): Promise<BlRecord> {
    return this.api.post<BlRecord>(
      `/records/${encodeURIComponent(id)}/versions/${version}/approve`,
      revision !== undefined ? {revision} : undefined,
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
   * Asks the carrier for a change with the holder's reason (CB-85).
   * @param id the B/L's id
   * @param reason what needs to change
   * @return the title view after it
   */
  askForChange(id: string, reason: string): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/surrender-for-amendment`,
      {reason},
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
   * Downloads the printable paper B/L PDF once switched to paper (CB-86).
   * @param id the B/L's id
   * @return PDF blob
   */
  async paperPdf(id: string): Promise<Blob> {
    try {
      return await firstValueFrom(
        this.http.get(
          `${this.api.base}/records/${encodeURIComponent(id)}/paper`,
          {
            responseType: 'blob',
          },
        ),
      );
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.error instanceof Blob) {
        let message = e.statusText || 'Request failed';
        let details: unknown;
        try {
          const body = JSON.parse(await e.error.text()) as {
            message?: string;
            details?: unknown;
          };
          message = body.message || message;
          details = body.details;
        } catch {
          // Non-JSON error body: keep the HTTP status text.
        }
        throw new ApiError(e.status, message, details);
      }
      throw toApiError(e);
    }
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

  /**
   * Reads a scanned paper B/L file automatically into pre-filled draft fields (CB-57).
   * @param fileName file name
   * @param mimeType MIME type (PDF or image)
   * @param contentBase64 base64 file bytes
   * @return extracted fields, uncertain flags, and summary
   */
  readPaper(
    fileName: string,
    mimeType: string,
    contentBase64: string,
  ): Promise<PaperReading> {
    return this.api.post<PaperReading>('/records/read-paper', {
      fileName,
      mimeType,
      contentBase64,
    });
  }

  /**
   * Lists connected eBL platforms (CB-55).
   * @return connected platforms
   */
  async platforms(): Promise<ConnectedPlatform[]> {
    const answer = await this.api.get<{items: ConnectedPlatform[]}>(
      '/records/platforms',
    );
    return answer.items;
  }

  /**
   * Registers a connected eBL platform (CB-55).
   * @param body platform code, name, baseUrl, and public JWKS
   * @return created platform
   */
  createPlatform(body: {
    code: string;
    name: string;
    baseUrl: string;
    jwks: {keys: unknown[]};
    agreementDate?: string;
  }): Promise<ConnectedPlatform> {
    return this.api.post<ConnectedPlatform>('/records/platforms', body);
  }

  /**
   * Suspends or reactivates a connected eBL platform (CB-55).
   * @param code platform code
   * @param action suspend or reactivate
   * @return updated platform
   */
  setPlatformStatus(
    code: string,
    action: 'suspend' | 'reactivate',
  ): Promise<ConnectedPlatform> {
    return this.api.post<ConnectedPlatform>(
      `/records/platforms/${encodeURIComponent(code)}/${action}`,
      {},
    );
  }

  /**
   * Checks a receiver party code on a connected peer platform (CB-55).
   * @param platform peer platform code
   * @param partyCode party code on that platform
   * @return confirmed party name
   */
  lookupPeerParty(
    platform: string,
    partyCode: string,
  ): Promise<PartyLookupResult> {
    return this.api.get<PartyLookupResult>(
      `/records/pint/lookup-party?platform=${encodeURIComponent(platform)}&partyCode=${encodeURIComponent(partyCode)}`,
    );
  }

  /**
   * Sends a B/L out to a party on another eBL platform (CB-55).
   * @param id B/L record id
   * @param body platform code, receiver party code, and optional inBlank
   * @return updated title view
   */
  transferOut(
    id: string,
    body: {platform: string; partyCode: string; inBlank?: boolean},
  ): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/transfer-out`,
      body,
    );
  }

  /**
   * Retries a locked outgoing cross-platform transfer (CB-55).
   * @param id B/L record id
   * @return updated title view
   */
  retryTransfer(id: string): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/retry-transfer`,
      {},
    );
  }

  /**
   * Keeps an arrived B/L from another platform (`arrived` -> `with-holder`, CB-55).
   * @param id B/L record id
   * @return updated title view
   */
  acceptIncoming(id: string): Promise<BlTitleView> {
    return this.api.post<BlTitleView>(
      `/records/${encodeURIComponent(id)}/title/accept-incoming`,
      {},
    );
  }
}
