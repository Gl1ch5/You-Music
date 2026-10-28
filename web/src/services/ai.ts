import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { app, likedIds } from '../core/store';
import { buildAiPrompt, parseAiTracks, summarizeTaste } from '../logic/ai';
import { eraOf } from '../logic/features';
import { songKeys } from '../logic/normalize';
import type { RecoSource } from '../logic/recommend';
import { findTrack } from './catalog';
import { isDisliked } from './dislikes';
import { vibesOf } from './features';

/** The model's part of recommendations: ask the own model (or the account's) for songs, then find each on YouTube. */

export async function refreshAiConfig(): Promise<void> {
  const cfg = await call('aiConfig').catch(() => null);
  app.aiEnabled.value = (!!cfg?.enabled && !!cfg.baseUrl && !!cfg.model) || !!cfg?.server;
}

export interface AiPick {
  track: Track;
  reason?: string;
}

export interface SuggestOptions {
  mood?: string;
  tier?: 'fast' | 'deep';
  /** Taste from these tracks (a playlist) instead of the whole library. */
  basis?: Track[];
  title?: string;
}

const asked: string[] = [];

export async function aiSuggest(source: RecoSource, count: number, opts: SuggestOptions = {}): Promise<AiPick[]> {
  const signals = await source.signals();
  const now = Date.now();
  const tasteSignals = opts.basis?.length ? { ...signals, likes: opts.basis.slice(0, 60).map((track, i) => ({ track, likedAt: now - i })) } : signals;
  const basis = tasteSignals.likes.slice(0, 30).map((l) => l.track);
  const vibes = await vibesOf(basis).catch(() => new Map());
  const messages = buildAiPrompt(summarizeTaste(tasteSignals), {
    count,
    exclude: asked,
    mood: opts.mood,
    year: new Date(now).getFullYear(),
    era: eraOf(basis.map((t) => vibes.get(t.id))),
    playlist: opts.basis?.length ? opts.title : undefined,
  });
  const suggestions = parseAiTracks(await call('aiChat', { messages, temperature: 0.9, tier: opts.tier ?? 'fast' }));
  suggestions.forEach((s) => asked.push(`${s.artist} — ${s.title}`));
  const liked = likedIds.peek();
  const likedKeys = new Set(signals.likes.flatMap((l) => songKeys(l.track)));
  const picks: AiPick[] = [];
  let next = 0;
  const worker = async () => {
    while (next < suggestions.length) {
      const s = suggestions[next++];
      const track = await findTrack(s).catch(() => null);
      if (track && !liked.has(track.id) && !songKeys(track).some((k) => likedKeys.has(k)) && !isDisliked(track) && !picks.some((p) => p.track.id === track.id)) picks.push({ track, reason: s.reason });
    }
  };
  // The searches are independent network calls: run several at once.
  await Promise.all(Array.from({ length: 6 }, worker));
  // Keep the model's order.
  const order = new Map(suggestions.map((s, i) => [`${s.artist}|${s.title}`.toLowerCase(), i]));
  return picks.sort((a, b) => (order.get(`${a.track.artist}|${a.track.title}`.toLowerCase()) ?? 99) - (order.get(`${b.track.artist}|${b.track.title}`.toLowerCase()) ?? 99));
}
