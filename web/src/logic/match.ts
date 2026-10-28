import type { ImportedTrack, Track } from '../bridge/contract';
import { artistKey, cleanTitle, normalizeQuery, versionTags } from './normalize';

/**
 * Matching tracks from other services (Spotify, Yandex Music, text lists) to YouTube search results.
 * Title similarity weighs most, then artist, then duration; a version mismatch (remix vs original) is penalised.
 */

const MIN_SCORE = 0.5;

function tokens(s: string): Set<string> {
  return new Set(normalizeQuery(s));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  a.forEach((t) => b.has(t) && common++);
  return common / Math.min(a.size, b.size);
}

export function matchScore(src: ImportedTrack, cand: Track): number {
  const srcTitle = tokens(cleanTitle(src.title).replace(/\(.*?\)/g, ''));
  const candTitle = tokens(cand.title.replace(/\(.*?\)/g, ''));
  const titleSim = overlap(srcTitle, candTitle);
  const srcArtists = src.artist.split(/\s*(?:,|&|feat\.?|ft\.?)\s*/i).map(artistKey).filter(Boolean);
  const candArtist = `${artistKey(cand.artist)} ${normalizeQuery(cand.artist).join(' ')}`;
  const artistSim = srcArtists.length ? (srcArtists.some((a) => candArtist.includes(a)) ? 1 : overlap(tokens(src.artist), tokens(cand.artist))) : 0.5;
  const durSim = src.durationMs > 0 && cand.durationMs > 0 ? Math.max(0, 1 - Math.abs(src.durationMs - cand.durationMs) / 30_000) : 0.5;
  const srcVersions = versionTags(src.title).join();
  const versionPenalty = srcVersions !== versionTags(cand.title).join() ? 0.25 : 0;
  return 0.5 * titleSim + 0.3 * artistSim + 0.2 * durSim + (cand.official ? 0.05 : 0) - versionPenalty;
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
