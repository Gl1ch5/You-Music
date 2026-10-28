import type { HistoryEntry, Like, Track } from '../bridge/contract';
import { artistKey, songKey } from './normalize';

/**
 * Recommendations v1.
 * Candidates: related videos of liked and recently finished tracks.
 * Score: how many seeds point at a track (liked seeds count more) + how much the user plays its artist − skips.
 * Filters: nothing already liked or recently played, one version per song per session, ≤2 same artist in a row.
 */

export interface RecoSignals {
  likes: Like[];
  history: HistoryEntry[];
  now: number;
}

export interface RecoSource {
  signals(): Promise<RecoSignals>;
  related(track: Track): Promise<Track[]>;
}

export type WaveMode = 'mix' | 'familiar' | 'discover';

export interface Profile {
  likedIds: Set<string>;
  likedKeys: Set<string>;
  recentIds: Set<string>;
  recentKeys: Set<string>;
  /** Affinity per artist key; ≥ 0. */
  artistScore: Map<string, number>;
  /** Share of plays skipped per artist (0..1), only for artists with ≥ 2 plays. */
  artistSkip: Map<string, number>;
  skippedIds: Set<string>;
}

const DAY = 24 * 3600_000;
const RECENT_WINDOW = 3 * DAY;
const RECENT_COUNT = 60;

export function buildProfile({ likes, history, now }: RecoSignals): Profile {
  const artistScore = new Map<string, number>();
  const bump = (artist: string, by: number) => {
    const k = artistKey(artist);
    if (k) artistScore.set(k, (artistScore.get(k) ?? 0) + by);
  };
  for (const like of likes) {
    const ageDays = Math.max(0, (now - like.likedAt) / DAY);
    bump(like.track.artist, 3 * Math.exp(-ageDays / 120) + 1);
  }

  const plays = new Map<string, { total: number; skipped: number }>();
  const skippedIds = new Set<string>();
  for (const h of history) {
    const k = artistKey(h.track.artist);
    const p = plays.get(k) ?? { total: 0, skipped: 0 };
    p.total++;
    if (h.skipped) {
      p.skipped++;
      skippedIds.add(h.track.id);
    }
    plays.set(k, p);
    if (h.completed) bump(h.track.artist, 1);
  }
  const artistSkip = new Map<string, number>();
  for (const [k, p] of plays) if (p.total >= 2) artistSkip.set(k, p.skipped / p.total);

  const recent = history.filter((h, i) => i < RECENT_COUNT || now - h.playedAt < RECENT_WINDOW);
  return {
    likedIds: new Set(likes.map((l) => l.track.id)),
    likedKeys: new Set(likes.map((l) => songKey(l.track))),
    recentIds: new Set(recent.map((h) => h.track.id)),
    recentKeys: new Set(recent.map((h) => songKey(h.track))),
    artistScore,
    artistSkip,
    skippedIds,
  };
}

/** Seeds: freshest likes, a few random older likes and recently finished plays. */
export function pickSeeds({ likes, history }: RecoSignals, count: number, rng: () => number = Math.random): { track: Track; liked: boolean }[] {
  const out: { track: Track; liked: boolean }[] = [];
  const used = new Set<string>();
  const add = (track: Track, liked: boolean) => {
    if (out.length >= count || used.has(track.id)) return;
    used.add(track.id);
    out.push({ track, liked });
  };
  const sorted = [...likes].sort((a, b) => b.likedAt - a.likedAt);
  sorted.slice(0, Math.ceil(count / 2)).forEach((l) => add(l.track, true));
  const older = sorted.slice(Math.ceil(count / 2));
  for (let i = 0; i < 2 && older.length; i++) add(older.splice(Math.floor(rng() * older.length), 1)[0].track, true);
  history.filter((h) => h.completed).slice(0, count).forEach((h) => add(h.track, false));
  sorted.forEach((l) => add(l.track, true));
  return out;
}

export interface Candidate {
  track: Track;
  seedId: string;
  seedLiked: boolean;
  /** Position in the seed's related list (0 = most related). */
  rank: number;
}

export interface Scored {
  track: Track;
  score: number;
}

const MODE_WEIGHTS: Record<WaveMode, { links: number; affinity: number }> = {
  mix: { links: 1, affinity: 0.8 },
  familiar: { links: 0.8, affinity: 1.8 },
  discover: { links: 1.2, affinity: -0.6 },
};

export function scoreCandidates(candidates: Candidate[], profile: Profile, mode: WaveMode = 'mix'): Scored[] {
  const w = MODE_WEIGHTS[mode];
  const byId = new Map<string, { track: Track; links: number; liked: number; bestRank: number }>();
  for (const c of candidates) {
    const e = byId.get(c.track.id) ?? { track: c.track, links: 0, liked: 0, bestRank: Infinity };
    e.links++;
    if (c.seedLiked) e.liked++;
    e.bestRank = Math.min(e.bestRank, c.rank);
    byId.set(c.track.id, e);
  }
  return [...byId.values()].map((e) => {
    const k = artistKey(e.track.artist);
    const affinity = Math.log1p(profile.artistScore.get(k) ?? 0);
    const skip = profile.artistSkip.get(k) ?? 0;
    const score =
      w.links * e.links +
      1.5 * e.liked +
      w.affinity * affinity +
      0.6 * Math.max(0, 1 - e.bestRank / 20) -
      2.5 * skip -
      (profile.skippedIds.has(e.track.id) ? 3 : 0);
    return { track: e.track, score };
  });
}

export interface Session {
  seenIds: Set<string>;
  seenKeys: Set<string>;
  /** Penalty added on skip within this session, by artist key. */
  artistPenalty: Map<string, number>;
}

export const newSession = (): Session => ({ seenIds: new Set(), seenKeys: new Set(), artistPenalty: new Map() });

/** Applies filters and session state, returns up to `count` tracks and marks them as seen. */
export function selectTracks(scored: Scored[], profile: Profile, session: Session, count: number): Track[] {
  const eligible = scored
    .filter(({ track }) => {
      const key = songKey(track);
      return (
        !profile.likedIds.has(track.id) &&
        !profile.likedKeys.has(key) &&
        !profile.recentIds.has(track.id) &&
        !profile.recentKeys.has(key) &&
        !session.seenIds.has(track.id) &&
        !session.seenKeys.has(key) &&
        track.durationMs < 15 * 60_000
      );
    })
    .map((s) => ({ ...s, score: s.score - (session.artistPenalty.get(artistKey(s.track.artist)) ?? 0) }))
    .sort((a, b) => b.score - a.score);

  const picked: Track[] = [];
  const keys = new Set<string>();
  for (const { track } of eligible) {
    if (picked.length >= count) break;
    const key = songKey(track);
    if (keys.has(key)) continue;
    keys.add(key);
    picked.push(track);
  }
  const arranged = limitArtistRuns(picked, 2);
  arranged.forEach((t) => {
    session.seenIds.add(t.id);
    session.seenKeys.add(songKey(t));
  });
  return arranged;
}

/** Reorders (stable where possible) so that no artist appears more than `maxRun` times in a row. */
export function limitArtistRuns(tracks: Track[], maxRun = 2, previous: Track[] = []): Track[] {
  const rest = [...tracks];
  const out: Track[] = [];
  const tail = previous.slice(-maxRun);
  const runOf = (artist: string) => {
    const seq = [...tail, ...out];
    let run = 0;
    for (let i = seq.length - 1; i >= 0 && artistKey(seq[i].artist) === artist; i--) run++;
    return run;
  };
  while (rest.length) {
    const idx = rest.findIndex((t) => runOf(artistKey(t.artist)) < maxRun);
    out.push(rest.splice(idx === -1 ? 0 : idx, 1)[0]);
  }
  return out;
}

/** Endless queue that grows from seeds and reacts to likes and skips while playing. */
export class Wave {
  private profile: Profile | null = null;
  private signalsCache: RecoSignals | null = null;
  private session = newSession();
  private seedQueue: { track: Track; liked: boolean }[] = [];
  private expanded = new Set<string>();
  private candidates: Candidate[] = [];
  private delivered: Track[] = [];

  constructor(
    private source: RecoSource,
    private mode: WaveMode = 'mix',
    private rng: () => number = Math.random,
  ) {}

  setMode(mode: WaveMode): void {
    this.mode = mode;
  }

  async next(count: number): Promise<Track[]> {
    await this.ensureProfile();
    const profile = this.profile!;
    for (let attempt = 0; attempt < 4; attempt++) {
      const available = selectTracksPreview(scoreCandidates(this.candidates, profile, this.mode), profile, this.session);
      if (available >= count || !(await this.expand(3))) break;
    }
    const picked = selectTracks(scoreCandidates(this.candidates, profile, this.mode), profile, this.session, count);
    const arranged = limitArtistRuns(picked, 2, this.delivered);
    this.delivered.push(...arranged);
    return arranged;
  }

  /** Feedback from the player: a like makes the track a seed, a skip penalises its artist for this session. */
  feedback(kind: 'like' | 'skip' | 'complete', track: Track): void {
    const k = artistKey(track.artist);
    if (kind === 'skip') {
      this.session.artistPenalty.set(k, (this.session.artistPenalty.get(k) ?? 0) + 1.5);
      return;
    }
    if (this.profile) this.profile.artistScore.set(k, (this.profile.artistScore.get(k) ?? 0) + (kind === 'like' ? 3 : 0.5));
    if (kind === 'like') {
      this.session.artistPenalty.delete(k);
      this.seedQueue.unshift({ track, liked: true });
    } else {
      this.seedQueue.push({ track, liked: false });
    }
  }

  private async ensureProfile(): Promise<void> {
    if (this.profile) return;
    this.signalsCache = await this.source.signals();
    this.profile = buildProfile(this.signalsCache);
    this.seedQueue = pickSeeds(this.signalsCache, 12, this.rng);
  }

  private async expand(n: number): Promise<boolean> {
    const seeds: { track: Track; liked: boolean }[] = [];
    while (seeds.length < n && this.seedQueue.length) {
      const s = this.seedQueue.shift()!;
      if (!this.expanded.has(s.track.id)) seeds.push(s);
    }
    if (!seeds.length) {
      // Out of seeds: grow from what the wave already played.
      const fallback = this.delivered.filter((t) => !this.expanded.has(t.id)).slice(-n);
      seeds.push(...fallback.map((track) => ({ track, liked: false })));
    }
    if (!seeds.length) return false;
    const results = await Promise.allSettled(seeds.map((s) => this.source.related(s.track)));
    results.forEach((r, i) => {
      const seed = seeds[i];
      this.expanded.add(seed.track.id);
      if (r.status !== 'fulfilled') return;
      r.value.forEach((track, rank) => this.candidates.push({ track, seedId: seed.track.id, seedLiked: seed.liked, rank }));
    });
    return true;
  }
}

function selectTracksPreview(scored: Scored[], profile: Profile, session: Session): number {
  const probe: Session = { seenIds: new Set(session.seenIds), seenKeys: new Set(session.seenKeys), artistPenalty: session.artistPenalty };
  return selectTracks(scored, profile, probe, Number.MAX_SAFE_INTEGER).length;
}
