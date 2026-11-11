/**
 * icons.js — inline SVG icons for JS-built UI (toolbar icons live directly
 * in index.html). 24px grid, stroke-based, inherits currentColor.
 */

const svg = (paths, viewBox = '0 0 24 24') =>
  `<svg width="15" height="15" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  pin: svg('<path d="M12 17v5"/><path d="M9 3h6l1 7 2.5 2.5a1 1 0 0 1-.7 1.7H6.2a1 1 0 0 1-.7-1.7L8 10z"/>'),
  pinned: svg('<path d="M12 17v5"/><path d="M9 3h6l1 7 2.5 2.5a1 1 0 0 1-.7 1.7H6.2a1 1 0 0 1-.7-1.7L8 10z" fill="currentColor"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  external: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  up: svg('<path d="m18 15-6-6-6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  doc: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  bookmark: svg('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0 2 5.3"/><path d="M20 4v7h-7"/>'),
  globe: svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  spinner: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="spin"><path d="M21 12a9 9 0 1 1-6.2-8.56" stroke-linecap="round"/></svg>`,
  offline: svg('<path d="m2 2 20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.5a9.7 9.7 0 0 1 5.4-2.8M16.2 10.6c1 .5 2 1.1 2.8 1.9"/><path d="M2 8.8A15.7 15.7 0 0 1 7 6M12.7 5.1A15.7 15.7 0 0 1 22 8.8"/><path d="M12 20h.01"/>'),
  chevronRight: svg('<path d="m9 18 6-6-6-6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  rotate: svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
};
