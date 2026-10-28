import { describe, expect, it } from 'vitest';
import type { HistoryEntry, Like, Track } from '../bridge/contract';
import { artistKey } from './normalize';
import { buildProfile, limitArtistRuns, newSession, scoreCandidates, selectTracks, Wave, type RecoSource } from './recommend';

const NOW = 1_800_000_000_000;
const t = (id: string, artist: string, title = id, durationMs = 200_000): Track => ({ id, source: 'yt', title, artist, durationMs });
const like = (track: Track, daysAgo = 1): Like => ({ track, likedAt: NOW - daysAgo * 86_400_000 });
const play = (track: Track, opts: Partial<HistoryEntry> = {}): HistoryEntry => ({
  track,
  playedAt: NOW - 3600_000,
  listenedMs: 200_000,
  durationMs: 200_000,
  completed: true,
  skipped: false,
  ...opts,
});

describe('buildProfile', () => {
  it('counts likes and completions per artist and tracks skip rate', () => {
    const a = t('a', 'Artist A');
    const b = t('b', 'Artist B');
    const p = buildProfile({
      likes: [like(a)],
      history: [play(b, { skipped: true, completed: false }), play(t('b2', 'Artist B'), { skipped: true, completed: false })],
      now: NOW,
    });
    expect(p.artistScore.get(artistKey('Artist A'))).toBeGreaterThan(3);
    expect(p.artistSkip.get(artistKey('Artist B'))).toBe(1);
    expect(p.skippedIds.has('b')).toBe(true);
  });
});

describe('scoring and filters', () => {
  const liked = t('liked', 'Fav');
  const profile = buildProfile({ likes: [like(liked)], history: [play(t('recent', 'Other'))], now: NOW });

  it('ranks tracks linked from several liked seeds higher', () => {
    const x = t('x', 'New One');
    const y = t('y', 'New Two');
    const scored = scoreCandidates(
      [
        { track: x, seedId: 's1', seedLiked: true, rank: 3 },
        { track: x, seedId: 's2', seedLiked: true, rank: 5 },
        { track: y, seedId: 's1', seedLiked: false, rank: 0 },
      ],
      profile,
    );
    const top = scored.sort((a, b) => b.score - a.score)[0];
    expect(top.track.id).toBe('x');
  });

  it('drops liked, recently played and duplicate versions', () => {
    const scored = [liked, t('recent', 'Other'), t('song', 'Band', 'Song'), t('song-slow', 'Band', 'Song (Slowed)'), t('fresh', 'Zed')]
      .map((track, i) => ({ track, score: 10 - i }));
    const session = newSession();
    expect(selectTracks(scored, profile, session, 10).map((x) => x.id)).toEqual(['song', 'fresh']);
    // The same song in another version is not offered again in this session.
    expect(selectTracks([{ track: t('song-live', 'Band', 'Song (Live)'), score: 1 }], profile, session, 10)).toEqual([]);
  });

  it('drops re-uploads credited to other channels', () => {
    const session = newSession();
    const scored = [t('orig', 'Сплин', 'Белые ночи'), t('reup', 'Rock Lyrics', 'Сплин - Белые ночи (Текст песни)'), t('reup2', 'Edits', 'Белые ночи | slowed')]
      .map((track, i) => ({ track, score: 10 - i }));
    expect(selectTracks(scored, profile, session, 10).map((x) => x.id)).toEqual(['orig']);
  });
});

describe('limitArtistRuns', () => {
  it('allows at most two tracks of one artist in a row', () => {
    const list = [t('1', 'A'), t('2', 'A'), t('3', 'A'), t('4', 'B'), t('5', 'A')];
    const out = limitArtistRuns(list, 2).map((x) => x.artist).join('');
    expect(out).not.toMatch(/AAA/);
    expect(out.length).toBe(5);
  });

  it('respects what was already queued', () => {
    const out = limitArtistRuns([t('3', 'A'), t('4', 'B')], 2, [t('1', 'A'), t('2', 'A')]);
    expect(out[0].artist).toBe('B');
  });
});

describe('Wave', () => {
  const seed = t('seed', 'Seed Artist');
  const related: Record<string, Track[]> = {
    seed: [t('r1', 'R One'), t('r2', 'R Two'), t('r3', 'R One', 'Other song'), t('r4', 'R Three')],
    r1: [t('r5', 'R Four'), t('r6', 'R Five')],
  };
  const source: RecoSource = {
    signals: async () => ({ likes: [like(seed)], history: [], now: NOW }),
    related: async (track) => related[track.id] ?? [],
  };

  it('serves fresh tracks and never repeats', async () => {
    const wave = new Wave(source, 'mix', () => 0.5);
    const first = await wave.next(3);
    const second = await wave.next(3);
    const ids = [...first, ...second].map((x) => x.id);
    expect(first.length).toBe(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('seed');
  });

  it('penalises a skipped artist for the rest of the session', async () => {
    const wave = new Wave(source, 'mix', () => 0.5);
    const first = await wave.next(1);
    wave.feedback('skip', first[0]);
    wave.feedback('skip', first[0]);
    const rest = await wave.next(5);
    const skippedArtist = artistKey(first[0].artist);
    const idx = rest.findIndex((x) => artistKey(x.artist) === skippedArtist);
    expect(idx === -1 || idx === rest.length - 1).toBe(true);
  });
});

describe('Wave vibe', () => {
  const calm = { energy: 0.1, aggression: 0.1, tempo: 0.2, dance: 0.3 };
  const harsh = { energy: 0.9, aggression: 0.95, tempo: 0.8, dance: 0.5 };

  it('grows from the seed only and prefers candidates with the seed vibe', async () => {
    const seed = t('seed', 'Seed Artist');
    const a = t('loud', 'Loud');
    const b = t('soft', 'Soft');
    const source: RecoSource = {
      signals: async () => ({ likes: [like(t('liked', 'Other'))], history: [], now: NOW }),
      // The calm track ranks higher by position; the vibe must outweigh it.
      related: async (track) => (track.id === 'seed' ? [b, a] : []),
      vibes: async (tracks) => new Map(tracks.map((x) => [x.id, x.id === 'soft' ? calm : harsh])),
    };
    const wave = new Wave(source, 'mix', () => 0.5, seed);
    const first = await wave.next(2);
    expect(first.map((x) => x.id)).toEqual(['loud', 'soft']);
    expect(first.some((x) => x.id === 'seed')).toBe(false);
  });
});
