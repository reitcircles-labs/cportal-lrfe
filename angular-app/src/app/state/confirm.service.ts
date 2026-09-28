import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions { title: string; body: string; confirmLabel?: string; cancelLabel?: string; tone?: 'primary' | 'danger'; }
interface ConfirmState extends ConfirmOptions { resolve: (ok: boolean) => void; }

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly state = signal<ConfirmState | null>(null);
  ask(opts: ConfirmOptions): Promise<boolean> {
    return new Promise(resolve => this.state.set({ ...opts, resolve }));
  }
  close(ok: boolean) {
    const s = this.state();
    this.state.set(null);
    s?.resolve(ok);
  }
}
