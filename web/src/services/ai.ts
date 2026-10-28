import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { app, likedIds } from '../core/store';
import { buildAiPrompt, parseAiTracks, summarizeTaste } from '../logic/ai';
import { songKey } from '../logic/normalize';
import type { RecoSource } from '../logic/recommend';
import { findTrack } from './catalog';

/** Neuro recommendations: ask the configured model for songs, then find each one on YouTube. */

export async function refreshAiConfig(): Promise<void> {
  const cfg = await call('aiConfig').catch(() => null);
  app.aiEnabled.value = !!cfg?.enabled && !!cfg.baseUrl && !!cfg.model;
}

export interface AiPick {
  track: Track;
  reason?: string;
}

const asked: string[] = [];

export async function aiSuggest(source: RecoSource, count: number, mood?: string): Promise<AiPick[]> {
  const signals = await source.signals();
  const messages = buildAiPrompt(summarizeTaste(signals), { count, exclude: asked, mood });
  const suggestions = parseAiTracks(await call('aiChat', { messages, temperature: 0.9 }));
  suggestions.forEach((s) => asked.push(`${s.artist} — ${s.title}`));
  const liked = likedIds.peek();
  const likedKeys = new Set(signals.likes.map((l) => songKey(l.track)));
  const picks: AiPick[] = [];
  let next = 0;
  const worker = async () => {
    while (next < suggestions.length) {
      const s = suggestions[next++];
      const track = await findTrack(s).catch(() => null);
      if (track && !liked.has(track.id) && !likedKeys.has(songKey(track)) && !picks.some((p) => p.track.id === track.id)) picks.push({ track, reason: s.reason });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // Keep the model's order.
  const order = new Map(suggestions.map((s, i) => [`${s.artist}|${s.title}`.toLowerCase(), i]));
  return picks.sort((a, b) => (order.get(`${a.track.artist}|${a.track.title}`.toLowerCase()) ?? 99) - (order.get(`${b.track.artist}|${b.track.title}`.toLowerCase()) ?? 99));
}
