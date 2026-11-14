import {Injectable, inject} from '@angular/core';
import {ApiService} from '@lrfe/platform';
import type {BlPage, BlTitleView} from './bl.model';

/**
 * The calls of the shipping record service the B/L screens make (gateway prefix /api/records).
 * The organisation is always the session's: no call names one.
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
}
