import type { Track } from '../bridge/contract';
import { app } from '../core/store';

export type ArtSize = 'sm' | 'md' | 'lg';

const PX: Record<ArtSize, number> = { sm: 120, md: 300, lg: 720 };

/** Candidate artwork URLs, best first; covers fall back to the next one on error. Downloaded art wins offline. */
export function artFor(track: Pick<Track, 'id' | 'artwork' | 'source'>, size: ArtSize): string[] {
  const out: string[] = [];
  const local = app.downloads.peek().get(track.id)?.localArt;
  if (local) out.push(local);
  // A video frame (hqdefault/sddefault are 4:3 with black bars — they show in a square crop): prefer the 16:9 sizes.
  const videoThumb = !!track.artwork && /i\.ytimg\.com\/vi(?:_webp)?\//.test(track.artwork);
  if (track.artwork && !videoThumb) out.push(resize(track.artwork, PX[size]));
  if (track.source === 'yt') {
    const id = track.id.slice(3);
    if (size === 'lg') out.push(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`);
    if (size !== 'sm') out.push(`https://i.ytimg.com/vi/${id}/hq720.jpg`);
    out.push(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
  }
  if (track.artwork && videoThumb) out.push(track.artwork);
  return [...new Set(out)];
}

/** Requests a size-appropriate image from Google image CDNs instead of the full-size original. */
export function resize(url: string, px: number): string {
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    return url.replace(/=(?:w\d+-h\d+|s\d+)[^/]*$/, '') + `=w${px}-h${px}-l90-rj`;
  }
  if (/i\.ytimg\.com\/vi\/[^/]+\/(hq720|maxresdefault|sddefault|hqdefault)/.test(url) && px <= 300) {
    return url.replace(/\/(hq720|maxresdefault|sddefault|hqdefault)\.jpg.*$/, '/mqdefault.jpg');
  }
  return url;
}

const warmed = new Set<string>();

/** Fetches covers of the upcoming tracks ahead of time, so the player and the mini player switch without a blank. */
export function preloadArt(tracks: Track[]): void {
  for (const t of tracks) {
    for (const url of [artFor(t, 'lg')[0], artFor(t, 'sm')[0]]) {
      if (!url || warmed.has(url)) continue;
      warmed.add(url);
      if (warmed.size > 200) warmed.delete(warmed.values().next().value!);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    }
  }
}
