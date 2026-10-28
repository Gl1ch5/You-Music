import { graphiteIcons, registerIconSet, type IconSet } from './icons';

/**
 * Extra icon packs a user can pick in Settings → «Значки». Each pack redraws the most visible glyphs in its style;
 * anything it does not redraw falls back to Graphite. Same 24px grid, colour = currentColor.
 */

const HEART_ROUND = 'M12 20.2c-.3 0-.6-.1-.8-.3C7.8 17.4 3.8 14 3.8 9.4A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8.2 2.8c0 4.6-4 8-7.4 10.5-.2.2-.5.3-.8.3z';

/** Strokes a whole pack at its own width (a pack looks wrong at another weight). */
function stroked(set: IconSet, width: number): IconSet {
  return Object.fromEntries(Object.entries(set).map(([k, v]) => [k, `<g stroke-width="${width}">${v}</g>`]));
}

/** iOS: SF Symbols-like — fine strokes, horizontal «•••», chevron back, circled download. */
export const iosIcons: IconSet = stroked(
  {
    play: '<path d="M7.5 5.2v13.6c0 .9 1 1.5 1.8 1l11-6.8a1.2 1.2 0 0 0 0-2l-11-6.8c-.8-.5-1.8.1-1.8 1z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.8" y="4.5" width="3.2" height="15" rx="1.1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="3.2" height="15" rx="1.1" fill="currentColor" stroke="none"/>',
    next: '<path d="M4.5 6.6v10.8c0 .8.9 1.3 1.6.8l7.6-5.4a1 1 0 0 0 0-1.6L6.1 5.8c-.7-.5-1.6 0-1.6.8z" fill="currentColor" stroke="none"/><rect x="16.3" y="5.2" width="2.6" height="13.6" rx="1" fill="currentColor" stroke="none"/>',
    prev: '<path d="M19.5 6.6v10.8c0 .8-.9 1.3-1.6.8l-7.6-5.4a1 1 0 0 1 0-1.6l7.6-5.4c.7-.5 1.6 0 1.6.8z" fill="currentColor" stroke="none"/><rect x="5.1" y="5.2" width="2.6" height="13.6" rx="1" fill="currentColor" stroke="none"/>',
    more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    back: '<path d="m14.5 4.8-7.2 7.2 7.2 7.2"/>',
    'chevron-down': '<path d="m5.5 9 6.5 6.5L18.5 9"/>',
    'chevron-right': '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 4.6 4.6"/>',
    'search-fill': '<circle cx="10.5" cy="10.5" r="6.5" stroke-width="2.4"/><path d="m15.4 15.4 4.6 4.6" stroke-width="2.6"/>',
    heart: `<path d="${HEART_ROUND}"/>`,
    'heart-fill': `<path d="${HEART_ROUND}" fill="currentColor"/>`,
    wave: '<circle cx="12" cy="12" r="2"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>',
    'wave-fill': '<circle cx="12" cy="12" r="2.6" fill="currentColor"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4" stroke-width="2.2"/>',
    library: '<rect x="3.5" y="8.5" width="17" height="12" rx="3"/><path d="M6 5.5h12"/>',
    'library-fill': '<rect x="3.5" y="8.5" width="17" height="12" rx="3" fill="currentColor"/><path d="M6 5.5h12" stroke-width="2"/>',
    queue: '<circle cx="5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.2" fill="currentColor" stroke="none"/><path d="M9 6.5h11M9 12h11M9 17.5h11"/>',
    lyrics: '<path d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17h-1A2.5 2.5 0 0 1 3 14.5v-8A2.5 2.5 0 0 1 5.5 4z"/><path d="M7.5 8.5h9M7.5 12.5h6"/>',
    download: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v8.5M8.3 12.6 12 16.3l3.7-3.7"/>',
    share: '<path d="M12 3.5v11M8.2 7.2 12 3.5l3.8 3.7"/><path d="M8.5 10.5H7A2 2 0 0 0 5 12.5v6A2 2 0 0 0 7 20.5h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5"/>',
    trash: '<path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="m6.5 6.5.9 12.2a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.9-12.2M10 10.5v6M14 10.5v6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/>',
    user: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.3 18.4a6.5 6.5 0 0 1 11.4 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12h4"/>',
    plus: '<path d="M12 4.5v15M4.5 12h15"/>',
    check: '<path d="m4.8 12.6 4.6 4.6L19.2 7"/>',
    playlist: '<path d="M3.5 6h12M3.5 10.5h12M3.5 15h7"/><circle cx="16.5" cy="17.5" r="2.5"/><path d="M19 17.5V7l2.5-.8"/>',
    note: '<circle cx="7" cy="17.5" r="2.8"/><circle cx="17" cy="15.5" r="2.8"/><path d="M9.8 17.5V6l10-2v11.5M9.8 9.5l10-2"/>',
  },
  1.6,
);

/** One UI: bold rounded strokes, roomy rounded rectangles, vertical «⋮». */
export const oneUiIcons: IconSet = stroked(
  {
    play: '<path d="M8 6.1v11.8a1.6 1.6 0 0 0 2.4 1.4l9.4-5.9a1.6 1.6 0 0 0 0-2.8l-9.4-5.9A1.6 1.6 0 0 0 8 6.1z" fill="currentColor" stroke="currentColor" stroke-width="1"/>',
    pause: '<rect x="6" y="5" width="4.4" height="14" rx="2.2" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="4.4" height="14" rx="2.2" fill="currentColor" stroke="none"/>',
    next: '<path d="M5 7v10a1.4 1.4 0 0 0 2.2 1.1l7-5a1.4 1.4 0 0 0 0-2.2l-7-5A1.4 1.4 0 0 0 5 7z" fill="currentColor" stroke="none"/><path d="M18.5 6v12"/>',
    prev: '<path d="M19 7v10a1.4 1.4 0 0 1-2.2 1.1l-7-5a1.4 1.4 0 0 1 0-2.2l7-5A1.4 1.4 0 0 1 19 7z" fill="currentColor" stroke="none"/><path d="M5.5 6v12"/>',
    more: '<circle cx="12" cy="5.3" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="18.7" r="1.8" fill="currentColor" stroke="none"/>',
    back: '<path d="M19.5 12h-14"/><path d="m11 5.8-6.2 6.2 6.2 6.2"/>',
    'chevron-down': '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    'chevron-right': '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
    close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/>',
    'search-fill': '<circle cx="10.8" cy="10.8" r="6.8" stroke-width="2.8"/><path d="m16 16 4 4" stroke-width="2.8"/>',
    heart: `<path d="${HEART_ROUND}"/>`,
    'heart-fill': `<path d="${HEART_ROUND}" fill="currentColor"/>`,
    wave: '<rect x="3.5" y="3.5" width="17" height="17" rx="6"/><path d="M7.5 12h1.4l1.4-3 2 6 1.9-7.5 1.4 4.5h1.4"/>',
    'wave-fill': '<rect x="3.5" y="3.5" width="17" height="17" rx="6" fill="currentColor"/><path d="M7.5 12h1.4l1.4-3 2 6 1.9-7.5 1.4 4.5h1.4" stroke="var(--bg)"/>',
    library: '<rect x="3.5" y="7.5" width="17" height="13" rx="4.5"/><path d="M7 4h10"/><path d="M10.5 16.5v-5l4-1v5"/><circle cx="9.6" cy="16.5" r=".9"/>',
    'library-fill': '<rect x="3.5" y="7.5" width="17" height="13" rx="4.5" fill="currentColor"/><path d="M7 4h10"/><path d="M10.5 16.5v-5l4-1v5" stroke="var(--bg)"/>',
    queue: '<path d="M4 6.5h16M4 12h10M4 17.5h8"/><path d="M16.5 14.5v6l4.5-3z" fill="currentColor" stroke-linejoin="round"/>',
    lyrics: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h5"/>',
    download: '<path d="M12 3.8v10.5M7.6 10l4.4 4.4 4.4-4.4"/><rect x="4" y="17.5" width="16" height="2.5" rx="1.25" fill="currentColor" stroke="none"/>',
    share: '<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="m8.7 10.7 6.6-3.9M8.7 13.3l6.6 3.9"/>',
    trash: '<path d="M4 6.5h16M9 6.5V4.5h6v2"/><rect x="6" y="6.5" width="12" height="14" rx="3"/><path d="M10 10.5v6M14 10.5v6"/>',
    folder: '<path d="M3.5 8a3 3 0 0 1 3-3h3.3l2 2.2h5.7a3 3 0 0 1 3 3V17a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3z"/>',
    user: '<circle cx="12" cy="8.3" r="3.8"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0z"/>',
    clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.3V12l3.3 2.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    playlist: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M7.5 8.5h6M7.5 12h6M7.5 15.5h3.5"/><path d="M16 15.5v-6l2-.6"/><circle cx="15" cy="15.5" r="1"/>',
    note: '<path d="M9.5 17.5V6.5l9.5-2.3V15"/><circle cx="7" cy="17.5" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15" r="2.5" fill="currentColor"/>',
  },
  2,
);

export const ICON_PACKS: { id: string; name: string; set: IconSet }[] = [
  { id: 'graphite', name: 'Graphite', set: graphiteIcons },
  { id: 'ios', name: 'iOS', set: iosIcons },
  { id: 'oneui', name: 'One UI', set: oneUiIcons },
];

for (const p of ICON_PACKS) if (p.id !== 'graphite') registerIconSet(p.id, p.set);
