import type { Transport } from './bridge';
import type {
  AiConfig,
  Commands,
  Download,
  HistoryEntry,
  ImportedList,
  Like,
  Playlist,
  Proxy,
  ProxyState,
  RepeatMode,
  ServerStatus,
  TgList,
  TgTrack,
  Track,
  UpdateState,
} from './contract';

/**
 * The bridge for the web player (grzxk.ru/youmusic/app) and the Windows/Linux app (desktop/, pywebview).
 * Catalog, audio and lyrics come from the Python backend (`desktop/youmusic/app.py`, same origin, `api/*`);
 * the library, settings and own files live in the browser (localStorage + IndexedDB); the You Music account
 * is reached through the backend (`server/*`). Library JSON is the same as the Android backup, so the
 * account sync moves likes and playlists between the phone and the computer.
 */

type Emit = (name: string, data: unknown) => void;
let emit: Emit = () => undefined;

class WebError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const url = (path: string) => new URL(path, document.baseURI).toString();

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url(`api/${path}`), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new WebError('network', 'Нет связи с сервером плеера');
  }
  const json = await r.json().catch(() => null);
  if (!r.ok || !json) throw new WebError(json?.error?.code ?? 'network', json?.error?.message ?? `Сервер ответил ${r.status}`);
  return json.result as T;
}

const q = (o: Record<string, string | null | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] != null && e[1] !== '')).toString();

/* ───────── persistent storage ───────── */

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`ym.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value == null) localStorage.removeItem(`ym.${key}`);
      else localStorage.setItem(`ym.${key}`, value);
    } catch {
      /* full or blocked: the session still works */
    }
  },
  json<T>(key: string, fallback: T): T {
    try {
      return { ...fallback, ...JSON.parse(store.get(key) ?? 'null') };
    } catch {
      return fallback;
    }
  },
};

interface StoredPlaylist {
  id: number;
  name: string;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface StoredHistory {
  trackId: string;
  playedAt: number;
  listenedMs: number;
  durationMs: number;
  completed: boolean;
  skipped: boolean;
}

interface Lib {
  tracks: Record<string, Track>;
  likes: { trackId: string; likedAt: number }[];
  playlists: StoredPlaylist[];
  history: StoredHistory[];
  local: string[];
}

const HISTORY_LIMIT = 3000;
const lib: Lib = store.json<Lib>('library', { tracks: {}, likes: [], playlists: [], history: [], local: [] });
const kv: Record<string, string> = store.json<Record<string, string>>('kv', {});

let saveTimer = 0;
function saveSoon(what: string, sync = what !== 'history'): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 300);
  emit('libraryChanged', { what });
  if (sync) schedulePush();
}
function saveNow(): void {
  clearTimeout(saveTimer);
  // Keep only tracks something still points to.
  const used = new Set<string>([...lib.likes.map((l) => l.trackId), ...lib.playlists.flatMap((p) => p.trackIds), ...lib.history.map((x) => x.trackId), ...lib.local]);
  for (const id of Object.keys(lib.tracks)) if (!used.has(id)) delete lib.tracks[id];
  store.set('library', JSON.stringify(lib));
}
window.addEventListener('pagehide', () => {
  saveNow();
  savePlayer();
});

function remember(t: Track): void {
  lib.tracks[t.id] = { ...lib.tracks[t.id], ...t };
}

function playlistDto(p: StoredPlaylist): Playlist {
  const first = p.trackIds.map((id) => lib.tracks[id]).find((t) => t?.artwork);
  return { id: p.id, name: p.name, count: p.trackIds.length, artwork: first?.artwork ?? null, updatedAt: p.updatedAt };
}

function findPlaylist(id: number): StoredPlaylist {
  const p = lib.playlists.find((x) => x.id === id);
  if (!p) throw new WebError('not_found', 'Плейлист не найден');
  return p;
}

/* ───────── own files (IndexedDB) ───────── */

let dbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('youmusic', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new WebError('storage', 'Браузер не дал сохранить файлы'));
  });
  return dbPromise;
}
async function fileOp<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = op(db.transaction('files', mode).objectStore('files'));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(new WebError('storage', 'Не хватает места в браузере'));
  });
}
const putFile = (id: string, blob: Blob) => fileOp<void>('readwrite', (s) => s.put(blob, id));
const getFile = (id: string) => fileOp<Blob | undefined>('readonly', (s) => s.get(id));
const deleteFile = (id: string) => fileOp<void>('readwrite', (s) => s.delete(id));

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function pickFiles(accept: string, folder = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

function durationOf(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    const src = URL.createObjectURL(blob);
    const done = (ms: number) => {
      URL.revokeObjectURL(src);
      resolve(ms);
    };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    a.preload = 'metadata';
    a.src = src;
  });
}

function nameToTrack(fileName: string): { title: string; artist: string } {
  const base = fileName.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: 'Неизвестный исполнитель', title: base };
}

async function addLocal(id: string, blob: Blob, meta: { title: string; artist: string; durationMs?: number; artwork?: string | null }): Promise<Track> {
  await putFile(id, blob);
  const track: Track = { id, source: 'local', title: meta.title, artist: meta.artist, durationMs: meta.durationMs || (await durationOf(blob)), artwork: meta.artwork ?? null, official: true };
  remember(track);
  if (!lib.local.includes(id)) lib.local.unshift(id);
  return track;
}

/* ───────── player ───────── */

const audio = new Audio();
audio.preload = 'auto';
let queue: Track[] = [];
let index = -1;
let repeat: RepeatMode = 'off';
let shuffleOn = false;
let wantPlay = false;
let ended = false;
let loadSeq = 0;
let blobUrl: string | null = null;
let listened = 0;
let lastTime = 0;
let errorsInRow = 0;

const current = () => queue[index] as Track | undefined;
const durationMs = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : (current()?.durationMs ?? 0));
const buffering = () => wantPlay && !ended && !!audio.src && (audio.readyState < 3 || audio.seeking);

function bufferedMs(): number {
  const t = audio.currentTime;
  for (let i = 0; i < audio.buffered.length; i++) if (audio.buffered.start(i) <= t + 0.5 && audio.buffered.end(i) >= t) return Math.round(audio.buffered.end(i) * 1000);
  return Math.round(t * 1000);
}

function emitState(): void {
  emit('stateChanged', { playing: !audio.paused && !buffering(), playWhenReady: wantPlay, buffering: buffering(), repeat, shuffle: shuffleOn, ended });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = wantPlay ? 'playing' : 'paused';
}
function emitProgress(): void {
  emit('progress', { positionMs: Math.round(audio.currentTime * 1000), durationMs: durationMs(), bufferedMs: bufferedMs() });
}
function emitQueue(): void {
  emit('queueChanged', { queue, index });
  savePlayer();
}

let playerTimer = 0;
function savePlayer(): void {
  clearTimeout(playerTimer);
  playerTimer = window.setTimeout(() => {
    const start = Math.max(0, index - 50);
    store.set('player', JSON.stringify({ queue: queue.slice(start, start + 300), index: index - start, positionMs: Math.round(audio.currentTime * 1000), repeat, shuffle: shuffleOn }));
  }, 500);
}

function recordHistory(): void {
  const t = current();
  if (!t || listened < 5000) return;
  const d = durationMs();
  const completed = ended || (d > 0 && listened >= d * 0.5);
  remember(t);
  lib.history.unshift({ trackId: t.id, playedAt: Date.now(), listenedMs: Math.round(listened), durationMs: d, completed, skipped: !completed });
  lib.history.length = Math.min(lib.history.length, HISTORY_LIMIT);
  saveSoon('history');
}

async function srcFor(t: Track): Promise<string> {
  if (t.source === 'local') {
    const blob = await getFile(t.id);
    if (!blob) throw new WebError('not_found', 'Файл не найден на этом устройстве');
    blobUrl = URL.createObjectURL(blob);
    return blobUrl;
  }
  return url(`api/stream/${encodeURIComponent(t.id.replace(/^yt:/, ''))}`);
}

async function load(i: number, positionMs = 0, play = true): Promise<void> {
  recordHistory();
  const seq = ++loadSeq;
  index = i;
  listened = 0;
  ended = false;
  wantPlay = play;
  const t = current();
  emit('trackChanged', { track: t ?? null, index });
  savePlayer();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  if (!t) {
    audio.removeAttribute('src');
    audio.load();
    wantPlay = false;
    emitState();
    return;
  }
  updateMediaSession(t);
  emitState();
  try {
    const src = await srcFor(t);
    if (seq !== loadSeq) return;
    audio.src = src;
    if (positionMs > 0) audio.currentTime = positionMs / 1000;
    lastTime = positionMs / 1000;
    if (play) await audio.play().catch((e: Error) => e.name === 'NotAllowedError' && ((wantPlay = false), emitState()));
  } catch (e) {
    if (seq === loadSeq) fail((e as Error).message);
  }
  emitProgress();
}

function fail(message: string): void {
  const t = current();
  emit('playerError', { code: 'playback', message, trackId: t?.id ?? null });
  // Skip a broken track, but do not run through the whole queue when the network is down.
  if (navigator.onLine && ++errorsInRow < 4 && index < queue.length - 1) setTimeout(() => void load(index + 1), 800);
  else {
    wantPlay = false;
    emitState();
  }
}

audio.addEventListener('playing', () => {
  errorsInRow = 0;
  emitState();
});
for (const ev of ['pause', 'waiting', 'canplay', 'seeking', 'seeked', 'stalled']) audio.addEventListener(ev, () => emitState());
audio.addEventListener('durationchange', emitProgress);
audio.addEventListener('timeupdate', () => {
  const t = audio.currentTime;
  if (!audio.paused && t > lastTime && t - lastTime < 2) listened += (t - lastTime) * 1000;
  lastTime = t;
});
audio.addEventListener('error', () => {
  if (!audio.src || audio.src === location.href) return;
  fail('Не удалось воспроизвести трек');
});
audio.addEventListener('ended', () => {
  if (repeat === 'one') {
    audio.currentTime = 0;
    void audio.play();
    return;
  }
  ended = true;
  if (index < queue.length - 1) void load(index + 1);
  else if (repeat === 'all' && queue.length) void load(0);
  else {
    recordHistory();
    listened = 0;
    wantPlay = false;
    emitState();
  }
});
setInterval(() => {
  if (!audio.paused) {
    emitProgress();
    savePlayer();
  }
}, 500);

function updateMediaSession(t: Track): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album ?? '', artwork: t.artwork ? [{ src: t.artwork, sizes: '512x512' }] : [] });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a: MediaSessionAction, f: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(a, f);
    } catch {
      /* not supported here */
    }
  };
  set('play', () => void handlers.resume?.({} as never));
  set('pause', () => void handlers.pause?.({} as never));
  set('nexttrack', () => void handlers.next?.({} as never));
  set('previoustrack', () => void handlers.previous?.({} as never));
  set('seekto', (d) => d.seekTime != null && void handlers.seek?.({ positionMs: d.seekTime * 1000 }));
}

function restore(): void {
  const s = store.json<{ queue: Track[]; index: number; positionMs: number; repeat: RepeatMode; shuffle: boolean }>('player', { queue: [], index: -1, positionMs: 0, repeat: 'off', shuffle: false });
  queue = s.queue;
  repeat = s.repeat;
  shuffleOn = s.shuffle;
  if (s.index >= 0 && s.index < queue.length) {
    index = s.index;
    const t = current()!;
    updateMediaSession(t);
    // Loaded lazily on the first «play», so opening the page does not start a stream.
    pendingRestore = s.positionMs;
  }
}
let pendingRestore: number | null = null;

/* ───────── account (You Music server) ───────── */

interface ServerUser {
  login: string;
  ai?: { enabled: boolean; limit: number; left: number };
  proxy?: { type: string; host: string; port: number; user: string; pass: string } | null;
}

const account = {
  get token() {
    return store.get('server.token');
  },
  set token(v: string | null) {
    store.set('server.token', v);
  },
  get user(): ServerUser | null {
    try {
      return JSON.parse(store.get('server.user') ?? 'null');
    } catch {
      return null;
    }
  },
  set user(v: ServerUser | null) {
    store.set('server.user', v ? JSON.stringify(v) : null);
  },
  syncing: false,
  error: null as string | null,
};

async function srv<T>(path: string, method = 'GET', body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && account.token) headers.Authorization = `Bearer ${account.token}`;
  let r: Response;
  try {
    r = await fetch(url(`server${path}`), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new WebError('network', 'Сервер недоступен');
  }
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401 && auth) logoutLocal();
    throw new WebError(json?.error ?? 'server', json?.message ?? `Сервер ответил ${r.status}`);
  }
  return json as T;
}

function serverStatus(): ServerStatus {
  const u = account.user;
  const p = proxies();
  return {
    signedIn: !!account.token,
    login: u?.login ?? null,
    syncedAt: Number(store.get('server.syncedAt') ?? 0),
    syncing: account.syncing,
    syncError: account.error,
    ai: u?.ai ?? { enabled: false, limit: 0, left: 0 },
    proxyAvailable: DESKTOP && !!u?.proxy,
    proxyOn: DESKTOP && p.enabled && p.activeId === 'server',
  };
}
const emitServer = () => emit('serverState', serverStatus());

function logoutLocal(): void {
  account.token = null;
  account.user = null;
  store.set('server.syncedAt', null);
  store.set('server.remoteAt', null);
  account.error = null;
  emitServer();
}

async function refreshUser(): Promise<void> {
  if (!account.token) return;
  account.user = await srv<ServerUser>('/api/me').catch(() => account.user);
  emitServer();
}

let syncing: Promise<void> | null = null;
async function sync(): Promise<void> {
  if (!account.token) return;
  syncing ??= (async () => {
    account.syncing = true;
    emitServer();
    try {
      const remote = await srv<{ updatedAt: number; data: string | null }>('/api/sync');
      if (remote.data && remote.updatedAt > Number(store.get('server.remoteAt') ?? 0)) importBackup(remote.data, true, true);
      const pushed = await srv<{ updatedAt: number }>('/api/sync', 'PUT', { data: exportBackup() });
      store.set('server.remoteAt', String(pushed.updatedAt));
      store.set('server.syncedAt', String(Date.now()));
      account.error = null;
    } catch (e) {
      account.error = (e as Error).message || 'Не удалось синхронизировать';
    } finally {
      account.syncing = false;
      syncing = null;
      emitServer();
    }
  })();
  return syncing;
}

let pushTimer = 0;
let quiet = false;
function schedulePush(): void {
  if (quiet || !account.token) return;
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => navigator.onLine && void sync(), 20_000);
}

/* ───────── backup (same JSON as the Android app) ───────── */

const AI_KEY = 'native.ai';

function exportBackup(withHistory = true): string {
  const ids = new Set([...lib.likes.map((l) => l.trackId), ...lib.playlists.flatMap((p) => p.trackIds), ...(withHistory ? lib.history.map((x) => x.trackId) : [])]);
  const settings = Object.fromEntries(Object.entries(kv).filter(([k]) => !k.startsWith('backup.')));
  return JSON.stringify({
    format: 'you-music-library',
    version: 2,
    exportedAt: Date.now(),
    tracks: [...ids].map((id) => lib.tracks[id]).filter(Boolean),
    likes: lib.likes,
    playlists: lib.playlists.map((p) => ({ name: p.name, trackIds: p.trackIds })),
    history: withHistory ? lib.history : [],
    settings,
  });
}

function importBackup(json: string, merge = false, silent = false): number {
  let data: { format?: string; tracks?: Track[]; likes?: { trackId: string; likedAt: number }[]; playlists?: { name: string; trackIds: string[] }[]; history?: StoredHistory[]; settings?: Record<string, string> };
  try {
    data = JSON.parse(json);
  } catch {
    throw new WebError('bad_request', 'Файл не похож на экспорт библиотеки');
  }
  if (data.format !== 'you-music-library') throw new WebError('bad_request', 'Неизвестный формат файла');
  quiet = silent;
  try {
    const tracks = data.tracks ?? [];
    tracks.forEach(remember);
    const known = new Set(tracks.map((t) => t.id));
    const liked = new Set(lib.likes.map((l) => l.trackId));
    lib.likes.push(...(data.likes ?? []).filter((l) => known.has(l.trackId) && !liked.has(l.trackId)));
    lib.likes.sort((a, b) => b.likedAt - a.likedAt);
    const now = Date.now();
    for (const p of data.playlists ?? []) {
      const incoming = p.trackIds.filter((id) => known.has(id));
      let target = lib.playlists.find((x) => x.name === p.name);
      if (!target) lib.playlists.push((target = { id: now + lib.playlists.length, name: p.name, trackIds: [], createdAt: now, updatedAt: now }));
      target.trackIds = [...new Set(merge ? [...target.trackIds, ...incoming] : incoming)];
      target.updatedAt = now;
    }
    const seen = new Set(lib.history.map((x) => `${x.trackId}:${x.playedAt}`));
    lib.history.push(...(data.history ?? []).filter((x) => known.has(x.trackId) && !seen.has(`${x.trackId}:${x.playedAt}`)));
    lib.history.sort((a, b) => b.playedAt - a.playedAt);
    lib.history.length = Math.min(lib.history.length, HISTORY_LIMIT);
    for (const [k, v] of Object.entries(data.settings ?? {})) if (!k.startsWith('backup.') && k !== AI_KEY && !k.startsWith('native.')) kv[k] = v;
    store.set('kv', JSON.stringify(kv));
    saveSoon('all');
    return tracks.length;
  } finally {
    quiet = false;
  }
}

/* ───────── proxy (desktop only: the browser cannot route the backend) ───────── */

const DESKTOP = /desktop/.test(document.documentElement.dataset.platform ?? '');

function proxies(): { list: Proxy[]; activeId: string | null; enabled: boolean } {
  return store.json('proxies', { list: [] as Proxy[], activeId: null as string | null, enabled: false });
}

function proxyUrl(p: Proxy): string {
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass ?? '')}@` : '';
  return `${p.type === 'http' ? 'http' : 'socks5h'}://${auth}${p.host}:${p.port}`;
}

function allProxies(): Proxy[] {
  const sp = account.user?.proxy;
  const server: Proxy[] = sp && account.token ? [{ id: 'server', type: sp.type === 'socks5' ? 'socks5' : 'http', host: sp.host, port: sp.port, user: sp.user, pass: sp.pass, name: 'Бесплатный прокси You Music' }] : [];
  return [...server, ...proxies().list];
}

function proxyState(): ProxyState {
  const s = proxies();
  const active = allProxies().find((p) => p.id === s.activeId);
  return { proxies: allProxies(), activeId: s.activeId, enabled: s.enabled, vpnActive: false, inUse: s.enabled && !!active };
}

async function applyProxy(next: Partial<ReturnType<typeof proxies>>): Promise<void> {
  const s = { ...proxies(), ...next };
  store.set('proxies', JSON.stringify(s));
  const active = allProxies().find((p) => p.id === s.activeId);
  await api('proxy', { url: s.enabled && active ? proxyUrl(active) : null });
  emit('proxyChanged', proxyState());
  emitServer();
}

function parseProxy(raw: string): Proxy {
  const link = raw.trim();
  const id = String(Date.now());
  let u: URL | null = null;
  try {
    u = new URL(link);
  } catch {
    /* host:port */
  }
  if (u?.protocol === 'youmusic:' && (u.host || u.pathname.replace(/^\/+/, '')).startsWith('proxy')) return parseProxy(u.searchParams.get('url') ?? '');
  const tgStyle = u && (u.protocol === 'tg:' || u.protocol === 'youmusic:' || (u.hostname.endsWith('t.me') && /^\/(socks|proxy)/.test(u.pathname)));
  if (u && tgStyle) {
    if (u.searchParams.get('secret')) throw new WebError('bad_request', 'Это MTProto-прокси Telegram — он работает только в Telegram. Нужен SOCKS5 или HTTP.');
    const server = u.searchParams.get('server');
    const port = Number(u.searchParams.get('port'));
    if (!server || !port) throw new WebError('bad_request', 'В ссылке нет server или port');
    const kind = (u.host || u.pathname).replace(/\//g, '');
    return { id, type: kind === 'http' ? 'http' : 'socks5', host: server, port, user: u.searchParams.get('user'), pass: u.searchParams.get('pass') };
  }
  if (u && /^(socks5?h?|https?):$/.test(u.protocol) && u.hostname && u.port) {
    return { id, type: u.protocol.startsWith('socks') ? 'socks5' : 'http', host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username) || null, pass: decodeURIComponent(u.password) || null };
  }
  const parts = link.split(':');
  const port = Number(parts[1]);
  if ((parts.length === 2 || parts.length === 4) && port > 0 && port < 65536) return { id, type: 'socks5', host: parts[0], port, user: parts[2] ?? null, pass: parts[3] ?? null };
  throw new WebError('bad_request', 'Не удалось распознать прокси. Примеры: socks5://user:pass@1.2.3.4:1080, http://1.2.3.4:8080, 1.2.3.4:1080');
}

/* ───────── AI ───────── */

interface StoredAi {
  baseUrl: string;
  model: string;
  key: string;
  enabled: boolean;
}
const ai = () => store.json<StoredAi>('ai', { baseUrl: 'https://api.openai.com/v1', model: '', key: '', enabled: false });
const aiDto = (): AiConfig => {
  const a = ai();
  return { baseUrl: a.baseUrl, model: a.model, enabled: a.enabled, hasKey: !!a.key, server: !!account.token && !!account.user?.ai?.enabled };
};

/* ───────── artwork colours ───────── */

function palette(src: string): Promise<{ blurUrl: string | null; color: string | null }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 48;
        const ctx = c.getContext('2d')!;
        ctx.filter = 'blur(4px) saturate(1.3)';
        ctx.drawImage(img, -6, -6, 60, 60);
        const d = ctx.getImageData(0, 0, 48, 48).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 4;
        const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
        resolve({ blurUrl: c.toDataURL('image/jpeg', 0.8), color: `#${hex(r)}${hex(g)}${hex(b)}` });
      } catch {
        resolve({ blurUrl: src, color: null });
      }
    };
    img.onerror = () => resolve({ blurUrl: null, color: null });
    img.src = src.startsWith('http') ? url(`api/img?${q({ url: src })}`) : src;
  });
}

/* ───────── commands ───────── */

const NO_UPDATE: UpdateState = { currentVersion: '', currentCode: 0, status: 'uptodate', progress: 0, checkedAt: 0 };
let deepLink: string | null = new URLSearchParams(location.search).get('open');

const handlers: { [K in keyof Commands]?: (args: Commands[K][0]) => Commands[K][1] | Promise<Commands[K][1]> } = {
  hello: async () => {
    const c = await api<{ version: string }>('config').catch(() => ({ version: '1.0' }));
    return { appVersion: c.version, extractorVersion: 'yt-dlp', sdkInt: 0, online: navigator.onLine, insets: { top: 0, bottom: 0, left: 0, right: 0 } };
  },
  kvGet: ({ key }) => kv[key] ?? null,
  kvSet: ({ key, value }) => {
    if (value == null) delete kv[key];
    else kv[key] = value;
    store.set('kv', JSON.stringify(kv));
    if (!key.startsWith('backup.')) schedulePush();
  },
  kvKeys: ({ prefix }) => Object.keys(kv).filter((k) => k.startsWith(prefix)),
  haptic: () => undefined,
  share: async ({ text }) => {
    if (navigator.share) await navigator.share({ text }).catch(() => undefined);
    else await navigator.clipboard?.writeText(text);
  },
  openUrl: ({ text }) => {
    if (DESKTOP) return api('open', { url: text });
    window.open(text, '_blank', 'noopener');
  },
  moveToBack: () => undefined,
  appIconGet: () => kv['appIcon'] ?? '10',
  appIconSet: () => undefined,
  consumeDeepLink: () => {
    const l = deepLink;
    deepLink = null;
    if (l) history.replaceState(null, '', location.pathname);
    return l;
  },
  setSystemBars: () => undefined,
  pickTextFile: async ({ mime }) => {
    const [f] = await pickFiles(mime || '*/*');
    return f ? { name: f.name, text: await f.text() } : null;
  },
  saveTextFile: ({ name, text, mime }) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    return true;
  },

  play: async ({ queue: list, index: i, positionMs }) => {
    queue = list;
    pendingRestore = null;
    emitQueue();
    await load(i, positionMs ?? 0);
  },
  pause: () => {
    wantPlay = false;
    audio.pause();
    emitState();
    savePlayer();
  },
  resume: async () => {
    if (pendingRestore != null || !audio.src || ended) {
      const pos = ended ? 0 : (pendingRestore ?? 0);
      pendingRestore = null;
      if (index >= 0) return load(index, pos);
    }
    wantPlay = true;
    ended = false;
    emitState();
    await audio.play().catch(() => undefined);
  },
  seek: ({ positionMs }) => {
    if (pendingRestore != null) pendingRestore = positionMs;
    else audio.currentTime = positionMs / 1000;
    lastTime = positionMs / 1000;
    emitProgress();
  },
  next: () => {
    if (index < queue.length - 1) return load(index + 1, 0, true);
    if (repeat === 'all' && queue.length) return load(0);
  },
  previous: () => {
    if (audio.currentTime > 3 || index <= 0) {
      audio.currentTime = 0;
      emitProgress();
      return;
    }
    return load(index - 1);
  },
  skipTo: ({ index: i }) => load(i),
  queueAdd: ({ tracks, next }) => {
    if (!queue.length) {
      queue = tracks;
      emitQueue();
      return load(0);
    }
    queue = next ? [...queue.slice(0, index + 1), ...tracks, ...queue.slice(index + 1)] : [...queue, ...tracks];
    emitQueue();
  },
  queueReplaceUpcoming: ({ tracks }) => {
    queue = [...queue.slice(0, index + 1), ...tracks];
    emitQueue();
  },
  queueRemove: ({ index: i }) => {
    queue = queue.filter((_, j) => j !== i);
    if (i < index) index--;
    emitQueue();
    if (i === index) return load(Math.min(index, queue.length - 1), 0, wantPlay);
  },
  queueMove: ({ from, to }) => {
    const playing = queue[index];
    const list = [...queue];
    list.splice(to, 0, list.splice(from, 1)[0]);
    queue = list;
    index = queue.indexOf(playing);
    emitQueue();
  },
  queueClear: () => {
    queue = [];
    pendingRestore = null;
    emitQueue();
    return load(-1, 0, false);
  },
  setRepeat: ({ mode }) => {
    repeat = mode;
    emitState();
    savePlayer();
  },
  setShuffle: ({ enabled }) => {
    shuffleOn = enabled;
    if (enabled) {
      const rest = queue.slice(index + 1);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      queue = [...queue.slice(0, index + 1), ...rest];
      emitQueue();
    }
    emitState();
  },
  setVolume: ({ volume }) => {
    audio.volume = Math.min(1, Math.max(0, volume));
  },
  getPlayerState: () => ({ queue, index, playing: wantPlay, buffering: buffering(), positionMs: pendingRestore ?? Math.round(audio.currentTime * 1000), durationMs: durationMs(), repeat, shuffle: shuffleOn }),
  trackInfo: async ({ track }) => {
    if (track.source === 'local') {
      const blob = await getFile(track.id);
      return { source: 'local', container: blob?.type.replace(/^audio\//, '').toUpperCase() || null, sizeBytes: blob?.size ?? null };
    }
    return api('trackinfo?' + q({ id: track.id }));
  },

  search: ({ query, filter, page }) => api('search?' + q({ q: query, filter, page })),
  searchSuggestions: ({ query }) => api('suggest?' + q({ q: query })),
  trackDetails: ({ id }) => api('track?' + q({ id })),
  trackRadio: ({ id }) => api('radio?' + q({ id })),
  getCollection: ({ url: u }) => api('collection?' + q({ url: u })),
  getArtist: ({ url: u }) => api('artist?' + q({ url: u })),
  lyrics: (a) => api('lyrics', a),
  translate: (a) => api('translate', a),
  artworkPalette: ({ url: u }) => palette(u),
  importFetch: ({ url: u }) => api<ImportedList>('import?' + q({ url: u })),
  chart: ({ source }) => api('chart?' + q({ source })),
  trackFeatures: (a) => api('features', a),

  getLibrary: async () => ({
    likes: lib.likes.map((l): Like | null => (lib.tracks[l.trackId] ? { track: lib.tracks[l.trackId], likedAt: l.likedAt } : null)).filter((l): l is Like => !!l),
    playlists: [...lib.playlists].sort((a, b) => b.updatedAt - a.updatedAt).map(playlistDto),
    downloads: DESKTOP ? await api<Download[]>('downloads').catch(() => []) : [],
    local: lib.local.map((id) => lib.tracks[id]).filter(Boolean),
  }),
  like: ({ track, liked }) => {
    lib.likes = lib.likes.filter((l) => l.trackId !== track.id);
    if (liked) {
      remember(track);
      lib.likes.unshift({ trackId: track.id, likedAt: Date.now() });
    }
    saveSoon('likes');
  },
  playlistCreate: ({ name, tracks = [] }) => {
    tracks.forEach(remember);
    const now = Date.now();
    const p: StoredPlaylist = { id: now, name, trackIds: [...new Set(tracks.map((t) => t.id))], createdAt: now, updatedAt: now };
    lib.playlists.push(p);
    saveSoon('playlists');
    return playlistDto(p);
  },
  playlistRename: ({ id, name }) => {
    Object.assign(findPlaylist(id), { name, updatedAt: Date.now() });
    saveSoon('playlists');
  },
  playlistDelete: ({ id }) => {
    lib.playlists = lib.playlists.filter((p) => p.id !== id);
    saveSoon('playlists');
  },
  playlistGet: ({ id }) => {
    const p = findPlaylist(id);
    return { playlist: playlistDto(p), tracks: p.trackIds.map((t) => lib.tracks[t]).filter(Boolean) };
  },
  playlistAdd: ({ id, tracks }) => {
    const p = findPlaylist(id);
    tracks.forEach(remember);
    p.trackIds = [...new Set([...p.trackIds, ...tracks.map((t) => t.id)])];
    p.updatedAt = Date.now();
    saveSoon('playlists');
  },
  playlistRemove: ({ id, index: i }) => {
    const p = findPlaylist(id);
    p.trackIds.splice(i, 1);
    p.updatedAt = Date.now();
    saveSoon('playlists');
  },
  playlistMove: ({ id, from, to }) => {
    const p = findPlaylist(id);
    p.trackIds.splice(to, 0, p.trackIds.splice(from, 1)[0]);
    p.updatedAt = Date.now();
    saveSoon('playlists');
  },
  history: ({ limit }) =>
    lib.history
      .slice(0, limit)
      .map((x): HistoryEntry | null => (lib.tracks[x.trackId] ? { ...x, track: lib.tracks[x.trackId] } : null))
      .filter((x): x is HistoryEntry => !!x),
  historyClear: () => {
    lib.history = [];
    saveSoon('history');
  },
  libraryExport: () => exportBackup(false),
  libraryImport: ({ json }) => importBackup(json, true),
  backupExport: () => exportBackup(),
  backupImport: ({ json }) => importBackup(json),
  backupStatus: () => ({ folder: null, savedAt: 0 }),
  backupSetFolder: () => {
    throw new WebError('unavailable', 'Автокопия в папку есть только в приложении для Android. Войдите в аккаунт — библиотека будет храниться в облаке.');
  },
  backupRestoreFolder: () => 0,
  backupNow: () => false,

  download: ({ tracks, quality }) => api('download', { tracks, quality }),
  downloadRemove: ({ id }) => api('download-remove', { id }),
  downloads: () => (DESKTOP ? api<Download[]>('downloads') : []),
  storageInfo: () => api('storage'),
  clearCache: () => undefined,
  localImport: async ({ mode }) => {
    const files = (await pickFiles('audio/*', mode === 'folder')).filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|ogg|opus|flac|wav|webm|aac)$/i.test(f.name));
    const out: Track[] = [];
    for (const f of files) out.push(await addLocal(`local:${hash(`${f.name}:${f.size}`)}`, f, nameToTrack(f.name)));
    if (out.length) saveSoon('local');
    return out;
  },
  localRemove: async ({ id }) => {
    await deleteFile(id).catch(() => undefined);
    lib.local = lib.local.filter((x) => x !== id);
    saveSoon('local');
  },

  proxyState: () => proxyState(),
  proxyAdd: async ({ link }) => {
    if (!DESKTOP) throw new WebError('unavailable', 'Прокси настраивается в приложении для компьютера или телефона');
    const p = parseProxy(link);
    const s = proxies();
    await applyProxy({ list: [...s.list, p], activeId: s.activeId ?? p.id, enabled: s.enabled || !s.activeId });
    return p;
  },
  proxyRemove: ({ id }) => {
    const s = proxies();
    return applyProxy({ list: s.list.filter((p) => p.id !== id), activeId: s.activeId === id ? null : s.activeId, enabled: s.activeId === id ? false : s.enabled });
  },
  proxySelect: ({ id }) => applyProxy({ activeId: id, enabled: true }),
  proxySetEnabled: ({ enabled }) => applyProxy({ enabled }),
  proxyPing: async ({ id }) => {
    const p = allProxies().find((x) => x.id === id);
    if (!p) throw new WebError('not_found', 'Прокси не найден');
    const ms = await api<number>('ping', { url: proxyUrl(p) }).catch(() => -1);
    const s = proxies();
    store.set('proxies', JSON.stringify({ ...s, list: s.list.map((x) => (x.id === id ? { ...x, pingMs: ms } : x)) }));
    emit('proxyChanged', proxyState());
    return ms;
  },
  proxyShareLink: ({ id }) => {
    const p = allProxies().find((x) => x.id === id);
    if (!p) throw new WebError('not_found', 'Прокси не найден');
    return `youmusic://${p.type === 'http' ? 'http' : 'socks'}?${q({ server: p.host, port: String(p.port), user: p.user, pass: p.pass })}`;
  },

  updateState: () => NO_UPDATE,
  updateCheck: () => NO_UPDATE,
  updateDownload: () => NO_UPDATE,
  updateInstall: () => undefined,
  updateSchedule: () => undefined,

  aiConfig: () => aiDto(),
  aiConfigure: ({ baseUrl, model, key, enabled }) => {
    const a = ai();
    store.set('ai', JSON.stringify({ baseUrl: baseUrl?.trim().replace(/\/+$/, '') ?? a.baseUrl, model: model?.trim() ?? a.model, key: key ?? a.key, enabled: enabled ?? a.enabled }));
    return aiDto();
  },
  aiChat: async ({ messages, temperature, tier }) => {
    const a = ai();
    if (a.enabled && a.key && a.model) {
      // Own model: called straight from the browser, the key never leaves this device.
      let r: Response;
      try {
        r = await fetch(`${a.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.key}` },
          body: JSON.stringify({ model: a.model, messages, temperature: temperature ?? 0.9 }),
        });
      } catch {
        throw new WebError('ai_error', 'Нейросеть недоступна из браузера (адрес не отвечает или не разрешает такие запросы)');
      }
      const json = await r.json().catch(() => null);
      const content = json?.choices?.[0]?.message?.content;
      if (!r.ok || typeof content !== 'string') throw new WebError('ai_error', json?.error?.message ?? `Нейросеть ответила ${r.status}`);
      return content;
    }
    if (!account.token) throw new WebError('ai_off', 'Подключите свою нейросеть или войдите в аккаунт');
    const res = await srv<{ content: string; left: number }>('/api/ai/chat', 'POST', { messages, temperature: temperature ?? 0.9, tier: tier ?? 'fast' });
    const u = account.user;
    if (u?.ai) account.user = { ...u, ai: { ...u.ai, left: res.left } };
    emitServer();
    return res.content;
  },

  tgLink: () => srv('/api/tg/link', 'POST', {}),
  tgTracks: async () => {
    if (!account.token) throw new WebError('unauthorized', 'Войдите в аккаунт, чтобы переносить музыку из Telegram');
    const list = await srv<TgList>('/api/tg/tracks');
    return { ...list, tracks: list.tracks.map((t) => ({ ...t, cover: t.cover?.startsWith('/') ? `https://grzxk.ru/youmusic${t.cover}` : t.cover })) };
  },
  tgImport: async ({ track, artwork }: { track: TgTrack; artwork?: string | null }) => {
    const r = await fetch(url(`server/api/tg/file/${track.id}`), { headers: { Authorization: `Bearer ${account.token ?? ''}` } }).catch(() => null);
    if (!r?.ok) throw new WebError('server', 'Сервер не отдал файл');
    const t = await addLocal(`local:tg-${track.id}`, await r.blob(), { title: track.title, artist: track.artist, durationMs: track.durationMs, artwork: artwork ?? track.cover });
    saveSoon('local');
    return t;
  },
  tgDelete: ({ id }) => srv(`/api/tg/tracks/${id}`, 'DELETE').then(() => undefined),

  serverStatus: () => {
    void refreshUser();
    return serverStatus();
  },
  serverAuth: async ({ login, password, register }) => {
    const res = await srv<{ token: string; user: ServerUser }>(register ? '/api/register' : '/api/login', 'POST', { login: login.trim(), password }, false);
    account.token = res.token;
    account.user = res.user;
    store.set('server.syncedAt', '0');
    store.set('server.remoteAt', '0');
    await sync();
    return serverStatus();
  },
  serverLogout: async () => {
    await srv('/api/logout', 'POST', {}).catch(() => undefined);
    if (proxies().activeId === 'server') await applyProxy({ enabled: false }).catch(() => undefined);
    logoutLocal();
    return serverStatus();
  },
  serverSync: async () => {
    await sync();
    return serverStatus();
  },
  serverProxy: async ({ on }) => {
    if (on && !account.user?.proxy) throw new WebError('bad_request', 'Войдите в аккаунт, чтобы включить бесплатный прокси');
    if (on) await applyProxy({ activeId: 'server', enabled: true });
    else if (proxies().activeId === 'server') await applyProxy({ enabled: false });
    return serverStatus();
  },

  modsList: () => [],
  modStage: () => {
    throw new WebError('unavailable', 'Моды пока доступны только в приложении для Android');
  },
  modInstall: () => {
    throw new WebError('unavailable', 'Моды пока доступны только в приложении для Android');
  },
  modRemove: () => undefined,
};

export function createWebTransport(): Transport {
  let listener: (text: string) => void = () => undefined;
  emit = (name, data) => queueMicrotask(() => listener(JSON.stringify({ type: 'event', name, data })));
  restore();
  const net = () => emit('network', { online: navigator.onLine, unmetered: true, vpn: false });
  window.addEventListener('online', () => {
    net();
    void sync();
  });
  window.addEventListener('offline', net);
  if (account.token) setTimeout(() => void sync(), 1500);
  // Desktop downloads report progress through long polling.
  if (DESKTOP) {
    let after = 0;
    const poll = async (): Promise<void> => {
      try {
        const r = await api<{ events: { seq: number; name: string; data: unknown }[]; last: number }>(`events?after=${after}`);
        for (const e of r.events) emit(e.name, e.data);
        after = r.last;
      } catch {
        await new Promise((res) => setTimeout(res, 3000));
      }
      void poll();
    };
    void poll();
  }
  return {
    listen: (cb) => {
      listener = cb;
    },
    send: (text) => {
      const { id, cmd, args } = JSON.parse(text);
      const handler = handlers[cmd as keyof Commands] as ((a: unknown) => unknown) | undefined;
      Promise.resolve()
        .then(() => {
          if (!handler) throw new WebError('unavailable', 'Недоступно в этой версии');
          return handler(args);
        })
        .then(
          (result) => listener(JSON.stringify({ type: 'res', id, ok: true, result: result ?? null })),
          (e: WebError) => listener(JSON.stringify({ type: 'res', id, ok: false, error: { code: e.code ?? 'internal', message: e.message } })),
        );
    },
  };
}
