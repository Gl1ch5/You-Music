import type { Track } from '../bridge/contract';
import type { Vibe } from './features';

/**
 * Recommendation filters. They combine: every active filter must accept a song. A song the filter cannot judge
 * yet (no audio data) stays possible but drops down; a song that clearly fails is removed.
 */

export type RecoFilter = 'popular' | 'new' | 'ru' | 'foreign' | 'instrumental' | 'energetic' | 'calm';

export const RECO_FILTERS: { id: RecoFilter; label: string; hint: string }[] = [
  { id: 'popular', label: 'Популярное', hint: 'популярные треки, хиты' },
  { id: 'new', label: 'Новинки', hint: 'вышедшие за последние два года' },
  { id: 'ru', label: 'Русское', hint: 'только на русском языке' },
  { id: 'foreign', label: 'Иностранное', hint: 'только не на русском языке' },
  { id: 'instrumental', label: 'Без слов', hint: 'инструментальная музыка без вокала' },
  { id: 'energetic', label: 'Энергичное', hint: 'энергичное, быстрое' },
  { id: 'calm', label: 'Спокойное', hint: 'спокойное, медленное' },
];

/** Filters that cannot hold together: picking one turns the other off. */
export const EXCLUSIVE: [RecoFilter, RecoFilter][] = [
  ['ru', 'foreign'],
  ['energetic', 'calm'],
];

const CYRILLIC = /[а-яё]/i;
const INSTRUMENTAL_TITLE = /instrumental|инструментал|lo-?fi|\bbeats?\b|no vocals|без слов|piano|ambient|soundtrack|\bost\b|score|classical|orchestra|минус/i;
const INSTRUMENTAL_GENRE = /classical|ambient|soundtrack|films|games|jazz|lounge|chill/i;

const UNKNOWN = -1.5;

/**
 * Score change for one song under the active filters: a number to add, or null to drop the song.
 * `nowYear` is passed in so the result stays testable.
 */
export function filterScore(track: Track, vibe: Vibe | null | undefined, filters: readonly RecoFilter[], nowYear: number): number | null {
  let total = 0;
  const text = `${track.artist} ${track.title}`;
  for (const f of filters) {
    let s: number | null;
    switch (f) {
      case 'ru':
        s = CYRILLIC.test(text) ? 0.5 : null;
        break;
      case 'foreign':
        s = CYRILLIC.test(text) ? null : 0.3;
        break;
      case 'instrumental':
        s = INSTRUMENTAL_TITLE.test(track.title) ? 2 : vibe?.genres?.some((g) => INSTRUMENTAL_GENRE.test(g)) ? 1 : vibe ? null : UNKNOWN;
        break;
      case 'energetic':
        s = !vibe ? UNKNOWN : vibe.energy >= 0.55 ? 2 * vibe.energy : null;
        break;
      case 'calm':
        s = !vibe ? UNKNOWN : vibe.energy <= 0.45 ? 2 * (1 - vibe.energy) : null;
        break;
      case 'popular': {
        const views = track.views ?? 0;
        const pop = vibe?.popularity;
        if (pop != null) s = pop >= 0.5 || views >= 20_000_000 ? 2 * pop : null;
        else s = views >= 20_000_000 ? 1.5 : views > 0 && views < 1_000_000 ? null : UNKNOWN;
        break;
      }
      case 'new':
        s = vibe?.year ? (vibe.year >= nowYear - 2 ? 1.5 : null) : UNKNOWN;
        break;
    }
    if (s == null) return null;
    total += s;
  }
  return total;
}

/** Adds or removes a filter, switching off the ones it cannot be combined with. */
export function toggleFilter(active: readonly RecoFilter[], f: RecoFilter): RecoFilter[] {
  if (active.includes(f)) return active.filter((x) => x !== f);
  const rivals = EXCLUSIVE.filter((pair) => pair.includes(f)).flat();
  return [...active.filter((x) => !rivals.includes(x)), f];
}

/** Short description of the active filters for the model (built-in ones plus the user's own words). */
export function describeFilters(filters: readonly RecoFilter[], custom: readonly string[] = []): string {
  return [...filters.map((f) => RECO_FILTERS.find((x) => x.id === f)?.hint ?? f), ...custom].join('; ');
}
