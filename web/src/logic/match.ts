import type { ImportedTrack, Track } from '../bridge/contract';
import { cleanTitle, normalizeQuery, splitArtists, versionTags } from './normalize';

/**
 * Matching tracks from other services (Spotify, Yandex Music, text lists) to YouTube search results.
 * Title similarity weighs most, then artist, then duration; a version mismatch (remix vs original) is penalised.
 */

const MIN_SCORE = 0.55;

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Cyrillic → Latin, so "Баста" and "Basta" compare equal. */
export function translit(s: string): string {
  return s.toLowerCase().replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? c);
}

function tokens(s: string): Set<string> {
  return new Set(normalizeQuery(s));
}

/** Dice coefficient: "Love" vs "Love Story" is 0.67, not a perfect match. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  a.forEach((t) => b.has(t) && common++);
  return (2 * common) / (a.size + b.size);
}

const squash = (s: string) => translit(s).replace(/[^\p{L}\p{N}]+/gu, '');

/** 1 when one of the source artists is credited on the candidate (in its artist line or title), else token overlap. */
function artistSimilarity(src: ImportedTrack, cand: Track): number {
  const srcArtists = splitArtists(src.artist).map(squash).filter((a) => a.length >= 2);
  if (!srcArtists.length) return 0.5;
  const credited = squash(`${cand.artist} ${cand.title}`);
  if (srcArtists.some((a) => credited.includes(a))) return 1;
  const candArtists = splitArtists(cand.artist).map(squash);
  if (candArtists.some((c) => c.length >= 3 && srcArtists.some((a) => a.includes(c)))) return 0.9;
  return similarity(tokens(translit(src.artist)), tokens(translit(cand.artist))) * 0.8;
}

export function matchScore(src: ImportedTrack, cand: Track): number {
  const srcTitle = tokens(translit(cleanTitle(src.title).replace(/\(.*?\)/g, '')));
  const candTitle = tokens(translit(cand.title.replace(/\(.*?\)/g, '')));
  const titleSim = similarity(srcTitle, candTitle);
  const artistSim = artistSimilarity(src, cand);
  const durSim = src.durationMs > 0 && cand.durationMs > 0 ? Math.max(0, 1 - Math.abs(src.durationMs - cand.durationMs) / 30_000) : 0.5;
  const srcVersions = versionTags(src.title).join();
  const versionPenalty = srcVersions !== versionTags(cand.title).join() ? 0.25 : 0;
  // Same title by somebody else (covers, namesakes) is the classic wrong match: without the artist it needs a
  // near-identical length to pass.
  const strangerPenalty = artistSim < 0.5 && !(titleSim === 1 && durSim > 0.9) ? 0.35 : 0;
  return 0.45 * titleSim + 0.35 * artistSim + 0.2 * durSim + (cand.official ? 0.05 : 0) - versionPenalty - strangerPenalty;
}

export function bestMatch(src: ImportedTrack, candidates: Track[]): Track | null {
  let best: Track | null = null;
  let bestScore = MIN_SCORE;
  for (const c of candidates) {
    const s = matchScore(src, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

const SITE_TLD = 'ru|com|net|fm|org|me|su|info|cc|io|to|top|club|pro|online|xyz|biz|ws|tv|by|ua|kz|site|music|mobi';
const SITE_RE = new RegExp(`[([{]?\\s*(?:https?://)?(?:www\\.)?[\\w-]+(?:\\.[\\w-]+)*\\.(?:${SITE_TLD})(?:/\\S*)?\\s*[)\\]}]?`, 'gi');
const FILE_NOISE_RE = /[([{]?\s*(?:\d{2,3}\s*kbps|mp3|flac|m4a|ogg|скачать|бесплатно|free\s+download|@[\w.]+)\s*[)\]}]?/gi;

/**
 * Title and artist of an audio file sent to the Telegram bot: tags are often missing or carry the file name
 * ("01._Artist_-_Song_(muzofond.fm).mp3"), so site names, bitrates, track numbers and underscores are dropped
 * and "Artist - Title" is split.
 */
export function cleanFileTrack(rawTitle: string, rawArtist: string): { title: string; artist: string } {
  const tidy = (s: string) =>
    s
      .replace(/\.(?:mp3|m4a|flac|ogg|opus|wav|aac)$/i, '')
      .replace(/_+/g, ' ')
      .replace(/%20/g, ' ')
      .replace(SITE_RE, ' ')
      .replace(FILE_NOISE_RE, ' ')
      .replace(/[([{]\s*[)\]}]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s|\-–—:.,]+|[\s|\-–—:,]+$/g, '')
      .trim();
  let title = tidy(rawTitle).replace(/^\d{1,3}(?:[.)]\s*|\s+[-–—]\s+)/, '');
  let artist = tidy(rawArtist);
  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const head = parts[0].trim();
    if (!artist) {
      artist = head;
      title = parts.slice(1).join(' - ');
    } else if (head.toLowerCase() === artist.toLowerCase()) {
      title = parts.slice(1).join(' - ');
    }
  }
  if (/^(?:unknown|неизвестен|неизвестный|various artists?|va)$/i.test(artist)) artist = '';
  title = cleanTitle(title) || title || 'Без названия';
  return { title, artist };
}

/** "Artist - Title" lines, or CSV exports (Exportify, TuneMyMusic…) with title/artist columns. */
export function parseTrackList(text: string): ImportedTrack[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const titleCol = header.findIndex((h) => /^(track name|title|name|track|название|трек)$/.test(h));
  const artistCol = header.findIndex((h) => /^(artist name\(s\)|artist name|artists?|исполнитель|исполнители)$/.test(h));
  if (titleCol >= 0 && artistCol >= 0) {
    const durCol = header.findIndex((h) => /^(duration \(ms\)|duration_ms|duration)$/.test(h));
    return lines.slice(1).map((l) => {
      const cells = splitCsv(l);
      return { title: cells[titleCol] ?? '', artist: (cells[artistCol] ?? '').replace(/;/g, ', '), durationMs: Number(cells[durCol]) || 0 };
    }).filter((t) => t.title);
  }
  return lines
    .map((l) => l.replace(/^\d+[.)]\s*/, ''))
    .map((l) => {
      const parts = l.split(/\s+[-–—]\s+/);
      return parts.length >= 2 ? { artist: parts[0], title: parts.slice(1).join(' - '), durationMs: 0 } : { artist: '', title: l, durationMs: 0 };
    });
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
