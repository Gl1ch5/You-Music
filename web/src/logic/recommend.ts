import type { HistoryEntry, Like, Track } from '../bridge/contract';
import { averageVibe, eraOf, eraPenalty, vibeBonus, type Era, type Vibe } from './features';
import { filterScore, type RecoFilter } from './filters';
import { artistKey, songKey } from './normalize';

/**
 * Recommendations v1.
 * Candidates: related videos of liked and recently finished tracks.
 * Score: how many seeds point at a track (liked seeds count more) + how much the user plays its artist − skips.
 * Filters: nothing already liked or recently played, one version per song per session, ≤2 same artist in a row.
 * Vibe: when the source knows audio data (tempo, loudness, genres), the best candidates are nudged towards the
 * average vibe of the user's likes — or of the seed track for a wave "по треку".
 * Era: songs far from the years the user actually listens to sink (no 2005 hits for a fan of new music).
 * Dislikes: the song never comes back, its artist sinks. Filters (see filters.ts) combine and drop what fails.
 */

export interface Dislike {
  id: string;
  /** songKey: every upload of the song. */
  key: string;
  artist: string;
  at: number;
}

export interface RecoSignals {
  likes: Like[];
  history: HistoryEntry[];
  now: number;
  dislikes?: Dislike[];
}

export interface RecoSource {
  signals(): Promise<RecoSignals>;
  related(track: Track): Promise<Track[]>;
  /** Optional extra candidates (e.g. AI suggestions); they count as strongly linked to the user's taste. */
  extra?(alreadyDelivered: Track[]): Promise<Track[]>;
  /** Optional audio "vibe" per track id (missing = unknown). */
  vibes?(tracks: Track[]): Promise<Map<string, Vibe | null>>;
}

/** How many top candidates get their vibe looked up per step, and how much it can move a score. */
const VIBE_TOP = 30;
const VIBE_TOP_FILTERED = 60;
const VIBE_WEIGHT_TASTE = 0.9;
const VIBE_WEIGHT_SEED = 1.8;
const ERA_WEIGHT_TASTE = 1.6;
const ERA_WEIGHT_SEED = 0.8;

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
  /** Disliked songs: never recommended. */
  blockedIds: Set<string>;
  blockedKeys: Set<string>;
}

const DAY = 24 * 3600_000;
const RECENT_WINDOW = 3 * DAY;
const RECENT_COUNT = 60;

export function buildProfile({ likes, history, now, dislikes = [] }: RecoSignals): Profile {
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
  // Each disliked song of an artist counts like a run of skips.
  for (const d of dislikes) {
    const k = artistKey(d.artist);
    if (k) artistSkip.set(k, Math.min(1.6, (artistSkip.get(k) ?? 0) + 0.4));
  }

  const recent = history.filter((h, i) => i < RECENT_COUNT || now - h.playedAt < RECENT_WINDOW);
  return {
    likedIds: new Set(likes.map((l) => l.track.id)),
    likedKeys: new Set(likes.map((l) => songKey(l.track))),
    recentIds: new Set(recent.map((h) => h.track.id)),
    recentKeys: new Set(recent.map((h) => songKey(h.track))),
    artistScore,
    artistSkip,
    skippedIds,
    blockedIds: new Set(dislikes.map((d) => d.id)),
    blockedKeys: new Set(dislikes.map((d) => d.key)),
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
        !profile.blockedIds.has(track.id) &&
        !profile.blockedKeys.has(key) &&
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

export interface WaveOptions {
  /** Grow from these tracks instead of the user's likes: a wave by a playlist. */
  seeds?: Track[];
  filters?: RecoFilter[];
  /** Already played in an earlier session of this wave (continuing it): never repeated. */
  seen?: Track[];
  /** Candidates whose vibe is looked up per step; more = slower but more precise. */
  depth?: 'fast' | 'deep';
  /** Only the extra source (the model) supplies songs: the user's own text filters only it can follow. */
  extraOnly?: boolean;
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
  private target: Vibe | null = null;
  private vibes = new Map<string, Vibe | null>();
  private targetLoad: Promise<void> | null = null;
  private extraIds = new Set<string>();
  private extraPending: Promise<void> | null = null;
  private era: Era | null = null;

  /** With `seed`, the wave grows only from that track (and what it plays), matching its vibe: "волна по треку". */
  constructor(
    private source: RecoSource,
    private mode: WaveMode = 'mix',
    private rng: () => number = Math.random,
    private seed: Track | null = null,
    private options: WaveOptions = {},
  ) {}

  setMode(mode: WaveMode): void {
    this.mode = mode;
  }

  /** Everything the wave has played so far (to save it and continue later). */
  played(): Track[] {
    return [...this.delivered];
  }

  get filters(): RecoFilter[] {
    return this.options.filters ?? [];
  }

  async next(count: number): Promise<Track[]> {
    await this.ensureProfile();
    const profile = this.profile!;
    // Filters drop part of the candidates: look for more of them up front.
    const want = this.filters.length ? count * 3 : count;
    const step = this.options.depth === 'deep' ? 5 : 3;
    for (let attempt = 0; attempt < (this.filters.length ? 6 : 4); attempt++) {
      const available = selectTracksPreview(scoreCandidates(this.candidates, profile, this.mode), profile, this.session);
      if (available >= want || !(await this.expand(step))) break;
    }
    await this.targetLoad;
    const scored = await this.withVibe(scoreCandidates(this.candidates, profile, this.mode));
    const picked = selectTracks(scored, profile, this.session, count);
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
    for (const t of this.options.seen ?? []) {
      this.session.seenIds.add(t.id);
      this.session.seenKeys.add(songKey(t));
    }
    if (this.seed) {
      this.seedQueue = [{ track: this.seed, liked: true }];
      this.session.seenIds.add(this.seed.id);
      this.session.seenKeys.add(songKey(this.seed));
    } else if (this.options.seeds?.length) {
      // A playlist wave: its songs are the taste, shuffled so every start differs; they are not replayed.
      const pool = [...this.options.seeds];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      this.seedQueue = pool.map((track) => ({ track, liked: true }));
      pool.forEach((t) => {
        this.session.seenIds.add(t.id);
        this.session.seenKeys.add(songKey(t));
      });
    } else {
      this.seedQueue = pickSeeds(this.signalsCache, 12, this.rng);
    }
    // Continuing a wave: grow from where it stopped.
    if (!this.seed && this.options.seen?.length) this.seedQueue.unshift(...this.options.seen.slice(-4).map((track) => ({ track, liked: false })));
    // The target vibe is only needed for the final scoring: load it while the candidates are fetched.
    this.targetLoad = this.loadTarget().catch(() => undefined);
  }

  /** Target vibe and era: the seed track's, the playlist's, or those of the freshest likes and finished plays. */
  private async loadTarget(): Promise<void> {
    if (!this.source.vibes) return;
    const signals = this.signalsCache!;
    const taste = [
      ...[...signals.likes].sort((a, b) => b.likedAt - a.likedAt).slice(0, 30).map((l) => l.track),
      ...signals.history.filter((h) => h.completed).slice(0, 15).map((h) => h.track),
    ];
    const tracks = this.seed ? [this.seed] : this.options.seeds?.length ? this.options.seeds.slice(0, 40) : taste;
    const map = await this.source.vibes(tracks);
    const vibes = tracks.map((t) => map.get(t.id) ?? null);
    this.target = averageVibe(vibes, this.seed ? 1 : 3);
    const seedYear = this.seed ? vibes[0]?.year : null;
    this.era = seedYear ? { year: seedYear, spread: 6 } : eraOf(vibes);
  }

  /**
   * Looks up the vibe of the top candidates (cached per wave) and adjusts their scores by vibe, era and filters.
   * Candidates a filter rejects are removed.
   */
  private async withVibe(scored: Scored[]): Promise<Scored[]> {
    const filters = this.filters;
    if (!this.source.vibes || (!this.target && !this.era && !filters.length)) return scored;
    const top = [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, filters.length || this.options.depth === 'deep' ? VIBE_TOP_FILTERED : VIBE_TOP)
      .map((s) => s.track);
    const unknown = top.filter((t) => !this.vibes.has(t.id));
    if (unknown.length) {
      const map = await this.source.vibes(unknown).catch(() => new Map<string, Vibe | null>());
      unknown.forEach((t) => this.vibes.set(t.id, map.get(t.id) ?? null));
    }
    const weight = this.seed ? VIBE_WEIGHT_SEED : VIBE_WEIGHT_TASTE;
    const eraWeight = this.seed ? ERA_WEIGHT_SEED : ERA_WEIGHT_TASTE;
    const year = new Date(this.signalsCache?.now ?? Date.now()).getFullYear();
    const out: Scored[] = [];
    for (const s of scored) {
      const v = this.vibes.get(s.track.id);
      const f = filters.length ? filterScore(s.track, v, filters, year) : 0;
      if (f == null) continue;
      out.push({ ...s, score: s.score + f + vibeBonus(v, this.target, weight) + eraPenalty(v, this.era, eraWeight) });
    }
    return out;
  }

  private async expand(n: number): Promise<boolean> {
    const seeds: { track: Track; liked: boolean }[] = [];
    if (this.options.extraOnly && this.source.extra) {
      await this.refillExtra();
      return this.extraLeft() > 0;
    }
    while (seeds.length < n && this.seedQueue.length) {
      const s = this.seedQueue.shift()!;
      if (!this.expanded.has(s.track.id)) seeds.push(s);
    }
    if (!seeds.length) {
      // Out of seeds: grow from what the wave already played.
      const fallback = this.delivered.filter((t) => !this.expanded.has(t.id)).slice(-n);
      seeds.push(...fallback.map((track) => ({ track, liked: false })));
    }
    // Extra (AI) candidates are fetched alongside the related videos, and only when the previous batch is
    // nearly used up: every call is a request to the model.
    const extra = this.refillExtra();
    if (!seeds.length) {
      await extra;
      return this.extraLeft() > 0;
    }
    const [results] = await Promise.all([Promise.allSettled(seeds.map((s) => this.source.related(s.track))), extra]);
    results.forEach((r, i) => {
      const seed = seeds[i];
      this.expanded.add(seed.track.id);
      if (r.status !== 'fulfilled') return;
      r.value.forEach((track, rank) => this.candidates.push({ track, seedId: seed.track.id, seedLiked: seed.liked, rank }));
    });
    return true;
  }

  private extraLeft(): number {
    let n = 0;
    for (const id of this.extraIds) if (!this.session.seenIds.has(id)) n++;
    return n;
  }

  private refillExtra(): Promise<void> {
    if (!this.source.extra) return Promise.resolve();
    if (!this.extraPending && this.extraLeft() < EXTRA_MIN) {
      this.extraPending = this.source
        .extra(this.delivered)
        .catch(() => [] as Track[])
        .then((tracks) => {
          for (const track of tracks) {
            if (this.extraIds.has(track.id)) continue;
            this.extraIds.add(track.id);
            this.candidates.push({ track, seedId: 'extra', seedLiked: true, rank: 0 }, { track, seedId: 'extra-2', seedLiked: true, rank: 0 });
          }
        })
        .finally(() => (this.extraPending = null));
    }
    return this.extraPending ?? Promise.resolve();
  }
}

/** Ask the model again once fewer than this many of its picks are left unplayed. */
const EXTRA_MIN = 4;

function selectTracksPreview(scored: Scored[], profile: Profile, session: Session): number {
  const probe: Session = { seenIds: new Set(session.seenIds), seenKeys: new Set(session.seenKeys), artistPenalty: session.artistPenalty };
  return selectTracks(scored, profile, probe, Number.MAX_SAFE_INTEGER).length;
}
