import { Component, HostListener, inject } from '@angular/core';
import { ToastService } from '../state/toast.service';
import { ConfirmService } from '../state/confirm.service';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-overlays',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="toasts" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [class]="'toast ' + t.kind" role="status">
          <span class="ic"><app-icon [name]="icon(t.kind)" [size]="18" /></span>
          <div class="txt"><div class="t">{{ t.title }}</div>@if (t.detail) { <div class="d">{{ t.detail }}</div> }</div>
          <button class="x" (click)="toast.dismiss(t.id)" aria-label="Dismiss"><app-icon name="x" [size]="14" /></button>
        </div>
      }
    </div>
    @if (confirm.state(); as c) {
      <div class="dialog-backdrop" (click)="confirm.close(false)">
        <div class="dialog" role="alertdialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:nowrap">
            <span class="badge" [class.danger]="c.tone === 'danger'"><app-icon [name]="c.tone === 'danger' ? 'alert' : 'info'" [size]="20" /></span>
            <div class="stack" style="gap:6px">
              <div class="dialog-title">{{ c.title }}</div>
              <div class="dialog-body">{{ c.body }}</div>
            </div>
          </div>
          <div class="dialog-actions">
            <button class="btn btn-secondary" (click)="confirm.close(false)">{{ c.cancelLabel || 'Cancel' }}</button>
            <button class="btn" [class.btn-danger]="c.tone === 'danger'" [class.btn-primary]="c.tone !== 'danger'" (click)="confirm.close(true)">{{ c.confirmLabel || 'Confirm' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .toasts { position: fixed; right: 20px; bottom: 20px; z-index: 80; display: flex; flex-direction: column; gap: 10px; width: min(380px, calc(100vw - 32px)); }
    .toast { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: flex-start; padding: 12px 12px 12px 14px; background: var(--color-surface); border: 1px solid var(--color-divider); border-left: 4px solid var(--color-accent); border-radius: var(--radius-md); box-shadow: var(--shadow-md); animation: slide-in .2s ease-out; }
    .toast.success { border-left-color: var(--success); } .toast.success .ic { color: var(--success); }
    .toast.warn { border-left-color: var(--warn); } .toast.warn .ic { color: var(--warn); }
    .toast.danger { border-left-color: var(--danger); } .toast.danger .ic { color: var(--danger); }
    .toast.info .ic { color: var(--color-accent); }
    .t { font-weight: 700; font-size: 14px; }
    .d { font-size: 13px; color: var(--color-neutral-700); margin-top: 2px; overflow-wrap: anywhere; }
    .x { border: 0; background: transparent; color: var(--color-neutral-600); cursor: pointer; padding: 4px; border-radius: 6px; }
    .x:hover { background: var(--color-neutral-200); }
    .badge { width: 40px; height: 40px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--color-accent-100); color: var(--color-accent-600); }
    .badge.danger { background: var(--danger-bg); color: var(--danger); }
  `]
})
export class OverlaysComponent {
  toast = inject(ToastService);
  confirm = inject(ConfirmService);
  icon(k: string) { return k === 'success' ? 'checkCircle' : k === 'danger' || k === 'warn' ? 'alert' : 'info'; }
  @HostListener('document:keydown.escape') esc() { if (this.confirm.state()) this.confirm.close(false); }
}
