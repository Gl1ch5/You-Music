import { describe, expect, it } from 'vitest';
import type { Track } from '../bridge/contract';
import { normalizeTrack } from './normalize';
import { rankTracks, referenceDurations } from './rank';

let n = 0;
const yt = (title: string, artist: string, durationSec: number, official = false): Track => ({
  id: `yt:${++n}`,
  source: 'yt',
  title,
  artist,
  durationMs: durationSec * 1000,
  official,
});

function rank(raw: Track[], query: string) {
  const rawTitles = new Map(raw.map((t) => [t.id, t.title]));
  return rankTracks(raw.map(normalizeTrack), query, rawTitles);
}

describe('rankTracks', () => {
  it('puts the official audio above a long music video', () => {
    const video = yt('Boney M. - Rasputin (Official Video)', 'BoneyMVEVO', 391);
    const lyrics = yt('Boney M - Rasputin (Lyrics)', '7clouds', 268);
    const topic = yt('Rasputin', 'Boney M. - Topic', 268, true);
    const ranked = rank([video, lyrics, topic], 'boney m rasputin');
    expect(ranked[0].id).toBe(topic.id);
    expect(ranked[ranked.length - 1].id).toBe(video.id);
  });

  it('pushes unrequested versions down but keeps them when asked for', () => {
    const slowed = yt('Raya (Slowed)', 'Zericxxn', 240);
    const original = yt('Raya', 'Zericxxn', 200);
    expect(rank([slowed, original], 'raya')[0].id).toBe(original.id);
    expect(rank([slowed, original], 'raya slowed')[0].id).toBe(slowed.id);
  });

  it('keeps YouTube order when nothing else differs', () => {
    const a = yt('Song A', 'X', 200);
    const b = yt('Song B', 'Y', 200);
    expect(rank([a, b], 'song').map((t) => t.id)).toEqual([a.id, b.id]);
  });
});

describe('referenceDurations', () => {
  it('prefers the canonical duration', () => {
    const tracks = [yt('Rasputin', 'Boney M.', 391), yt('Rasputin', 'Boney M.', 268, true)].map(normalizeTrack);
    expect([...referenceDurations(tracks).values()]).toEqual([268_000]);
  });
});
