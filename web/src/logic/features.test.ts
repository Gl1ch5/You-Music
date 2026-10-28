import { describe, expect, it } from 'vitest';
import { averageVibe, genreAggression, vibeBonus, vibeDistance, vibeOf } from './features';

describe('vibeOf', () => {
  it('is null for unknown songs', () => {
    expect(vibeOf({ found: false, genres: [], explicit: false })).toBeNull();
    expect(vibeOf(null)).toBeNull();
  });

  it('rates loud fast metal as more aggressive and energetic than quiet slow jazz', () => {
    const metal = vibeOf({ found: true, bpm: 170, gainDb: -14, genres: ['Metal'], explicit: true })!;
    const jazz = vibeOf({ found: true, bpm: 70, gainDb: -4, genres: ['Jazz'], explicit: false })!;
    expect(metal.aggression).toBeGreaterThan(0.75);
    expect(jazz.aggression).toBeLessThan(0.3);
    expect(metal.energy).toBeGreaterThan(jazz.energy);
    for (const v of Object.values(metal)) expect(v).toBeLessThanOrEqual(1);
  });

  it('maps genres', () => {
    expect(genreAggression(['Rap/Hip Hop'])).toBe(0.75);
    expect(genreAggression(['Unknown thing'])).toBeNull();
  });
});

describe('vibe math', () => {
  const a = { energy: 0.2, aggression: 0.2, tempo: 0.3, dance: 0.4 };
  const b = { energy: 0.9, aggression: 0.9, tempo: 0.8, dance: 0.6 };

  it('averages only with enough data', () => {
    expect(averageVibe([a, null], 3)).toBeNull();
    expect(averageVibe([a, b], 2)!.energy).toBeCloseTo(0.55);
  });

  it('rewards close vibes and penalises far ones', () => {
    expect(vibeDistance(a, a)).toBe(0);
    expect(vibeBonus(a, a, 1)).toBe(1);
    expect(vibeBonus(b, a, 1)).toBeLessThan(0);
    expect(vibeBonus(null, a, 1)).toBe(0);
  });
});
