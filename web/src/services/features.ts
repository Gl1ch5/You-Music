import { call } from '../bridge/bridge';
import type { Track, TrackFeatures } from '../bridge/contract';
import { vibeOf, type Vibe } from '../logic/features';

/** Vibes of tracks for recommendations. Native caches the raw data on disk; this keeps the session's answers. */

const cache = new Map<string, Vibe | null>();

export async function vibesOf(tracks: Track[]): Promise<Map<string, Vibe | null>> {
  const out = new Map<string, Vibe | null>();
  const ask = tracks.filter((t) => t.source === 'yt' && !cache.has(t.id) && !out.has(t.id));
  if (ask.length) {
    const res = await call('trackFeatures', {
      tracks: ask.slice(0, 40).map((t) => ({ id: t.id, artist: t.artist, title: t.title, durationMs: t.durationMs })),
    }).catch(() => ({}) as Record<string, TrackFeatures>);
    for (const t of ask.slice(0, 40)) if (res[t.id]) cache.set(t.id, vibeOf(res[t.id]));
  }
  for (const t of tracks) if (cache.has(t.id)) out.set(t.id, cache.get(t.id)!);
  return out;
}
