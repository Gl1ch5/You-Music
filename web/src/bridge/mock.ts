import type { Transport } from './bridge';
import type { Commands, Download, HistoryEntry, InstalledMod, Like, Playlist, Proxy, ServerStatus, Track, UpdateState } from './contract';

/**
 * In-memory stand-in for the Android layer, used by `npm run dev` in a desktop browser and by the screenshot
 * script. It implements the same contract with fake data and a simulated player clock. Never used in the app.
 */

const PALETTES = [
  ['#C2410C', '#FDBA74'], ['#1D4ED8', '#93C5FD'], ['#7C3AED', '#F0ABFC'], ['#0F766E', '#5EEAD4'],
  ['#B91C1C', '#FCA5A5'], ['#A16207', '#FDE68A'], ['#334155', '#CBD5E1'], ['#BE185D', '#FBCFE8'],
  ['#065F46', '#A7F3D0'], ['#9A3412', '#FED7AA'], ['#4338CA', '#C7D2FE'], ['#0E7490', '#A5F3FC'],
];

function coverSvg(seed: number): string {
  const [a, b] = PALETTES[seed % PALETTES.length];
  const r = 30 + ((seed * 37) % 50);
  const x = 20 + ((seed * 53) % 60);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="${x}" cy="${100 - x / 2}" r="${r}" fill="${b}" opacity="0.55"/><rect x="${seed % 40}" y="${(seed * 7) % 50}" width="40" height="40" rx="${seed % 20}" fill="${a}" opacity="0.5" transform="rotate(${seed * 17} 50 50)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const RAW: [string, string, number][] = [
  ['Raya (Slowed)', 'Zericxxn', 162], ['Fall From The Sky', 'RomancePlanet, STAKILLA', 184], ['Love Me Not', 'NovaX, Sevven', 201],
  ['Hummin\' To Myself', 'PiSk', 176], ['Вальс цветов', 'Большой симфонический оркестр', 412], ['Cadillac', 'MORGENSHTERN, Элджей', 187],
  ['Boom, Boom, Boom, Boom!!', 'Mckyyy', 149], ['Toscana', 'Alessandra', 172], ['Rasputin', 'Boney M.', 268],
  ['Trust Me (Extended Club)', 'Marnik', 245], ['Fuera del planeta', 'Jiandro, Wbenix', 217], ['Matador', 'Buttertones', 203],
  ['Midnight Drive', 'Lumen Fields', 231], ['Paper Planes', 'Hollow Coast', 199], ['Северный ветер', 'Город 312', 224],
  ['Glass Garden', 'Mira Vale', 188], ['Low Tide', 'The Quiet Hours', 254], ['Neon Rain', 'Kaito Sun', 176],
  ['Белые ночи', 'Сплин', 238], ['Velvet', 'Ana Lune', 207], ['Afterglow', 'North Arcade', 219], ['Copper Sky', 'Delta Kid', 196],
];

const tracks: Track[] = RAW.map(([title, artist, sec], i) => ({
  id: `yt:mock${i}`,
  source: 'yt',
  title,
  artist,
  durationMs: sec * 1000,
  artwork: coverSvg(i + 1),
  url: `https://www.youtube.com/watch?v=mock${i}`,
  artistUrl: `https://www.youtube.com/channel/mock-${artist}`,
  official: i % 3 === 0,
}));

const now = Date.now();
let likes: Like[] = tracks.slice(0, 12).map((track, i) => ({ track, likedAt: now - i * 86_400_000 }));
const history: HistoryEntry[] = tracks.slice(4, 18).map((track, i) => ({
  track,
  playedAt: now - i * 3_600_000,
  listenedMs: track.durationMs,
  durationMs: track.durationMs,
  completed: i % 4 !== 1,
  skipped: i % 4 === 1,
}));
let playlists: Playlist[] = [
  { id: 1, name: 'Отборные биточки', count: 6, artwork: tracks[6].artwork, updatedAt: now },
  { id: 2, name: 'Классика', count: 3, artwork: tracks[4].artwork, updatedAt: now - 1e6 },
  { id: 3, name: 'В дорогу', count: 8, artwork: tracks[12].artwork, updatedAt: now - 2e6 },
];
const playlistTracks = new Map<number, Track[]>([[1, tracks.slice(5, 11)], [2, tracks.slice(3, 6)], [3, tracks.slice(10, 18)]]);
const downloads = new Map<string, Download>(tracks.slice(0, 7).map((t) => [t.id, { trackId: t.id, track: t, status: 'done', progress: 1, bytes: 4_200_000, quality: 'high', localArt: null }]));
const kv = new Map<string, string>();
const mockProxies: Proxy[] = [{ id: 'p1', type: 'socks5', host: '203.0.113.7', port: 1080, user: 'demo', pingMs: 81 }];
const mockUpdate: UpdateState = {
  currentVersion: '1.0.0-dev',
  currentCode: 1,
  latest: { versionCode: 2, versionName: '1.0.42-nightly', channel: 'nightly', apk: '', notes: 'Плавные переходы, прокси, нейро-рекомендации' },
  status: 'ready',
  progress: 1,
  checkedAt: Date.now(),
};

/* Simulated player */
let mockServer: ServerStatus = { signedIn: false, syncedAt: 0, syncing: false, ai: { enabled: true, limit: 50, left: 50 }, proxyAvailable: true, proxyOn: false };
let queue: Track[] = [];
let index = -1;
let playing = false;
let position = 0;
let lastTick = 0;
let repeat: 'off' | 'all' | 'one' = 'off';
let shuffle = false;

type Emit = (name: string, data: unknown) => void;
let emit: Emit = () => undefined;

function state() {
  emit('stateChanged', { playing, playWhenReady: playing, buffering: false, repeat, shuffle, ended: false });
}
function progress() {
  emit('progress', { positionMs: position, durationMs: queue[index]?.durationMs ?? 0, bufferedMs: position });
}
function changed() {
  position = 0;
  emit('trackChanged', { track: queue[index] ?? null, index });
  progress();
}
setInterval(() => {
  if (!playing) return;
  const t = performance.now();
  position += t - lastTick;
  lastTick = t;
  if (position >= (queue[index]?.durationMs ?? Infinity)) {
    if (index < queue.length - 1) {
      index++;
      changed();
    } else {
      playing = false;
      state();
    }
  }
  progress();
}, 500);

let mockIcon = '10';

const handlers: { [K in keyof Commands]?: (args: Commands[K][0]) => Commands[K][1] | Promise<Commands[K][1]> } = {
  hello: () => ({ appVersion: '1.0.0-dev', extractorVersion: 'mock', sdkInt: 36, online: true, insets: { top: 24, bottom: 16, left: 0, right: 0 } }),
  // Screenshots skip the first-launch setup unless the page is opened with ?onboarding.
  kvGet: ({ key }) => kv.get(key) ?? (key === 'onboarding.done' && !location.search.includes('onboarding') ? '1' : null),
  kvSet: ({ key, value }) => void (value == null ? kv.delete(key) : kv.set(key, value)),
  kvKeys: ({ prefix }) => [...kv.keys()].filter((k) => k.startsWith(prefix)),
  haptic: () => undefined,
  share: () => undefined,
  openUrl: ({ text }) => void window.open(text, '_blank'),
  moveToBack: () => undefined,
  appIconGet: () => mockIcon,
  appIconSet: ({ id }) => {
    mockIcon = id;
  },
  setSystemBars: () => undefined,
  pickTextFile: () => null,
  saveTextFile: () => false,

  play: ({ queue: q, index: i }) => {
    queue = q;
    index = i;
    playing = true;
    lastTick = performance.now();
    emit('queueChanged', { queue, index });
    changed();
    state();
  },
  pause: () => {
    playing = false;
    state();
  },
  resume: () => {
    playing = true;
    lastTick = performance.now();
    state();
  },
  seek: ({ positionMs }) => {
    position = positionMs;
    progress();
  },
  next: () => {
    if (index < queue.length - 1) {
      index++;
      changed();
    }
  },
  previous: () => {
    if (position > 3000 || index === 0) position = 0;
    else index--;
    changed();
  },
  skipTo: ({ index: i }) => {
    index = i;
    changed();
  },
  queueAdd: ({ tracks: t, next }) => {
    queue = next ? [...queue.slice(0, index + 1), ...t, ...queue.slice(index + 1)] : [...queue, ...t];
    emit('queueChanged', { queue, index });
  },
  queueReplaceUpcoming: ({ tracks: t }) => {
    queue = [...queue.slice(0, index + 1), ...t];
    emit('queueChanged', { queue, index });
  },
  queueRemove: ({ index: i }) => {
    queue = queue.filter((_, j) => j !== i);
    if (i < index) index--;
    emit('queueChanged', { queue, index });
  },
  queueMove: ({ from, to }) => {
    const q = [...queue];
    q.splice(to, 0, q.splice(from, 1)[0]);
    queue = q;
    emit('queueChanged', { queue, index });
  },
  queueClear: () => {
    queue = [];
    index = -1;
    emit('queueChanged', { queue, index });
  },
  setRepeat: ({ mode }) => {
    repeat = mode;
    state();
  },
  setShuffle: ({ enabled }) => {
    shuffle = enabled;
    state();
  },
  trackInfo: ({ track }) => ({ source: downloads.has(track.id) ? 'download' : 'stream', container: 'webm', codec: 'Opus', bitrateKbps: 160, sampleRateHz: 48000, channels: 2, sizeBytes: Math.round((track.durationMs / 1000) * 20_000) }),
  getPlayerState: () => ({ queue, index, playing, buffering: false, positionMs: position, durationMs: queue[index]?.durationMs ?? 0, repeat, shuffle }),

  search: ({ query, filter }) => {
    const q = query.toLowerCase();
    const found = tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q));
    const list = found.length ? found : tracks.slice(8, 20);
    if (filter === 'artists') return { items: list.slice(0, 5).map((t) => ({ kind: 'artist' as const, artist: { id: t.artist, name: t.artist, artwork: t.artwork, url: t.artistUrl!, subscribers: 120000 } })) };
    if (filter === 'albums' || filter === 'playlists')
      return { items: list.slice(0, 6).map((t, i) => ({ kind: filter === 'albums' ? ('album' as const) : ('playlist' as const), collection: { kind: filter === 'albums' ? ('album' as const) : ('playlist' as const), id: `c${i}`, title: `${t.title} — EP`, subtitle: t.artist, artwork: t.artwork, url: `mock://collection/${i}`, count: 6 } })) };
    return {
      items: [
        ...(filter === 'all' ? [{ kind: 'artist' as const, artist: { id: list[0].artist, name: list[0].artist, artwork: list[0].artwork, url: list[0].artistUrl!, subscribers: 54000 } }] : []),
        ...list.map((track) => ({ kind: 'track' as const, track })),
      ],
    };
  },
  searchSuggestions: ({ query }) => [query, `${query} slowed`, `${query} remix`, `${query} live`].slice(0, 4),
  trackDetails: ({ id }) => {
    const i = tracks.findIndex((t) => t.id === id);
    return { track: tracks[i] ?? tracks[0], related: [...tracks.slice(i + 1), ...tracks.slice(0, i)].slice(0, 12) };
  },
  getCollection: ({ url }) => ({ collection: { kind: 'album', id: url, title: 'Northern Lights', subtitle: 'Lumen Fields', artwork: tracks[12].artwork, url, count: 8 }, tracks: tracks.slice(12, 20) }),
  getArtist: ({ url }) => {
    const t = tracks.find((x) => x.artistUrl === url) ?? tracks[0];
    return {
      artist: { id: url, name: t.artist, artwork: t.artwork, url, subscribers: 1_250_000 },
      tracks: tracks.slice(0, 14),
      albums: tracks.slice(2, 7).map((x, i) => ({ kind: 'album' as const, id: `a${i}`, title: `${x.title}`, subtitle: '2025', artwork: x.artwork, url: `mock://album/${i}`, count: 10 })),
    };
  },
  lyrics: () => ({ synced: Array.from({ length: 24 }, (_, i) => `[00:${String(i * 4).padStart(2, '0')}.00] ${['Ночной город дышит светом', 'Мы едем вдоль пустых витрин', 'И музыка звучит как ветер', 'Который знает, что ты один'][i % 4]}`).join('\n') }),
  translate: ({ lines }) => ({ lines: lines.map((l) => (l ? `${l} (перевод)` : '')), from: 'en' }),
  chart: () => ({ title: 'Чарт Яндекс Музыки', source: 'yandex', tracks: tracks.slice(0, 12).map((t) => ({ title: t.title, artist: t.artist, durationMs: t.durationMs, artwork: t.artwork })) }),
  importFetch: () => ({
    title: 'Мой плейлист из Spotify',
    source: 'spotify',
    tracks: tracks.slice(8, 14).map((t) => ({ title: t.title, artist: t.artist, durationMs: t.durationMs })),
  }),
  trackFeatures: ({ tracks: list }) =>
    Object.fromEntries(
      list.map((t, i) => [t.id, { found: true, bpm: 80 + ((t.title.length * 13 + i * 7) % 90), gainDb: -4 - ((t.artist.length * 3) % 10), genres: [['Pop', 'Rap/Hip Hop', 'Rock', 'Electro', 'Metal'][t.title.length % 5]], explicit: t.title.length % 3 === 0, year: 2000 + ((t.title.length * 7) % 26), rank: 100_000 * ((t.artist.length * 11) % 10) }]),
    ),
  artworkPalette: ({ url }) => {
    const i = tracks.findIndex((t) => t.artwork === url);
    return { blurUrl: url, color: PALETTES[(i + 1) % PALETTES.length][0] };
  },

  getLibrary: () => ({ likes, playlists, downloads: [...downloads.values()], local: [] }),
  like: ({ track, liked }) => {
    likes = liked ? [{ track, likedAt: Date.now() }, ...likes.filter((l) => l.track.id !== track.id)] : likes.filter((l) => l.track.id !== track.id);
  },
  playlistCreate: ({ name, tracks: t = [] }) => {
    const p = { id: Date.now(), name, count: t.length, artwork: t[0]?.artwork, updatedAt: Date.now() };
    playlists = [p, ...playlists];
    playlistTracks.set(p.id, t);
    emit('libraryChanged', { what: 'playlists' });
    return p;
  },
  playlistRename: ({ id, name }) => {
    playlists = playlists.map((p) => (p.id === id ? { ...p, name } : p));
    emit('libraryChanged', { what: 'playlists' });
  },
  playlistDelete: ({ id }) => {
    playlists = playlists.filter((p) => p.id !== id);
    emit('libraryChanged', { what: 'playlists' });
  },
  playlistGet: ({ id }) => ({ playlist: playlists.find((p) => p.id === id)!, tracks: playlistTracks.get(id) ?? [] }),
  playlistAdd: ({ id, tracks: t }) => void playlistTracks.set(id, [...(playlistTracks.get(id) ?? []), ...t]),
  playlistRemove: ({ id, index: i }) => void playlistTracks.set(id, (playlistTracks.get(id) ?? []).filter((_, j) => j !== i)),
  playlistMove: () => undefined,
  history: ({ limit }) => history.slice(0, limit),
  historyClear: () => void history.splice(0),
  libraryExport: () => JSON.stringify({ format: 'you-music-library', likes }),
  libraryImport: () => 0,
  backupExport: () => JSON.stringify({ format: 'you-music-library', version: 2, likes }),
  backupImport: () => 0,
  backupStatus: () => ({ folder: null, savedAt: 0 }),
  backupSetFolder: ({ enabled }) => ({ status: { folder: enabled ? 'Documents' : null, savedAt: enabled ? Date.now() : 0 } }),
  backupRestoreFolder: () => 0,
  backupNow: () => true,

  download: ({ tracks: t }) => {
    for (const track of t) {
      const d: Download = { trackId: track.id, track, status: 'running', progress: 0, bytes: 0, quality: 'high' };
      downloads.set(track.id, d);
      let p = 0;
      const timer = setInterval(() => {
        p = Math.min(1, p + 0.2);
        const next = { ...d, progress: p, status: p >= 1 ? ('done' as const) : ('running' as const), bytes: Math.round(p * 4e6) };
        downloads.set(track.id, next);
        emit('downloadProgress', next);
        if (p >= 1) clearInterval(timer);
      }, 400);
    }
  },
  downloadRemove: ({ id }) => {
    downloads.delete(id);
    emit('downloadProgress', { trackId: id, status: 'removed', progress: 0, bytes: 0, quality: '' });
  },
  downloads: () => [...downloads.values()],
  storageInfo: () => ({ downloadsBytes: 29_400_000, cacheBytes: 118_000_000, freeBytes: 21_000_000_000, cacheLimitBytes: 512 << 20 }),
  clearCache: () => undefined,
  localImport: () => [],
  localRemove: () => undefined,

  // Tests can inject installed mods (see scripts/mods-check.mjs).
  consumeDeepLink: () => null,
  proxyState: () => ({ proxies: mockProxies, activeId: mockProxies[0]?.id ?? null, enabled: true, vpnActive: false, inUse: true }),
  proxyAdd: ({ link }) => {
    const p = { id: String(Date.now()), type: 'socks5' as const, host: link.replace(/^.*@|:\d+$/g, ''), port: 1080, pingMs: null };
    mockProxies.push(p);
    return p;
  },
  proxyRemove: ({ id }) => void mockProxies.splice(mockProxies.findIndex((p) => p.id === id), 1),
  proxySelect: () => undefined,
  proxySetEnabled: () => undefined,
  proxyPing: ({ id }) => {
    const p = mockProxies.find((x) => x.id === id);
    if (p) p.pingMs = 42;
    return 42;
  },
  proxyShareLink: ({ id }) => `youmusic://socks?server=${mockProxies.find((p) => p.id === id)?.host}&port=1080`,
  updateState: () => mockUpdate,
  updateCheck: () => mockUpdate,
  updateDownload: () => mockUpdate,
  updateInstall: () => undefined,
  updateSchedule: () => undefined,
  serverStatus: () => mockServer,
  serverAuth: ({ login }) => (mockServer = { ...mockServer, signedIn: true, login, syncedAt: Date.now() }),
  serverLogout: () => (mockServer = { ...mockServer, signedIn: false, login: null, proxyOn: false }),
  serverSync: () => (mockServer = { ...mockServer, syncedAt: Date.now() }),
  serverProxy: ({ on }) => (mockServer = { ...mockServer, proxyOn: on }),
  tgLink: () => ({ code: 'demo', url: 'https://t.me/Youmusikks_bot?start=demo', linked: false }),
  tgTracks: () => ({
    linked: true,
    bot: 'Youmusikks_bot',
    tracks: [
      { id: 'tg-demo-1', title: 'Night Drive', artist: 'Demo Artist', durationMs: 201_000, size: 4_800_000, mime: 'audio/mpeg', cover: null, at: Date.now() },
      { id: 'tg-demo-2', title: 'Редкая запись', artist: 'Неизвестный', durationMs: 185_000, size: 4_100_000, mime: 'audio/mpeg', cover: null, at: Date.now() },
    ],
  }),
  tgImport: ({ track }) => ({ id: `local:tg-${track.id}`, source: 'local', title: track.title, artist: track.artist, durationMs: track.durationMs }),
  tgDelete: () => undefined,
  aiConfig: () => ({ baseUrl: 'https://api.example.com/v1', model: 'demo-model', enabled: true, hasKey: true }),
  aiConfigure: () => ({ baseUrl: 'https://api.example.com/v1', model: 'demo-model', enabled: true, hasKey: true }),
  aiChat: () => JSON.stringify(tracks.slice(14, 20).map((t) => ({ artist: t.artist, title: t.title, reason: 'похоже на ваши лайки' }))),
  modsList: () => (window as unknown as { __mockMods?: InstalledMod[] }).__mockMods ?? [],
  modStage: () => null,
  modInstall: () => {
    throw new Error('Моды доступны только в приложении');
  },
  modRemove: () => undefined,
};

export function createMockTransport(): Transport {
  let listener: (text: string) => void = () => undefined;
  emit = (name, data) => setTimeout(() => listener(JSON.stringify({ type: 'event', name, data })), 0);
  return {
    listen: (cb) => {
      listener = cb;
    },
    send: (text) => {
      const { id, cmd, args } = JSON.parse(text);
      const handler = handlers[cmd as keyof Commands] as ((a: unknown) => unknown) | undefined;
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error(`mock: ${cmd} not implemented`);
          return handler(args);
        })
        .then(
          (result) => setTimeout(() => listener(JSON.stringify({ type: 'res', id, ok: true, result: result ?? null })), 30),
          (e: Error) => setTimeout(() => listener(JSON.stringify({ type: 'res', id, ok: false, error: { code: 'internal', message: e.message } })), 30),
        );
    },
  };
}
