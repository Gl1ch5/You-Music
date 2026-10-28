import { call, onNative } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { app, currentTrack, isPlayable, livePosition, player, type PlayContext } from '../core/store';
import { Wave, type RecoSource } from '../logic/recommend';
import { hooks, runHooks } from '../mods/registry';
import { toast } from '../ui/toast';
import { describeFilters } from '../logic/filters';
import { songKey } from '../logic/normalize';
import { aiSuggest } from './ai';
import { dislikes } from './dislikes';
import { rememberWave, type SavedWave } from './waves';
import { related } from './catalog';
import { vibesOf } from './features';
import { uiBus } from './events';
import { busy } from '../core/busy';
import { preloadArt } from './art';

export const RELEASES_URL = 'https://github.com/Gl1ch5/You-Music/releases/latest';

/** Everything that starts or steers playback goes through here, so mods' queue hooks and the wave see it. */

export const recoSource: RecoSource = {
  signals: async () => ({
    likes: app.likes.peek(),
    history: await call('history', { limit: 400 }).catch(() => []),
    now: Date.now(),
    dislikes: dislikes.peek(),
  }),
  related,
  vibes: vibesOf,
};

let wave: Wave | null = null;
/** What the running wave is, to save it for "Продолжить волну". */
let waveInfo: Omit<SavedWave, 'played' | 'at'> | null = null;

/**
 * Recommendations: related songs of the user's taste, scored by vibe, era and filters — plus, when a model is
 * available (own or the account's), its suggestions mixed in. Custom text filters can only be understood by the model,
 * so with them on the wave plays the model's picks only.
 */
export function createWave(opts: { seeds?: Track[]; seen?: Track[]; title?: string } = {}): Wave {
  const s = app.settings.peek();
  const ai = app.aiEnabled.peek();
  const custom = ai ? s.recoCustomActive : [];
  const wish = describeFilters(s.recoFilters, custom);
  const extra = ai
    ? async () => (await aiSuggest(recoSource, s.recoDepth === 'deep' ? 14 : 8, { mood: wish || undefined, tier: s.recoDepth, basis: opts.seeds, title: opts.title })).map((p) => p.track)
    : undefined;
  return new Wave({ ...recoSource, extra }, s.waveMode, Math.random, null, {
    filters: s.recoFilters,
    depth: s.recoDepth,
    seeds: opts.seeds,
    seen: opts.seen,
    extraOnly: custom.length > 0,
  });
}
let extending = false;

export async function playTracks(tracks: Track[], index: number, context: PlayContext): Promise<void> {
  const selected = tracks[index];
  let list = tracks.filter(isPlayable);
  if (!list.length) {
    toast('Нет сети, а эти треки не скачаны', { icon: 'offline' });
    return;
  }
  list = await runHooks(hooks.queue, list, { reason: context?.kind === 'wave' ? 'wave' : 'play' });
  const start = Math.max(0, list.findIndex((t) => t.id === selected?.id));
  if (context?.kind !== 'wave') {
    wave = null;
    waveInfo = null;
  }
  player.context.value = context;
  if (currentTrack.peek()?.id !== selected?.id) expectLoading();
  await call('play', { queue: list, index: start });
}

/** Shows the loading ring on the play buttons and the top bar until the wave's first tracks are queued. */
async function preparing(work: () => Promise<void>): Promise<void> {
  if (player.preparing.peek()) return;
  player.preparing.value = true;
  const before = player.wantsPlay.peek();
  player.wantsPlay.value = true;
  player.buffering.value = true;
  try {
    await work();
  } catch (e) {
    toast('Не удалось запустить поток', { icon: 'offline' });
    console.warn('wave start failed', e);
  } finally {
    player.preparing.value = false;
    // Nothing started (no tracks, error): give the buttons their state back.
    if (!player.playing.peek() && !currentTrack.peek()) {
      player.wantsPlay.value = before;
      player.buffering.value = false;
    }
  }
}

export function playWave(): Promise<void> {
  return preparing(startWave);
}

async function startWave(): Promise<void> {
  if (!app.online.peek()) {
    const offline = [...app.likes.peek().map((l) => l.track), ...app.local.peek()].filter(isPlayable);
    if (!offline.length) return toast('Без сети играет скачанное — пока его нет', { icon: 'offline' });
    wave = null;
    return playTracks(shuffle(offline), 0, { kind: 'wave', title: 'Рекомендации · офлайн' });
  }
  const current = createWave();
  let first = await current.next(8).catch(() => [] as Track[]);
  first = await runHooks(hooks.recommendations, first, { source: 'wave' });
  if (!first.length) {
    if (app.settings.peek().recoFilters.length || app.settings.peek().recoCustomActive.length) {
      return toast('С этими фильтрами ничего не нашлось — уберите часть', { icon: 'filter' });
    }
    const likes = app.likes.peek().map((l) => l.track);
    if (!likes.length) return toast('Поставьте пару лайков — рекомендациям нужно от чего оттолкнуться', { icon: 'sparkle' });
    first = shuffle(likes).slice(0, 10);
  }
  await playTracks(first, 0, { kind: 'wave', title: 'Рекомендации' });
  wave = current;
  waveInfo = { id: `reco-${Date.now()}`, title: 'Рекомендации', kind: 'reco' };
}

/** Wave grown from a playlist (or likes): its songs are the taste, the wave plays new ones like them. */
export function playListWave(title: string, tracks: Track[]): Promise<void> {
  return preparing(async () => {
    if (!app.online.peek()) return toast('Волна по плейлисту работает онлайн', { icon: 'offline' });
    const seeds = tracks.filter((t) => t.source === 'yt');
    const current = createWave({ seeds, title });
    const first = await runHooks(hooks.recommendations, await current.next(8).catch(() => [] as Track[]), { source: 'wave' });
    if (!first.length) return toast('Похожих треков не нашлось', { icon: 'similar' });
    const name = `Волна по «${title}»`;
    await playTracks(first, 0, { kind: 'wave', title: name });
    wave = current;
    waveInfo = { id: `list-${title}`, title: name, kind: 'playlist', seeds };
  });
}

/** Continues a saved wave: same seeds, nothing it already played. */
export function resumeWave(saved: SavedWave): Promise<void> {
  return preparing(async () => {
    if (!app.online.peek()) return toast('Нужна сеть', { icon: 'offline' });
    const current =
      saved.kind === 'track' && saved.seed
        ? new Wave(recoSource, 'mix', Math.random, saved.seed, { seen: saved.played })
        : createWave({ seeds: saved.seeds, seen: saved.played, title: saved.title });
    const first = await runHooks(hooks.recommendations, await current.next(8).catch(() => [] as Track[]), { source: 'wave' });
    if (!first.length) return toast('Эта волна закончилась — запустите новую', { icon: 'wave' });
    await playTracks(first, 0, { kind: 'wave', title: saved.title });
    wave = current;
    waveInfo = { id: saved.id, title: saved.title, kind: saved.kind, seed: saved.seed, seeds: saved.seeds };
    saveWave(saved.played);
  });
}

/** Rebuilds what comes after the current track with the new filters / mode, keeping the song that plays. */
export async function restyleWave(): Promise<void> {
  if (!isWaveActive() || !wave || waveInfo?.kind === 'track') return;
  const current = createWave({ seeds: waveInfo?.seeds, seen: wave.played(), title: waveInfo?.title });
  wave = current;
  const more = await runHooks(hooks.recommendations, await current.next(6).catch(() => [] as Track[]), { source: 'wave' });
  if (wave !== current) return;
  await call('queueReplaceUpcoming', { tracks: dedupeAgainstQueue(more, true) });
}

function saveWave(before: Track[] = []): void {
  if (!wave || !waveInfo) return;
  const played = [...before, ...wave.played()];
  if (played.length >= 3) rememberWave({ ...waveInfo, played, at: Date.now() });
}

/** Wave grown from one track: the track first, then songs related to it with a similar vibe. */
export function playTrackWave(seed: Track): Promise<void> {
  // The seed already plays: the queue changes behind it, nothing to wait for on screen.
  if (currentTrack.peek()?.id === seed.id) return startTrackWave(seed);
  return busy(startTrackWave(seed));
}

async function startTrackWave(seed: Track): Promise<void> {
  if (!app.online.peek() || seed.source !== 'yt') return toast('Волна по треку работает онлайн и для треков с YouTube', { icon: 'offline' });
  const current = new Wave(recoSource, 'mix', Math.random, seed);
  wave = current;
  const title = `Волна по «${seed.title}»`;
  const playing = currentTrack.peek()?.id === seed.id;
  if (playing) player.context.value = { kind: 'wave', title };
  // Start the seed right away; the rest joins the queue once found.
  else await playTracks([seed], 0, { kind: 'wave', title });
  wave = current;
  waveInfo = { id: `track-${seed.id}`, title, kind: 'track', seed };
  let more = await current.next(8).catch(() => [] as Track[]);
  more = await runHooks(hooks.recommendations, more, { source: 'wave' });
  if (wave !== current) return;
  if (!more.length) return toast('Похожих треков не нашлось', { icon: 'similar' });
  // One queue update for everything after the seed: no flicker of removing items one by one.
  if (playing) await call('queueReplaceUpcoming', { tracks: dedupeAgainstQueue(more, true) });
  else await call('queueAdd', { tracks: dedupeAgainstQueue(more) });
}

/** Drops songs already in the queue (any upload of them), so a wave never repeats a track. */
function dedupeAgainstQueue(tracks: Track[], upToCurrent = false): Track[] {
  const queue = player.queue.peek();
  const keep = upToCurrent ? queue.slice(0, player.index.peek() + 1) : queue;
  const ids = new Set(keep.map((t) => t.id));
  const keys = new Set(keep.map(songKey));
  return tracks.filter((t) => {
    const k = songKey(t);
    if (ids.has(t.id) || keys.has(k)) return false;
    ids.add(t.id);
    keys.add(k);
    return true;
  });
}

export function isWaveActive(): boolean {
  return player.context.peek()?.kind === 'wave';
}

async function extendWave(): Promise<void> {
  if (!wave || extending) return;
  extending = true;
  try {
    let more = await wave.next(6);
    more = await runHooks(hooks.recommendations, more, { source: 'wave' });
    more = dedupeAgainstQueue(await runHooks(hooks.queue, more, { reason: 'wave' }));
    if (more.length) await call('queueAdd', { tracks: more });
    saveWave();
  } catch (e) {
    console.warn('wave extension failed', e);
  } finally {
    extending = false;
  }
}

/** Flip the glyph immediately; native state events confirm or correct it a moment later. */
export function togglePlay(): void {
  if (player.wantsPlay.peek()) {
    player.wantsPlay.value = false;
    call('pause');
  } else if (currentTrack.peek()) {
    player.wantsPlay.value = true;
    call('resume');
  } else playWave();
}

let expectTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shows the loading ring for actions that will start a new stream — after a short delay, so a downloaded or
 * cached track that starts at once does not flash it. Skipped when the change already happened by then.
 */
export function expectLoading(): void {
  player.wantsPlay.value = true;
  const from = currentTrack.peek()?.id;
  clearTimeout(expectTimer);
  expectTimer = setTimeout(() => {
    if (currentTrack.peek()?.id === from && player.wantsPlay.peek()) player.buffering.value = true;
  }, 200);
}

export function next(): void {
  const track = currentTrack.peek();
  const pos = livePosition();
  if (track && pos < 30_000) {
    uiBus.emit('skip', { track, positionMs: pos });
    wave?.feedback('skip', track);
  }
  if (player.index.peek() < player.queue.peek().length - 1) expectLoading();
  call('next');
}

export const previous = () => call('previous');
export const seek = (ms: number) => {
  // The native side expects whole milliseconds; a fraction from the slider used to make the call fail silently.
  const positionMs = Math.max(0, Math.round(ms));
  player.position.value = { ...player.position.peek(), ms: positionMs, at: performance.now() };
  return call('seek', { positionMs });
};

export async function addToQueue(tracks: Track[], playNext = false): Promise<void> {
  const list = await runHooks(hooks.queue, tracks.filter(isPlayable), { reason: 'add' });
  if (!list.length) return;
  if (!currentTrack.peek()) return playTracks(list, 0, { kind: 'list', title: 'Очередь' });
  await call('queueAdd', { tracks: list, next: playNext });
  toast(playNext ? 'Сыграет следующим' : 'Добавлено в очередь', { icon: 'queue' });
}

export function initPlayback(): void {
  let lastTrack: Track | null = null;
  let lastProgress = { ms: 0, durationMs: 0 };

  onNative('progress', (p) => {
    player.position.value = { ms: p.positionMs, durationMs: p.durationMs, at: performance.now() };
    lastProgress = { ms: p.positionMs, durationMs: p.durationMs };
    uiBus.emit('progress', p);
  });
  onNative('stateChanged', (s) => {
    player.playing.value = s.playing;
    player.wantsPlay.value = s.playWhenReady && !s.ended;
    player.buffering.value = s.buffering;
    player.repeat.value = s.repeat;
    player.shuffle.value = s.shuffle;
    uiBus.emit('stateChanged', s);
    if (s.ended && isWaveActive()) extendWave().then(() => call('next').then(() => call('resume')));
  });
  onNative('queueChanged', (q) => {
    player.queue.value = q.queue;
    player.index.value = q.index;
    preloadArt(q.queue.slice(q.index + 1, q.index + 3));
    uiBus.emit('queueChanged', q);
  });
  onNative('trackChanged', (t) => {
    if (lastTrack && wave && lastProgress.durationMs > 0 && lastProgress.ms >= lastProgress.durationMs * 0.9) {
      wave.feedback('complete', lastTrack);
    }
    lastTrack = t.track;
    player.index.value = t.index;
    player.position.value = { ms: 0, durationMs: t.track?.durationMs ?? 0, at: performance.now() };
    uiBus.emit('trackChanged', t);
    if (isWaveActive() && player.queue.peek().length - t.index - 1 <= 2) extendWave();
  });
  onNative('playerError', (e) => {
    if (e.code === 'extraction') {
      toast(e.message, { icon: 'alert', action: { label: 'Обновить', run: () => call('openUrl', { text: RELEASES_URL }) } });
    } else {
      toast(e.message, { icon: e.code === 'offline' ? 'offline' : 'alert' });
    }
  });
  uiBus.on('like', ({ track, liked }) => {
    if (liked) wave?.feedback('like', track);
  });
  uiBus.on('dislike', ({ track }) => {
    wave?.feedback('skip', track);
    if (currentTrack.peek()?.id === track.id && player.index.peek() < player.queue.peek().length - 1) {
      expectLoading();
      call('next');
    }
  });
}

export async function restorePlayer(): Promise<void> {
  const s = await call('getPlayerState').catch(() => null);
  if (!s) return;
  player.queue.value = s.queue;
  player.index.value = s.index;
  player.playing.value = s.playing;
  player.wantsPlay.value = s.playing;
  player.repeat.value = s.repeat;
  player.shuffle.value = s.shuffle;
  player.position.value = { ms: s.positionMs, durationMs: s.durationMs, at: performance.now() };
  if (s.queue.length && !player.context.peek()) player.context.value = { kind: 'list', title: 'Сейчас играет' };
}

export function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
