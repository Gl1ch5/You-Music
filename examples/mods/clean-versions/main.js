// Hooks example: filters search results and recommendations, adds a track-menu item.
const EDITS = /\b(sped[\s-]*up|speed[\s-]*up|slowed|reverb|nightcore|8d|bass\s*boost(ed)?)\b/i;

mod.hooks.searchResults((tracks, { query }) => (EDITS.test(query) ? tracks : tracks.filter((t) => !EDITS.test(t.title))));

mod.hooks.recommendations((tracks) => tracks.filter((t) => !EDITS.test(t.title)));

mod.ui.addMenuItem({
  id: 'original',
  label: 'Играть оригинал',
  icon: 'sparkle',
  async onClick(track) {
    const base = track.title.replace(/[([][^)\]]*[)\]]/g, '').replace(EDITS, '').trim();
    const items = await mod.search(`${track.artist} ${base}`, 'songs');
    const original = items.map((i) => i.track).find((t) => t && !EDITS.test(t.title) && t.id !== track.id);
    if (!original) return mod.ui.toast('Оригинал не найден');
    mod.player.play([original]);
  },
});

