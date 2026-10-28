import type { Track } from '../bridge/contract';
import { app } from '../core/store';

export type ArtSize = 'sm' | 'md' | 'lg';

const PX: Record<ArtSize, number> = { sm: 120, md: 300, lg: 720 };

/** Candidate artwork URLs, best first; covers fall back to the next one on error. Downloaded art wins offline. */
export function artFor(track: Pick<Track, 'id' | 'artwork' | 'source'>, size: ArtSize): string[] {
  const out: string[] = [];
  const local = app.downloads.peek().get(track.id)?.localArt;
  if (local) out.push(local);
  if (track.artwork) out.push(resize(track.artwork, PX[size]));
  if (track.source === 'yt') {
    const id = track.id.slice(3);
    if (size === 'lg') out.push(`https://i.ytimg.com/vi/${id}/hq720.jpg`);
    out.push(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
  }
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
