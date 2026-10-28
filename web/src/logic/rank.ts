import type { Track } from '../bridge/contract';
import { normalizeQuery, songKey, versionTags } from './normalize';

/**
 * Orders search results for listening rather than watching:
 * canonical audio (Topic channels, YouTube Music, "official audio") first, durations close to the original,
 * music videos with long intros lower, unrequested versions (sped up, slowed…) lower.
 * Input tracks must already be normalized; `rawTitles` maps id → original YouTube title.
 */
export function rankTracks(tracks: Track[], query: string, rawTitles: Map<string, string> = new Map()): Track[] {
  const terms = normalizeQuery(query);
  const wantedVersions = new Set(versionTags(query));
  const refDuration = referenceDurations(tracks);

  const scored = tracks.map((t, i) => {
    const raw = (rawTitles.get(t.id) ?? t.title).toLowerCase();
    let score = (1 - i / Math.max(tracks.length, 1)) * 2;

    if (t.official) score += 3;
    if (/official\s+audio|официальн\S*\s+аудио/.test(raw)) score += 2;
    if (/official|официальн/.test(raw)) score += 0.5;

    const haystack = normalizeQuery(`${t.artist} ${t.title}`).join(' ');
    if (terms.length) score += (terms.filter((term) => haystack.includes(term)).length / terms.length) * 3;

    const ref = refDuration.get(songKey(t));
    if (ref && t.durationMs > 0) {
      const diffSec = Math.abs(t.durationMs - ref) / 1000;
      score -= Math.min(2, (diffSec / 30) * 0.7);
      const isVideo = /video|клип|clip|\bmv\b/.test(raw);
      if (isVideo && t.durationMs - ref > 20_000) score -= 1;
    }

    const versions = versionTags(t.title);
    if (versions.some((v) => !wantedVersions.has(v))) score -= 1.5;
    if (t.durationMs > 15 * 60_000) score -= 2;

    return { t, score, i };
  });

  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.t);
}

/** Per song: duration of the canonical version if present, else the median of all uploads. */
export function referenceDurations(tracks: Track[]): Map<string, number> {
  const groups = new Map<string, Track[]>();
  for (const t of tracks) {
    if (t.durationMs <= 0) continue;
    const key = songKey(t);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out = new Map<string, number>();
  for (const [key, group] of groups) {
    const official = group.find((t) => t.official && versionTags(t.title).length === 0);
    if (official) {
      out.set(key, official.durationMs);
      continue;
    }
    const originals = group.filter((t) => versionTags(t.title).length === 0);
    const sorted = (originals.length ? originals : group).map((t) => t.durationMs).sort((a, b) => a - b);
    out.set(key, sorted[Math.floor((sorted.length - 1) / 2)]);
  }
  return out;
}
