import type { Download, Insets, Like, Playlist, RepeatMode, Track, UpdateState } from '../bridge/contract';
import type { RecoFilter } from '../logic/filters';
import { computed, signal } from './signal';

/** Global UI state. Native is the source of truth; these signals mirror it via bridge events. */

export interface Settings {
  streamQuality: 'high' | 'normal' | 'low';
  downloadQuality: 'high' | 'normal' | 'low';
  wifiOnlyDownloads: boolean;
  cacheLimitMb: number;
  themeId: string;
  motion: 'system' | 'reduced' | 'full';
  /** Icon pack: 'theme' follows the theme, otherwise an id from design/iconPacks. */
  iconStyle: string;
  waveMode: 'mix' | 'familiar' | 'discover';
  /** Fast: fewer lookups and the quick model; deep: more candidates checked and the stronger model. */
  recoDepth: 'fast' | 'deep';
  /** The model adds its picks to "Рекомендации" (and follows the user's own text filters). Off by default. */
  recoAi: boolean;
  /** The model adds its picks to waves by a track or a playlist. Off by default. */
  waveAi: boolean;
  recoFilters: RecoFilter[];
  /** The user's own filters in words ("грустное", "для бега"); only the model can follow them. */
  recoCustom: string[];
  recoCustomActive: string[];
  hideVersionsInSearch: boolean;
  autoDownloadLiked: boolean;
  crossfadeSec: number;
  autoUpdate: boolean;
  autoDownloadUpdates: boolean;
  updateChannel: 'nightly' | 'stable';
}

export const defaultSettings: Settings = {
  streamQuality: 'high',
  downloadQuality: 'high',
  wifiOnlyDownloads: false,
  cacheLimitMb: 2048,
  themeId: 'graphite',
  motion: 'system',
  iconStyle: 'theme',
  waveMode: 'mix',
  recoDepth: 'fast',
  recoAi: false,
  waveAi: false,
  recoFilters: [],
  recoCustom: [],
  recoCustomActive: [],
  hideVersionsInSearch: false,
  autoDownloadLiked: true,
  crossfadeSec: 4,
  autoUpdate: true,
  autoDownloadUpdates: true,
  updateChannel: 'nightly',
};

/** What started the current queue; shown in the player header and used to extend the wave. */
export type PlayContext =
  | { kind: 'wave'; title: string }
  | { kind: 'list'; title: string; route?: string }
  | null;

export const app = {
  ready: signal(false),
  online: signal(true),
  insets: signal<Insets>({ top: 0, bottom: 0, left: 0, right: 0 }),
  settings: signal<Settings>(defaultSettings),
  version: signal({ app: '', extractor: '' }),
  update: signal<UpdateState | null>(null),
  aiEnabled: signal(false),
  /** Number of user-started actions still loading (see `busy()`); a thin bar at the top shows it. */
  busy: signal(0),

  likes: signal<Like[]>([]),
  playlists: signal<Playlist[]>([]),
  downloads: signal<Map<string, Download>>(new Map()),
  local: signal<Track[]>([]),
};

export const player = {
  queue: signal<Track[]>([]),
  index: signal(-1),
  playing: signal(false),
  /** The user wants playback (play pressed), even while the stream is still loading. Drives the play/pause glyph. */
  wantsPlay: signal(false),
  buffering: signal(false),
  /** A stream (wave) is being put together: recommendations are still loading, nothing plays yet. */
  preparing: signal(false),
  repeat: signal<RepeatMode>('off'),
  shuffle: signal(false),
  /** Last reported position; the UI extrapolates between reports with requestAnimationFrame. */
  position: signal({ ms: 0, durationMs: 0, at: 0 }),
  context: signal<PlayContext>(null),
  fullOpen: signal(false),
};

export const currentTrack = computed<Track | null>(() => player.queue.value[player.index.value] ?? null);

export const likedIds = computed(() => new Set(app.likes.value.map((l) => l.track.id)));

export function isDownloaded(id: string): boolean {
  return app.downloads.peek().get(id)?.status === 'done';
}

export function isPlayable(track: Track): boolean {
  return track.source === 'local' || app.online.peek() || isDownloaded(track.id);
}

/** Current playback position in ms, extrapolated from the last native report. */
export function livePosition(): number {
  const p = player.position.peek();
  if (!player.playing.peek()) return p.ms;
  const ms = p.ms + (performance.now() - p.at);
  return p.durationMs > 0 ? Math.min(ms, p.durationMs) : ms;
}
