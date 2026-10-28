/**
 * Graphite icon set: 24px grid, 1.5px stroke (var(--icon-stroke)), round caps and joins, colour = currentColor.
 * Inactive states use the outline glyph, active states the `-fill` glyph.
 * Sets are swappable at runtime (themes pick a set by name, mods can register sets or override single icons).
 */

export type IconSet = Record<string, string>;

const filledMasked = (id: string, shape: string, cut: string) =>
  `<mask id="m-${id}"><rect width="24" height="24" fill="#fff"/><g stroke="#000" fill="none">${cut}</g></mask>` +
  `<g mask="url(#m-${id})" fill="currentColor" stroke="none">${shape}</g>`;

const HEART = 'M12 19.6s-7.6-4.5-7.6-10a4.3 4.3 0 0 1 7.6-2.8 4.3 4.3 0 0 1 7.6 2.8c0 5.5-7.6 10-7.6 10z';
const WAVE_LINE = 'M6.5 12h1.8l1.6-3.4 2.2 6.8 2.1-8.8 1.6 5.4h1.7';

export const graphiteIcons: IconSet = {
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.2-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  next: '<path d="M5.5 6.4v11.2a.9.9 0 0 0 1.4.75l8.3-5.6a.9.9 0 0 0 0-1.5L6.9 5.65a.9.9 0 0 0-1.4.75z" fill="currentColor" stroke="none"/><path d="M18.5 5.5v13"/>',
  prev: '<path d="M18.5 6.4v11.2a.9.9 0 0 1-1.4.75l-8.3-5.6a.9.9 0 0 1 0-1.5l8.3-5.6a.9.9 0 0 1 1.4.75z" fill="currentColor" stroke="none"/><path d="M5.5 5.5v13"/>',
  shuffle: '<path d="M3.5 7h2.8c1.9 0 3 .8 4.1 2.5l2.6 5c1.1 1.7 2.2 2.5 4.1 2.5h3.4"/><path d="M3.5 17h2.8c1.2 0 2.1-.3 2.9-1"/><path d="M14.6 8c.8-.7 1.7-1 2.9-1h3"/><path d="m18.3 4.6 2.4 2.4-2.4 2.4"/><path d="m18.3 14.6 2.4 2.4-2.4 2.4"/>',
  repeat: '<path d="m16.8 3.6 2.6 2.6-2.6 2.6"/><path d="M4.6 11.6V10a3.8 3.8 0 0 1 3.8-3.8h11"/><path d="m7.2 20.4-2.6-2.6 2.6-2.6"/><path d="M19.4 12.4V14a3.8 3.8 0 0 1-3.8 3.8h-11"/>',
  'repeat-one': '<path d="m16.8 3.6 2.6 2.6-2.6 2.6"/><path d="M4.6 11.6V10a3.8 3.8 0 0 1 3.8-3.8h11"/><path d="m7.2 20.4-2.6-2.6 2.6-2.6"/><path d="M19.4 12.4V14a3.8 3.8 0 0 1-3.8 3.8h-11"/><path d="M11.2 10.6 12.4 10v4.2"/>',
  heart: `<path d="${HEART}"/>`,
  'heart-fill': `<path d="${HEART}" fill="currentColor"/>`,
  more: '<circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>',
  back: '<path d="M19 12H5.5"/><path d="m11 6-6 6 6 6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  search: '<circle cx="11" cy="11" r="6.3"/><path d="m19.5 19.5-4-4"/>',
  'search-fill': '<circle cx="11" cy="11" r="6.3" stroke-width="2.4"/><path d="m19.5 19.5-4-4" stroke-width="2.4"/>',
  wave: `<circle cx="12" cy="12" r="8.8"/><path d="${WAVE_LINE}"/>`,
  'wave-fill': filledMasked('wave', '<circle cx="12" cy="12" r="9.5"/>', `<path d="${WAVE_LINE}" stroke-width="1.6"/>`),
  library: '<rect x="4" y="9.5" width="16" height="10.5" rx="2.5"/><path d="M6.5 6.3h11M9 3.3h6"/>',
  'library-fill': '<rect x="4" y="9.5" width="16" height="10.5" rx="2.5" fill="currentColor"/><path d="M6.5 6.3h11M9 3.3h6"/>',
  queue: '<path d="M4 6.5h16M4 11.5h16M4 16.5h8.5"/><path d="M16 14.5v5.2l4.2-2.6z" fill="currentColor"/>',
  lyrics: '<path d="M4.5 5.5h15M4.5 10h15M4.5 14.5h8.5M4.5 19h5.5"/><path d="M18.2 13v5.6"/><circle cx="16.6" cy="18.6" r="1.6"/>',
  filter: '<path d="M4 7h16M7 12h10M10 17h4"/>',
  similar: '<circle cx="8.5" cy="12" r="4.6"/><circle cx="15.5" cy="12" r="4.6"/>',
  download: '<path d="M12 4v11"/><path d="m7.2 10.6 4.8 4.8 4.8-4.8"/><path d="M5 19.6h14"/>',
  downloaded: filledMasked('dl', '<circle cx="12" cy="12" r="9"/>', '<path d="M12 7v8.2" stroke-width="1.6"/><path d="m8.6 12 3.4 3.4 3.4-3.4" stroke-width="1.6"/>'),
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2"/><path d="m7 7 .8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/>',
  share: '<path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12"/>',
  edit: '<path d="M5 19h4L19 9l-4-4L5 15z"/><path d="m13.5 6.5 4 4"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  note: '<path d="M9 17.5V6.2l10-2.2v11.3"/><circle cx="6.6" cy="17.5" r="2.4"/><circle cx="16.6" cy="15.3" r="2.4"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  file: '<path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M14 3.5v4h4"/><circle cx="10.5" cy="16" r="1.5"/><path d="M12 16v-5l2.5 1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5a7 7 0 0 1 14 0"/>',
  disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/>',
  playlist: '<path d="M4 6h11M4 10.5h11M4 15h7"/><path d="M17.2 18.5V8l3.3-1"/><circle cx="15.4" cy="18.5" r="1.8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.3v.2"/>',
  offline: '<path d="m3.5 3.5 17 17"/><path d="M5 9.6a11 11 0 0 1 3-2.1M10.8 6.1A11 11 0 0 1 19 9.6M8 13.2a6.5 6.5 0 0 1 2.8-1.6M14.8 12.2a6.5 6.5 0 0 1 1.2.9M12 17.6v.1"/>',
  sparkle: '<path d="M12 3.5c.6 4.4 2.6 6.9 7.5 8.5-4.9 1.6-6.9 4.1-7.5 8.5-.6-4.4-2.6-6.9-7.5-8.5 4.9-1.6 6.9-4.1 7.5-8.5z"/>',
  puzzle: '<path d="M10 4.5a2 2 0 0 1 4 0V6h3.5A1.5 1.5 0 0 1 19 7.5V11h-1.5a2 2 0 0 0 0 4H19v3.5a1.5 1.5 0 0 1-1.5 1.5H14v-1.5a2 2 0 0 0-4 0V20H6.5A1.5 1.5 0 0 1 5 18.5V15h1.5a2 2 0 0 0 0-4H5V7.5A1.5 1.5 0 0 1 6.5 6H10z"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.7 1.7-1.7H17a3.5 3.5 0 0 0 3.5-3.5c0-4.2-3.8-7.5-8.5-7.5z"/><circle cx="7.8" cy="11.5" r="1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="7.8" r="1" fill="currentColor" stroke="none"/>',
  import: '<path d="M12 4v10"/><path d="m8 10 4 4 4-4"/><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  export: '<path d="M12 14V4"/><path d="m8 8 4-4 4 4"/><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  storage: '<ellipse cx="12" cy="6.5" rx="7" ry="2.8"/><path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11"/><path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.7v.2"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
};

const sets = new Map<string, IconSet>([['graphite', graphiteIcons]]);
const overrides: Record<string, string> = {};
let activeSet = 'graphite';

export function registerIconSet(name: string, set: IconSet): void {
  sets.set(name, set);
}

export function iconSetNames(): string[] {
  return [...sets.keys()];
}

export function useIconSet(name: string): void {
  activeSet = sets.has(name) ? name : 'graphite';
  render();
}

/** Overrides single glyphs on top of the active set; pass `null` to restore. */
export function overrideIcons(map: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(map)) {
    if (v == null) delete overrides[k];
    else overrides[k] = v;
  }
  render();
}

function render(): void {
  const base = { ...graphiteIcons, ...sets.get(activeSet), ...overrides };
  let sprite = document.getElementById('icon-sprite');
  if (!sprite) {
    sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as HTMLElement;
    sprite.id = 'icon-sprite';
    sprite.setAttribute('aria-hidden', 'true');
    sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    document.body.prepend(sprite);
  }
  sprite.innerHTML = Object.entries(base)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
}
