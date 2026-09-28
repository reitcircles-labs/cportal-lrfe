import { Injectable, signal } from '@angular/core';
import { ViewerCtx } from '../data/models';

export interface ViewerState { ctx: ViewerCtx; docId: string; page: number; recordId?: string; }

@Injectable({ providedIn: 'root' })
export class ViewerService {
  readonly state = signal<ViewerState | null>(null);
  open(ctx: ViewerCtx, docId: string, page = 0, recordId?: string) { this.state.set({ ctx, docId, page, recordId }); }
  go(docId: string, page: number) { const s = this.state(); if (s) this.state.set({ ...s, docId, page }); }
  close() { this.state.set(null); }
}
