import { Directive, ElementRef, computed, effect, inject, input } from '@angular/core';
import { RbacService } from '../state/rbac.service';

/**
 * Permission gate for actions: <button appCan="record.finalize" (click)="…">.
 * Without the permission the control looks disabled, explains why on hover,
 * and a click is blocked (logged as an access-denied event) before the handler runs.
 */
@Directive({
  selector: '[appCan]',
  standalone: true,
  host: { '[class.denied]': '!allowed()', '[attr.aria-disabled]': 'allowed() ? null : "true"' }
})
export class CanDirective {
  appCan = input.required<string>();
  private rbac = inject(RbacService);
  private el = inject(ElementRef<HTMLElement>);
  private orig: string | null | undefined;
  allowed = computed(() => this.rbac.can(this.appCan()));

  constructor() {
    this.el.nativeElement.addEventListener('click', (e: Event) => {
      if (this.allowed()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.rbac.deny(this.appCan());
    }, true);
    effect(() => {
      const el = this.el.nativeElement as HTMLElement;
      if (this.orig === undefined) this.orig = el.getAttribute('title');
      if (this.allowed()) { this.orig ? el.setAttribute('title', this.orig) : el.removeAttribute('title'); }
      else el.setAttribute('title', 'Requires “' + this.rbac.permLabel(this.appCan()) + '”. Not granted to ' + this.rbac.roleLabel() + '.');
    });
  }
}
