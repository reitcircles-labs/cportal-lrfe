import { Injectable, effect, signal } from '@angular/core';

const KEY = 'lr-demo-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<'light' | 'dark'>((localStorage.getItem(KEY) as 'light' | 'dark') ||
    (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  constructor() {
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem(KEY, t);
    });
  }
  toggle() { this.theme.set(this.theme() === 'dark' ? 'light' : 'dark'); }
}
