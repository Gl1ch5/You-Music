import type { AiMessage, ImportedTrack } from '../bridge/contract';
import { artistKey } from './normalize';
import type { RecoSignals } from './recommend';

/**
 * The model's part of hybrid recommendations: a compact taste profile goes to an OpenAI-compatible model, which
 * answers with a JSON list of songs. Songs are then matched on YouTube like any import. Only artist/title text
 * (and the years the user listens to) is sent — no account data, no identifiers.
 */

export interface TasteSummary {
  topArtists: string[];
  liked: string[];
  recent: string[];
  skippedArtists: string[];
}

export interface AiSuggestion extends ImportedTrack {
  reason?: string;
}

export function summarizeTaste({ likes, history }: RecoSignals): TasteSummary {
  const counts = new Map<string, { name: string; n: number }>();
  const bump = (artist: string, by: number) => {
    const k = artistKey(artist);
    if (!k) return;
    const e = counts.get(k) ?? { name: artist.split(/,|&/)[0].trim(), n: 0 };
    e.n += by;
    counts.set(k, e);
  };
  likes.forEach((l) => bump(l.track.artist, 3));
  history.filter((h) => h.completed).forEach((h) => bump(h.track.artist, 1));
  const skips = new Map<string, number>();
  history.filter((h) => h.skipped).forEach((h) => skips.set(h.track.artist, (skips.get(h.track.artist) ?? 0) + 1));
  const line = (t: { artist: string; title: string }) => `${t.artist} — ${t.title}`;
  return {
    topArtists: [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 15).map((e) => e.name),
    liked: likes.slice(0, 40).map((l) => line(l.track)),
    recent: history.filter((h) => h.completed).slice(0, 20).map((h) => line(h.track)),
    skippedArtists: [...skips].filter(([, n]) => n >= 2).map(([a]) => a).slice(0, 10),
  };
}

export interface PromptOptions {
  count: number;
  exclude: string[];
  /** The user's wishes: active filters and their own words ("без слов; грустное"). */
  mood?: string;
  /** Current year, to know what "new" and "trending" mean. */
  year?: number;
  /** Years the user mostly listens to. */
  era?: { year: number; spread: number } | null;
  /** The taste comes from one playlist with this name, not from the whole library. */
  playlist?: string;
}

export function buildAiPrompt(taste: TasteSummary, opts: PromptOptions): AiMessage[] {
  const year = opts.year ?? new Date().getFullYear();
  const system =
    'Ты музыкальный куратор. Подбираешь реальные существующие песни, которые есть на YouTube. ' +
    'Отвечай ТОЛЬКО JSON-массивом без пояснений вокруг: [{"artist":"...","title":"...","reason":"до 8 слов по-русски"}]. ' +
    'Не повторяй песни из списков пользователя. Не больше двух песен одного исполнителя. ' +
    'Смешивай любимых исполнителей пользователя с новыми похожими. Только оригинальные версии, без remix/slowed/sped up, если пользователь их не любит. ' +
    `Сейчас ${year} год: учитывай, что сейчас актуально и в тренде у слушателей такого вкуса. ` +
    'Держись эпохи пользователя: кто слушает новую музыку — не предлагай старые хиты; кто слушает старое — не навязывай свежие тренды. ' +
    'Пожелания пользователя (если есть) обязательны для каждой песни.';
  const era = opts.era
    ? `Пользователь в основном слушает песни ${Math.round(opts.era.year - opts.era.spread)}–${Math.round(opts.era.year + opts.era.spread)} годов${opts.era.year >= year - 3 ? ' — свежую музыку' : ''}.`
    : '';
  const parts = [
    opts.playlist ? `Подбирай по плейлисту «${opts.playlist}» — его песни ниже вместо лайков.` : '',
    `Любимые исполнители: ${taste.topArtists.join(', ') || 'нет данных'}.`,
    era,
    taste.liked.length ? `Лайкнутые треки:\n${taste.liked.join('\n')}` : '',
    taste.recent.length ? `Недавно дослушал:\n${taste.recent.join('\n')}` : '',
    taste.skippedArtists.length ? `Часто пропускает: ${taste.skippedArtists.join(', ')}.` : '',
    opts.exclude.length ? `Уже предлагали, не повторяй:\n${opts.exclude.slice(-60).join('\n')}` : '',
    opts.mood ? `Пожелания: ${opts.mood}.` : '',
    `Предложи ${opts.count} песен.`,
  ];
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.filter(Boolean).join('\n\n') },
  ];
}

/** Pulls the first JSON array out of a model answer (tolerates code fences, prose, `{tracks:[…]}`). */
export function parseAiTracks(text: string): AiSuggestion[] {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tracks) ? parsed.tracks : null;
      if (!list) continue;
      return list
        .filter((x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((x: Record<string, unknown>) => ({
          artist: String(x.artist ?? x.author ?? '').trim(),
          title: String(x.title ?? x.song ?? x.name ?? '').trim(),
          reason: typeof x.reason === 'string' ? x.reason.trim() : undefined,
          durationMs: 0,
        }))
        .filter((x: AiSuggestion) => x.title);
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}
