import { describe, expect, it } from 'vitest';
import type { Track } from '../bridge/contract';
import type { Vibe } from './features';
import { filterScore, toggleFilter } from './filters';

const t = (title: string, artist: string, views?: number): Track => ({ id: title, source: 'yt', title, artist, durationMs: 200_000, views });
const vibe = (energy: number, extra: Partial<Vibe> = {}): Vibe => ({ energy, aggression: 0.5, tempo: 0.5, dance: 0.5, ...extra });

describe('filters', () => {
  it('keeps Russian songs for "ru" and drops them for "foreign"', () => {
    expect(filterScore(t('Маршрутка', 'IOWA'), null, ['ru'], 2026)).not.toBeNull();
    expect(filterScore(t('Song', 'Artist'), null, ['ru'], 2026)).toBeNull();
    expect(filterScore(t('Маршрутка', 'IOWA'), null, ['foreign'], 2026)).toBeNull();
  });

  it('combines filters: every one must accept', () => {
    expect(filterScore(t('Ночь', 'Группа'), vibe(0.8), ['ru', 'energetic'], 2026)).toBeGreaterThan(0);
    expect(filterScore(t('Ночь', 'Группа'), vibe(0.2), ['ru', 'energetic'], 2026)).toBeNull();
  });

  it('lets unknown songs through with a penalty', () => {
    expect(filterScore(t('Song', 'A'), null, ['calm'], 2026)).toBeLessThan(0);
  });

  it('judges popularity and freshness', () => {
    expect(filterScore(t('Hit', 'A', 50_000_000), null, ['popular'], 2026)).toBeGreaterThan(0);
    expect(filterScore(t('Demo', 'A', 3_000), null, ['popular'], 2026)).toBeNull();
    expect(filterScore(t('Old', 'A'), vibe(0.5, { year: 2009 }), ['new'], 2026)).toBeNull();
    expect(filterScore(t('Fresh', 'A'), vibe(0.5, { year: 2026 }), ['new'], 2026)).toBeGreaterThan(0);
  });

  it('switches off a contradicting filter', () => {
    expect(toggleFilter(['ru', 'calm'], 'foreign')).toEqual(['calm', 'foreign']);
    expect(toggleFilter(['ru'], 'ru')).toEqual([]);
  });
});
