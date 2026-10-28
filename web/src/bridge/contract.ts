/**
 * Typed bridge contract between the web UI and the Android layer. Keep in sync with docs/bridge.md and
 * android/app/src/main/java/app/youmusic/bridge/modules/*.
 */

export type TrackSource = 'yt' | 'local';

export interface Track {
  /** "yt:<videoId>" or "local:<hash>" */
  id: string;
  source: TrackSource;
  title: string;
  artist: string;
  album?: string | null;
  durationMs: number;
  artwork?: string | null;
  url?: string | null;
  artistUrl?: string | null;
  /** Topic channel / YouTube Music song / own file: the canonical audio version. */
  official?: boolean;
  views?: number | null;
}

export interface Collection {
  kind: 'album' | 'playlist';
  id: string;
  title: string;
  subtitle?: string | null;
  artwork?: string | null;
  url: string;
  count?: number | null;
}

export interface Artist {
  id: string;
  name: string;
  artwork?: string | null;
  url: string;
  subscribers?: number | null;
}

export type SearchFilter = 'all' | 'songs' | 'videos' | 'albums' | 'artists' | 'playlists';

export interface SearchItem {
  kind: 'track' | 'album' | 'playlist' | 'artist';
  track?: Track;
  collection?: Collection;
  artist?: Artist;
}

export interface SearchPage {
  items: SearchItem[];
  nextPage?: string | null;
}

export interface CollectionPage {
  collection: Collection;
  tracks: Track[];
}

export interface ArtistPage {
  artist: Artist;
  banner?: string | null;
  tracks: Track[];
  albums: Collection[];
}

export interface TrackDetails {
  track: Track;
  related: Track[];
}

export interface Playlist {
  id: number;
  name: string;
  count: number;
  artwork?: string | null;
  updatedAt: number;
}

export interface PlaylistPage {
  playlist: Playlist;
  tracks: Track[];
}

export interface Like {
  track: Track;
  likedAt: number;
}

export interface HistoryEntry {
  track: Track;
  playedAt: number;
  listenedMs: number;
  durationMs: number;
  completed: boolean;
  skipped: boolean;
}

export type DownloadStatus = 'queued' | 'running' | 'done' | 'failed' | 'removed';

export interface Download {
  trackId: string;
  track?: Track | null;
  status: DownloadStatus;
  progress: number;
  bytes: number;
  quality: string;
  localArt?: string | null;
  error?: string | null;
}

export interface Library {
  likes: Like[];
  playlists: Playlist[];
  downloads: Download[];
  local: Track[];
}

export interface StorageInfo {
  downloadsBytes: number;
  cacheBytes: number;
  freeBytes: number;
  cacheLimitBytes: number;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  buffering: boolean;
  positionMs: number;
  durationMs: number;
  repeat: RepeatMode;
  shuffle: boolean;
}

export interface Palette {
  blurUrl?: string | null;
  color?: string | null;
}

/** Track list read from another service (Spotify, Yandex Music) or pasted as text. */
export interface ImportedTrack {
  title: string;
  artist: string;
  durationMs: number;
}

export interface ImportedList {
  title: string;
  source: string;
  tracks: ImportedTrack[];
  /** Set when Yandex was read through a free public proxy ("1.2.3.4:8080"). */
  via?: string | null;
}

/** Basic audio data of a song (Deezer), used only by recommendations. */
export interface TrackFeatures {
  found: boolean;
  bpm?: number | null;
  /** ReplayGain-like, dB: more negative = louder master. */
  gainDb?: number | null;
  genres: string[];
  explicit: boolean;
  year?: number | null;
}

export interface Lyrics {
  plain?: string | null;
  synced?: string | null;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  permissions?: string[];
  entry: string;
  styles?: string[];
  [key: string]: unknown;
}

export interface StagedMod {
  stageId: string;
  manifest: ModManifest;
}

export interface InstalledMod {
  id: string;
  manifest: ModManifest;
  baseUrl: string;
}

export interface Proxy {
  id: string;
  type: 'socks5' | 'http';
  host: string;
  port: number;
  user?: string | null;
  pass?: string | null;
  name?: string | null;
  /** Last measured round trip to YouTube through this proxy; -1 = failed. */
  pingMs?: number | null;
}

export interface ProxyState {
  proxies: Proxy[];
  activeId?: string | null;
  enabled: boolean;
  vpnActive: boolean;
  inUse: boolean;
}

export interface VersionInfo {
  versionCode: number;
  versionName: string;
  channel: string;
  apk: string;
  notes?: string | null;
  sha?: string | null;
  publishedAt?: string | null;
}

export type UpdateStatus = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

export interface UpdateState {
  currentVersion: string;
  currentCode: number;
  latest?: VersionInfo | null;
  status: UpdateStatus;
  progress: number;
  error?: string | null;
  checkedAt: number;
  /** The downloaded APK is signed with another key: it will not install over this one. */
  signatureMismatch?: boolean;
}

export interface BackupStatus {
  /** Auto backup folder name; null = auto backup is off. */
  folder?: string | null;
  savedAt: number;
  error?: string | null;
}

export interface BackupFolder {
  status: BackupStatus;
  /** The folder already holds a backup (e.g. after reinstalling). */
  existing?: { exportedAt: number; likes: number; playlists: number; history: number } | null;
}

export interface AiConfig {
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Hello {
  appVersion: string;
  extractorVersion: string;
  sdkInt: number;
  online: boolean;
  insets: Insets;
}

type None = Record<string, never>;

/** Command name → [arguments, result]. */
export interface Commands {
  hello: [None, Hello];
  kvGet: [{ key: string }, string | null];
  kvSet: [{ key: string; value: string | null }, void];
  kvKeys: [{ prefix: string }, string[]];
  haptic: [{ kind: 'light' | 'medium' | 'confirm' }, void];
  share: [{ text: string }, void];
  openUrl: [{ text: string }, void];
  moveToBack: [None, void];
  consumeDeepLink: [None, string | null];
  setSystemBars: [{ light: boolean }, void];
  pickTextFile: [{ mime: string }, { name: string; text: string } | null];
  saveTextFile: [{ name: string; text: string; mime: string }, boolean];

  play: [{ queue: Track[]; index: number; positionMs?: number }, void];
  pause: [None, void];
  resume: [None, void];
  seek: [{ positionMs: number }, void];
  next: [None, void];
  previous: [None, void];
  skipTo: [{ index: number }, void];
  queueAdd: [{ tracks: Track[]; next?: boolean }, void];
  queueRemove: [{ index: number }, void];
  queueMove: [{ from: number; to: number }, void];
  queueClear: [None, void];
  setRepeat: [{ mode: RepeatMode }, void];
  setShuffle: [{ enabled: boolean }, void];
  getPlayerState: [None, PlayerState];

  search: [{ query: string; filter: SearchFilter; page?: string | null }, SearchPage];
  searchSuggestions: [{ query: string }, string[]];
  trackDetails: [{ id: string }, TrackDetails];
  getCollection: [{ url: string }, CollectionPage];
  getArtist: [{ url: string }, ArtistPage];
  lyrics: [{ artist: string; title: string; durationMs: number }, Lyrics];
  artworkPalette: [{ url: string }, Palette];
  importFetch: [{ url: string }, ImportedList];
  trackFeatures: [{ tracks: { id: string; artist: string; title: string; durationMs: number }[] }, Record<string, TrackFeatures>];

  getLibrary: [None, Library];
  like: [{ track: Track; liked: boolean }, void];
  playlistCreate: [{ name: string; tracks?: Track[] }, Playlist];
  playlistRename: [{ id: number; name: string }, void];
  playlistDelete: [{ id: number }, void];
  playlistGet: [{ id: number }, PlaylistPage];
  playlistAdd: [{ id: number; tracks: Track[] }, void];
  playlistRemove: [{ id: number; index: number }, void];
  playlistMove: [{ id: number; from: number; to: number }, void];
  history: [{ limit: number }, HistoryEntry[]];
  historyClear: [None, void];
  libraryExport: [None, string];
  libraryImport: [{ json: string }, number];
  backupExport: [None, string];
  backupImport: [{ json: string }, number];
  backupStatus: [None, BackupStatus];
  backupSetFolder: [{ enabled: boolean }, BackupFolder | null];
  backupRestoreFolder: [None, number];
  backupNow: [None, boolean];

  download: [{ tracks: Track[]; quality?: string | null }, void];
  downloadRemove: [{ id: string }, void];
  downloads: [None, Download[]];
  storageInfo: [None, StorageInfo];
  clearCache: [None, void];
  localImport: [{ mode: 'files' | 'folder' }, Track[]];
  localRemove: [{ id: string }, void];

  proxyState: [None, ProxyState];
  proxyAdd: [{ link: string }, Proxy];
  proxyRemove: [{ id: string }, void];
  proxySelect: [{ id: string }, void];
  proxySetEnabled: [{ enabled: boolean }, void];
  proxyPing: [{ id: string }, number];
  proxyShareLink: [{ id: string }, string];

  updateState: [None, UpdateState];
  updateCheck: [None, UpdateState];
  updateDownload: [None, UpdateState];
  updateInstall: [None, void];
  updateSchedule: [{ enabled: boolean }, void];

  aiConfig: [None, AiConfig];
  aiConfigure: [{ baseUrl?: string; model?: string; key?: string; enabled?: boolean }, AiConfig];
  aiChat: [{ messages: AiMessage[]; temperature?: number }, string];

  modsList: [None, InstalledMod[]];
  modStage: [{ kind: 'zip' | 'folder' }, StagedMod | null];
  modInstall: [{ stageId: string }, InstalledMod];
  modRemove: [{ id: string }, void];
}

export type CommandName = keyof Commands;
export type ArgsOf<K extends CommandName> = Commands[K][0];
export type ResultOf<K extends CommandName> = Commands[K][1];

/** Native → UI events. */
export interface NativeEvents {
  progress: { positionMs: number; durationMs: number; bufferedMs: number };
  stateChanged: { playing: boolean; playWhenReady: boolean; buffering: boolean; repeat: RepeatMode; shuffle: boolean; ended: boolean };
  trackChanged: { track: Track | null; index: number };
  queueChanged: { queue: Track[]; index: number };
  playerError: { code: string; message: string; trackId: string | null };
  downloadProgress: Download;
  libraryChanged: { what: string };
  network: { online: boolean; unmetered: boolean; vpn: boolean };
  proxyChanged: ProxyState;
  updateState: UpdateState;
  backupState: BackupStatus;
  deepLink: { url: string };
  insets: Insets;
  back: Record<string, never>;
}

export type NativeEventName = keyof NativeEvents;
