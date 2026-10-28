import { describe, expect, it } from 'vitest';
import type { Track } from '../bridge/contract';
import { buildAiPrompt, parseAiTracks, summarizeTaste } from './ai';

const t = (artist: string, title: string): Track => ({ id: `${artist}-${title}`, source: 'yt', artist, title, durationMs: 1 });

describe('parseAiTracks', () => {
  it('reads a plain array', () => {
    expect(parseAiTracks('[{"artist":"Ottawan","title":"D.I.S.C.O."}]')).toEqual([{ artist: 'Ottawan', title: 'D.I.S.C.O.', reason: undefined, durationMs: 0 }]);
  });

  it('reads fenced JSON with prose around it', () => {
    const text = 'Вот подборка:\n```json\n[{"artist":"Arabesque","title":"Midnight Dancer","reason":"диско 80-х"}]\n```\nПриятного!';
    expect(parseAiTracks(text)[0]).toMatchObject({ artist: 'Arabesque', reason: 'диско 80-х' });
  });

  it('accepts {tracks: [...]} and ignores garbage', () => {
    expect(parseAiTracks('{"tracks":[{"artist":"A","song":"B"},{"x":1},null]}')).toHaveLength(1);
    expect(parseAiTracks('не знаю')).toEqual([]);
  });
});

describe('prompt', () => {
  it('summarises taste and lists exclusions', () => {
    const taste = summarizeTaste({
      likes: [{ track: t('Boney M.', 'Rasputin'), likedAt: 1 }, { track: t('Boney M.', 'Sunny'), likedAt: 2 }, { track: t('ABBA', 'SOS'), likedAt: 3 }],
      history: [],
      now: 10,
    });
    expect(taste.topArtists[0]).toBe('Boney M.');
    const msgs = buildAiPrompt(taste, { count: 10, exclude: ['Ottawan — D.I.S.C.O.'] });
    expect(msgs[1].content).toContain('Boney M. — Rasputin');
    expect(msgs[1].content).toContain('Ottawan — D.I.S.C.O.');
    expect(msgs[1].content).toContain('10 песен');
  });
});
