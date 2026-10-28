import { describe, expect, it } from 'vitest';
import type { Track } from '../bridge/contract';
import { bestMatch, parseTrackList } from './match';

const t = (id: string, title: string, artist: string, sec: number, official = false): Track => ({ id, source: 'yt', title, artist, durationMs: sec * 1000, official });

describe('bestMatch', () => {
  it('picks the original over a slowed upload and a cover', () => {
    const src = { title: 'Rasputin', artist: 'Boney M.', durationMs: 268_000 };
    const cands = [t('slow', 'Rasputin (Slowed)', 'Boney M.', 330), t('cover', 'Rasputin', 'Some Cover Band', 250), t('orig', 'Rasputin', 'Boney M.', 268, true)];
    expect(bestMatch(src, cands)?.id).toBe('orig');
  });

  it('keeps the requested version', () => {
    const src = { title: 'MATADORA (Slowed)', artist: 'DJ Asul', durationMs: 0 };
    const cands = [t('o', 'MATADORA', 'DJ Asul', 120), t('s', 'MATADORA (Slowed)', 'DJ Asul', 140)];
    expect(bestMatch(src, cands)?.id).toBe('s');
  });

  it('returns null when nothing is close', () => {
    expect(bestMatch({ title: 'Toscana', artist: 'Alessandra', durationMs: 170_000 }, [t('x', 'Completely Different', 'Nobody', 400)])).toBeNull();
  });
});

describe('parseTrackList', () => {
  it('reads "Artist - Title" lines', () => {
    expect(parseTrackList('1. Boney M. - Rasputin\nAlessandra — Toscana')).toEqual([
      { artist: 'Boney M.', title: 'Rasputin', durationMs: 0 },
      { artist: 'Alessandra', title: 'Toscana', durationMs: 0 },
    ]);
  });

  it('reads Exportify CSV', () => {
    const csv = '"Track URI","Track Name","Artist Name(s)","Duration (ms)"\n"spotify:track:1","Housewife","Tate McRae","208810"\n"spotify:track:2","Song, with comma","A;B","1000"';
    expect(parseTrackList(csv)).toEqual([
      { title: 'Housewife', artist: 'Tate McRae', durationMs: 208810 },
      { title: 'Song, with comma', artist: 'A, B', durationMs: 1000 },
    ]);
  });
});
