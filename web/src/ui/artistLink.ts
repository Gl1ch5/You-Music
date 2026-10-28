import type { Track } from '../bridge/contract';
import { navigate } from '../app/router';
import { search } from '../services/catalog';
import { toast } from './toast';
import { busy } from '../core/busy';

/** First credited artist: "A, B feat. C" → "A". */
export function mainArtist(name: string): string {
  return name.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|×)\s*/i)[0]?.trim() || name;
}

/** Opens the artist screen; finds the channel by name when the track does not carry its URL. */
export async function openArtist(track: Track): Promise<void> {
  if (track.artistUrl) {
    navigate('artist', { url: track.artistUrl, name: track.artist });
    return;
  }
  const name = mainArtist(track.artist);
  const found = await busy(search(name, 'artists')).catch(() => null);
  const artist = found?.items.find((i) => i.artist)?.artist;
  if (artist) navigate('artist', { url: artist.url, name: artist.name });
  else toast('Исполнитель не найден');
}

/** Makes [el] open the artist of [track] without triggering the row/player handlers around it. */
export function linkArtist(el: HTMLElement, track: () => Track | null | undefined, before?: () => void): void {
  el.classList.add('artist-link');
  el.addEventListener('click', (e) => {
    const t = track();
    if (!t || t.source === 'local') return;
    e.stopPropagation();
    before?.();
    void openArtist(t);
  });
}
