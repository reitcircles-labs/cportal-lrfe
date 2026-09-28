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
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5', 'M10 21v-6h4v6'],
  flow: ['M4 6h6v4H4z', 'M14 14h6v4h-6z', 'M7 10v3a2 2 0 0 0 2 2h5'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  sun: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M6.34 17.66l-1.41 1.41', 'M19.07 4.93l-1.41 1.41'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  checkCircle: ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4 12 14.01l-3-3'],
  alert: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z', 'M12 16v-4', 'M12 8h.01'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h5'],
  layers: ['M12 2 2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  token: ['M12 2 3 7v10l9 5 9-5V7z', 'M12 22V12', 'M21 7l-9 5-9-5'],
  clock: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z', 'M12 6v6l4 2'],
  arrowRight: ['M5 12h14', 'M12 5l7 7-7 7'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  idcard: ['M3 5h18v14H3z', 'M8 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z', 'M13 10h5', 'M13 14h3']
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
