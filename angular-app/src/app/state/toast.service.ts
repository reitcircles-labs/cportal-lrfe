import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'info' | 'warn' | 'danger';
export interface Toast { id: number; kind: ToastKind; title: string; detail?: string; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;
  show(kind: ToastKind, title: string, detail?: string, ms = 4200) {
    const id = ++this.seq;
    this.toasts.update(t => [...t, { id, kind, title, detail }].slice(-4));
    setTimeout(() => this.dismiss(id), ms);
  }
  dismiss(id: number) { this.toasts.update(t => t.filter(x => x.id !== id)); }
}
