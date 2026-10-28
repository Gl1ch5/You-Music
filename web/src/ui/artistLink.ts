import type { Track } from '../bridge/contract';
import { navigate } from '../app/router';
import { h } from '../core/dom';
import { splitArtists } from '../logic/normalize';
import { search } from '../services/catalog';
import { toast } from './toast';
import { busy } from '../core/busy';

/** First credited artist: "A, B feat. C" → "A". */
export function mainArtist(name: string): string {
  return splitArtists(name)[0] ?? name;
}

/** Everyone credited on a track: the artist field plus "feat." guests from the title. */
export function trackArtists(track: Pick<Track, 'artist' | 'title'>): string[] {
  const names = splitArtists(track.artist);
  const feat = track.title.match(/[([]\s*(?:feat\.?|ft\.?|featuring|при\s+уч\.?|with)\s+([^)\]]+)[)\]]/i) ?? track.title.match(/\s(?:feat\.?|ft\.?)\s+(.+)$/i);
  if (feat) names.push(...splitArtists(feat[1]));
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (!n || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Opens the artist screen by name; the track's own channel URL is used for its main artist. */
export async function openArtistByName(name: string, url?: string | null): Promise<void> {
  if (url) {
    navigate('artist', { url, name });
    return;
  }
  const found = await busy(search(name, 'artists')).catch(() => null);
  const artist = found?.items.find((i) => i.artist)?.artist;
  if (artist) navigate('artist', { url: artist.url, name: artist.name });
  else toast('Исполнитель не найден');
}

export function openArtist(track: Track): Promise<void> {
  return openArtistByName(mainArtist(track.artist), track.artistUrl);
}

/**
 * Fills [el] with the track's artists, each one clickable on its own ("A, B feat. C" → three links). Clicks do not
 * reach the row/player handlers around it. Own files stay plain text.
 */
export function linkArtist(el: HTMLElement, track: () => Track | null | undefined, before?: () => void): void {
  const render = () => {
    const t = track();
    el.replaceChildren();
    if (!t) return;
    if (t.source === 'local') {
      el.textContent = t.artist;
      return;
    }
    const names = trackArtists(t);
    if (!names.length) {
      el.textContent = t.artist;
      return;
    }
    names.forEach((name, i) => {
      if (i) el.append(', ');
      const own = i === 0 && splitArtists(t.artist).length === 1 ? t.artistUrl : null;
      el.append(
        h('span.artist-link', {
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            before?.();
            void openArtistByName(name, own);
          },
        }, name),
      );
    });
  };
  render();
  (el as HTMLElement & { refreshArtists?: () => void }).refreshArtists = render;
}

/** Re-renders the links after the track behind [el] changed. */
export function refreshArtistLinks(el: HTMLElement): void {
  (el as HTMLElement & { refreshArtists?: () => void }).refreshArtists?.();
}
