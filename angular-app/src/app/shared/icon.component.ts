import { Component, input } from '@angular/core';

/** Lucide icons at stroke 1.5 (design-system rule). */
const PATHS: Record<string, string[]> = {
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z'],
  check: ['M20 6 9 17 4 12'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  left: ['M15 18 9 12 15 6'],
  right: ['M9 18 15 12 9 6'],
  up: ['M18 15 12 9 6 15'],
  down: ['M6 9 12 15 18 9'],
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M21 21l-4.35-4.35'],
  zoomIn: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M21 21l-4.35-4.35', 'M8 11h6', 'M11 8v6'],
  zoomOut: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M21 21l-4.35-4.35', 'M8 11h6'],
  rotate: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  sort: ['M3 6h13', 'M3 12h9', 'M3 18h5', 'M17 15l3 3 3-3', 'M20 6v12'],
  panelClose: ['M3 3h18v18H3z', 'M9 3v18', 'M16 15l-3-3 3-3'],
  panelOpen: ['M3 3h18v18H3z', 'M9 3v18', 'M13 9l3 3-3 3'],
  scan: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M7 12h10'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']
};

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">
    @for (d of paths(); track $index) { <path [attr.d]="d"></path> }
  </svg>`,
  styles: [':host{display:inline-flex}']
})
export class IconComponent {
  name = input.required<string>();
  size = input(16);
  paths() { return PATHS[this.name()] || []; }
}
