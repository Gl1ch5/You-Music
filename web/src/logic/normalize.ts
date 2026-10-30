import type { Track } from '../bridge/contract';

/**
 * Turns raw YouTube metadata into "artist — title": strips upload noise like (Official Video), lyrics, HD,
 * and takes the artist from "Artist - Title" titles. Version markers (remix, slowed, live…) are kept.
 */

const NOISE_WORDS = [
  'official\\s+(?:music\\s+)?video',
  'official\\s+(?:hd\\s+)?video',
  'official\\s+audio',
  'official\\s+lyrics?\\s+video',
  'official\\s+visuali[sz]er',
  'official\\s+clip',
  'official\\s+mv',
  'official',
  'music\\s+video',
  'lyrics?\\s+video',
  'lyrics?',
  'with\\s+lyrics',
  'audio(?:\\s+only)?',
  'visuali[sz]er',
  'video\\s*clip',
  'videoclip',
  'video\\s+oficial',
  'clip\\s+officiel',
  'mv',
  'm\\/v',
  'hd',
  'hq',
  '4k(?:\\s+remaster(?:ed)?)?',
  '1080p',
  '720p',
  'full\\s+hd',
  'explicit',
  'клип',
  'премьера(?:\\s+клипа)?(?:[^)\\]]*)?',
  'официальн\\S*\\s+(?:видео|клип|аудио)',
  'текст(?:\\s+песни)?',
  'lyric',
];

const NOISE_RE = new RegExp(`[\\(\\[【]\\s*(?:${NOISE_WORDS.join('|')})\\s*[\\)\\]】]`, 'gi');
const TRAILING_NOISE_RE = new RegExp(`\\s*[|/•]\\s*(?:${NOISE_WORDS.join('|')})\\s*$`, 'i');
const DASHES = /\s+[-–—]\s+/;
const QUOTES = /^["'«“„](.+)["'»”“]$/;

export function cleanTitle(raw: string): string {
  let t = raw.replace(NOISE_RE, ' ');
  // "Song | Official Video", "Song / Lyrics"
  for (let i = 0; i < 3; i++) t = t.replace(TRAILING_NOISE_RE, '');
  t = t.replace(/[()[\]]\s*[()[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/[\s|\-–—:]+$/, '').trim();
  const q = t.match(QUOTES);
  return q ? q[1].trim() : t;
}

export function cleanArtist(raw: string): string {
  return raw
    .replace(/\s+-\s+Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*\((?:official|официальный)[^)]*\)\s*$/i, '')
    .replace(/\s+(?:official|music|официальный)$/i, '')
    .trim();
}

export function normalizeTrack<T extends Track>(track: T): T {
  if (track.source !== 'yt') return track;
  const uploader = cleanArtist(track.artist ?? '');
  let title = cleanTitle(track.title ?? '');
  let artist = uploader;
  if (track.official) {
    // Topic uploads sometimes still carry the artist in the title: "Sia - Snowman".
    const parts = title.split(DASHES);
    if (parts.length >= 2 && artistKey(parts[0]) === artistKey(uploader)) title = cleanTitle(parts.slice(1).join(' - '));
  } else {
    const parts = title.split(DASHES);
    if (parts.length >= 2 && parts[0].length > 0 && parts[0].length < 80) {
      artist = cleanArtist(parts[0]);
      title = cleanTitle(parts.slice(1).join(' - '));
    }
  }
  return { ...track, title: title || track.title, artist: artist || uploader || track.artist };
}

const VERSION_PATTERNS: [string, RegExp][] = [
  ['sped up', /\bsped[\s-]*up\b|\bspeed[\s-]*up\b|\bnightcore\b/i],
  ['slowed', /\bslowed\b|\breverb\b/i],
  ['remix', /\bremix\b|\brmx\b|\bbootleg\b|\bflip\b/i],
  ['extended', /\bextended\b|\bclub\s+mix\b/i],
  ['live', /\blive\b|\bконцерт\b|\bживьём\b/i],
  ['acoustic', /\bacoustic\b|\bunplugged\b/i],
  ['instrumental', /\binstrumental\b|\bkaraoke\b|\bминус\b/i],
  ['8d', /\b8d\b|\bbass\s*boost(?:ed)?\b/i],
  ['cover', /\bcover\b|\bкавер\b/i],
];

/** Version tags present in a title (remix, slowed, live…). Empty for the original. */
export function versionTags(title: string): string[] {
  return VERSION_PATTERNS.filter(([, re]) => re.test(title)).map(([tag]) => tag);
}

const VERSION_WORDS_RE = /\b(?:sped\s*up|speed\s*up|slowed|reverb|remix|extended|live|acoustic|instrumental|nightcore|8d|bass\s*boost(?:ed)?|remaster(?:ed)?|radio\s+edit|version|edit|mix|cover|karaoke)\b|\b(?:кавер|минус|ремикс|концерт)/giu;
// Upload noise outside brackets: "Song Official Video", "Song текст песни".
const LOOSE_NOISE_RE = new RegExp(`(?:^|\\s)(?:${NOISE_WORDS.join('|')})(?=\\s|$)`, 'giu');

/** Title and artist as one song, whoever uploaded it: "Channel" + "Artist - Song (Lyrics)" → "artist" + "song". */
function songParts(track: Pick<Track, 'title' | 'artist'>): { artist: string; title: string } {
  const strip = (t: string) =>
    t
      .toLowerCase()
      .replace(/[([【].*?[)\]】]/g, ' ')
      .replace(/\b(?:feat|ft|prod)\.?\s.*$/i, ' ')
      .replace(/\b(?:ultra|super|extra|very|mega)\s+(?=slowed|sped|speed|reverb|nightcore)/gi, ' ')
      .replace(LOOSE_NOISE_RE, ' ')
      .replace(VERSION_WORDS_RE, ' ');
  let artist = track.artist;
  let title = cleanTitle(track.title);
  const parts = title.split(DASHES);
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(' ');
    // "Raya - Sped Up": the right side is only a version tag.
    if (compact(strip(right))) {
      title = right;
      if (artistKey(left) !== artistKey(artist)) artist = left;
    } else title = left;
  }
  let song = compact(strip(title));
  // "LO0K" + "Sped Up": the title is only a version tag, the song's name sits in the artist field.
  if (!song) song = compact(strip(artist));
  return { artist: latin(artistKey(artist)), title: latin(song) };
}

/** Key that is equal for all versions and uploads of one song: "artist|title" without versions, feats and noise. */
export function songKey(track: Pick<Track, 'title' | 'artist'>): string {
  const p = songParts(track);
  return `${p.artist}|${p.title}`;
}

/**
 * Every key a song is known by: the artist+title key and, for distinctive titles, the title alone — so a re-upload
 * credited to a random channel (or a translit of the artist) is still the same song.
 */
export function songKeys(track: Pick<Track, 'title' | 'artist'>): string[] {
  const p = songParts(track);
  const keys = [`${p.artist}|${p.title}`];
  if (p.title.replace(/\s/g, '').length >= 6) keys.push(`*|${p.title}`);
  return keys;
}

const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Cyrillic → Latin and no diacritics, so "Сплин" and "Splin", "Beyoncé" and "Beyonce" key the same. */
function latin(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[а-яё]/g, (c) => LATIN[c] ?? c)
    .replace(/kh/g, 'h')
    .replace(/j/g, 'y');
}

/** First credited artist, lowercased: "Elgy, MORGENSHTERN & X" → "elgy". */
export function artistKey(artist: string): string {
  const first = artist.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|×|\/)\s*/i)[0] ?? artist;
  return compact(cleanArtist(first).toLowerCase());
}

function compact(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function normalizeQuery(q: string): string[] {
  return compact(q.toLowerCase()).split(' ').filter(Boolean);
}

/** Splits a credit line into artists: "A, B & C feat. D" → [A, B, C, D]. */
export function splitArtists(artist: string): string[] {
  return cleanArtist(artist)
    .split(/\s*(?:,|;|&|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\s[xх×]\s|\s\/\s)\s*/i)
    .map((s) => cleanArtist(s.trim()))
    .filter(Boolean);
}
