import type { TrackFeatures } from '../bridge/contract';

/**
 * "Vibe" of a song from basic audio data (tempo, loudness, genres): rough 0..1 estimates of energy, aggression,
 * tempo and danceability. Used only to steer recommendations towards what the user (or the seed track) sounds like —
 * never shown as exact numbers.
 */

export interface Vibe {
  energy: number;
  aggression: number;
  tempo: number;
  dance: number;
  /** Release year, when known: steers away from old songs for people who listen to new ones (and vice versa). */
  year?: number | null;
  /** 0..1 from the Deezer rank: how mainstream the song is. */
  popularity?: number | null;
  genres?: string[];
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));

/** How hard a Deezer genre usually hits (0 = calm, 1 = harsh). */
const GENRE_AGGRESSION: [RegExp, number][] = [
  [/metal|hardcore|punk|phonk|drill|dubstep|hardstyle/i, 1],
  [/rap|hip.?hop|trap/i, 0.75],
  [/rock|alternative|grunge/i, 0.65],
  [/electro|techno|drum|bass|edm/i, 0.6],
  [/dance|house|dancehall/i, 0.5],
  [/latin|reggaeton/i, 0.45],
  [/pop/i, 0.35],
  [/r&b|soul|funk|reggae|chanson|blues|country|folk|films|games|soundtrack/i, 0.25],
  [/jazz|lounge|ambient|chill|acoustic/i, 0.15],
  [/classical|kids|opera/i, 0.08],
];

export function genreAggression(genres: string[]): number | null {
  const values = genres.map((g) => GENRE_AGGRESSION.find(([re]) => re.test(g))?.[1]).filter((v): v is number => v != null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function vibeOf(f: TrackFeatures | null | undefined): Vibe | null {
  if (!f?.found) return null;
  const known = [f.bpm, f.gainDb, f.year].filter((x) => x != null).length + (f.genres.length ? 1 : 0);
  if (!known) return null;
  // Deezer gain: about -3 dB for quiet/dynamic masters, -15 dB for brick-walled ones.
  const loud = f.gainDb != null ? clamp((-f.gainDb - 3) / 12) : 0.5;
  const tempo = f.bpm ? clamp((f.bpm - 60) / 120) : 0.5;
  const genre = genreAggression(f.genres) ?? 0.4;
  return {
    energy: clamp(0.45 * loud + 0.4 * tempo + 0.3 * (genre - 0.4)),
    aggression: clamp(0.35 * loud + 0.15 * tempo + 0.5 * genre + (f.explicit ? 0.08 : 0)),
    tempo,
    dance: f.bpm ? clamp(1 - Math.abs(f.bpm - 122) / 50) : 0.5,
    year: f.year ?? null,
    popularity: f.rank != null ? clamp(f.rank / 900_000) : null,
    genres: f.genres,
  };
}

export interface Era {
  /** Median release year of the songs. */
  year: number;
  /** Half of the middle range, at least a few years. */
  spread: number;
}

/** Which years the songs come from; null with fewer than `min` dated songs. */
export function eraOf(vibes: (Vibe | null | undefined)[], min = 5): Era | null {
  const years = vibes.map((v) => v?.year).filter((y): y is number => !!y && y > 1900).sort((a, b) => a - b);
  if (years.length < min) return null;
  const q = (p: number) => years[Math.min(years.length - 1, Math.floor(p * years.length))];
  return { year: q(0.5), spread: Math.max(4, (q(0.8) - q(0.2)) / 2) };
}

/** Score adjustment ≤ 0 for songs far outside the listener's years: a fan of new music gets no 2005 hits. */
export function eraPenalty(v: Vibe | null | undefined, era: Era | null, weight: number): number {
  if (!v?.year || !era) return 0;
  const outside = Math.abs(v.year - era.year) - era.spread;
  return outside > 0 ? -weight * Math.min(1, outside / 8) : 0;
}

/** Average vibe; null for fewer than `min` known songs (too little to say anything). */
export function averageVibe(vibes: (Vibe | null)[], min = 3): Vibe | null {
  const known = vibes.filter((v): v is Vibe => !!v);
  if (known.length < min) return null;
  const sum = known.reduce((a, v) => ({ energy: a.energy + v.energy, aggression: a.aggression + v.aggression, tempo: a.tempo + v.tempo, dance: a.dance + v.dance }), { energy: 0, aggression: 0, tempo: 0, dance: 0 });
  const n = known.length;
  return { energy: sum.energy / n, aggression: sum.aggression / n, tempo: sum.tempo / n, dance: sum.dance / n };
}

/** 0 = same vibe, 1 = opposite. Energy and aggression matter most. */
export function vibeDistance(a: Vibe, b: Vibe): number {
  const d = 0.35 * (a.energy - b.energy) ** 2 + 0.35 * (a.aggression - b.aggression) ** 2 + 0.15 * (a.tempo - b.tempo) ** 2 + 0.15 * (a.dance - b.dance) ** 2;
  return Math.sqrt(d);
}

/** Score adjustment in [-weight, +weight]: close vibes are pushed up, far ones down, unknown ones untouched. */
export function vibeBonus(v: Vibe | null | undefined, target: Vibe | null, weight: number): number {
  if (!v || !target) return 0;
  return weight * (1 - 2 * Math.min(1, vibeDistance(v, target) / 0.5));
}
