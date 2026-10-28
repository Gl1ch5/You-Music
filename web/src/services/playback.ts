import { call, onNative } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { app, currentTrack, isPlayable, livePosition, player, type PlayContext } from '../core/store';
import { Wave, type RecoSource } from '../logic/recommend';
import { hooks, runHooks } from '../mods/registry';
import { toast } from '../ui/toast';
import { aiSuggest } from './ai';
import { related } from './catalog';
import { vibesOf } from './features';
import { uiBus } from './events';

export const RELEASES_URL = 'https://github.com/Gl1ch5/You-Music/releases/latest';

/** Everything that starts or steers playback goes through here, so mods' queue hooks and the wave see it. */

export const recoSource: RecoSource = {
  signals: async () => ({
    likes: app.likes.peek(),
    history: await call('history', { limit: 400 }).catch(() => []),
    now: Date.now(),
  }),
  related,
  vibes: vibesOf,
};

let wave: Wave | null = null;

/** Wave for the current mode; "neuro" mixes AI suggestions into the related-video candidates. */
export function createWave(): Wave {
  const mode = app.settings.peek().waveMode;
  if (mode === 'neuro' && app.aiEnabled.peek()) {
    return new Wave({ ...recoSource, extra: async () => (await aiSuggest(recoSource, 12)).map((p) => p.track) }, 'mix');
  }
  return new Wave(recoSource, mode === 'neuro' ? 'mix' : mode);
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
  if (context?.kind !== 'wave') wave = null;
  player.context.value = context;
  expectLoading();
  await call('play', { queue: list, index: start });
}

export async function playWave(): Promise<void> {
  if (!app.online.peek()) {
    const offline = [...app.likes.peek().map((l) => l.track), ...app.local.peek()].filter(isPlayable);
    if (!offline.length) return toast('Без сети поток играет скачанное — пока его нет', { icon: 'offline' });
    wave = null;
    return playTracks(shuffle(offline), 0, { kind: 'wave', title: 'Поток · офлайн' });
  }
  wave = createWave();
  let first = await wave.next(8).catch(() => [] as Track[]);
  first = await runHooks(hooks.recommendations, first, { source: 'wave' });
  if (!first.length) {
    const likes = app.likes.peek().map((l) => l.track);
    if (!likes.length) return toast('Поставьте пару лайков — рекомендациям нужно от чего оттолкнуться', { icon: 'sparkle' });
    first = shuffle(likes).slice(0, 10);
  }
  const current = wave;
  await playTracks(first, 0, { kind: 'wave', title: 'Поток рекомендаций' });
  wave = current;
}

/** Wave grown from one track: the track first, then songs related to it with a similar vibe. */
export async function playTrackWave(seed: Track): Promise<void> {
  if (!app.online.peek() || seed.source !== 'yt') return toast('Волна по треку работает онлайн и для треков с YouTube', { icon: 'offline' });
  const current = new Wave(recoSource, 'mix', Math.random, seed);
  wave = current;
  const title = `Волна по «${seed.title}»`;
  if (currentTrack.peek()?.id === seed.id) {
    // Already playing: keep it going, just replace what comes after it.
    player.context.value = { kind: 'wave', title };
    for (let i = player.queue.peek().length - 1; i > player.index.peek(); i--) await call('queueRemove', { index: i });
  } else {
    // Start the seed right away; the rest joins the queue once found.
    await playTracks([seed], 0, { kind: 'wave', title });
  }
  wave = current;
  let more = await current.next(8).catch(() => [] as Track[]);
  more = await runHooks(hooks.recommendations, more, { source: 'wave' });
  if (wave !== current) return;
  if (more.length) await call('queueAdd', { tracks: more });
  else toast('Похожих треков не нашлось', { icon: 'similar' });
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
    more = await runHooks(hooks.queue, more, { reason: 'wave' });
    if (more.length) await call('queueAdd', { tracks: more });
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

/** Shows the loading ring right away for actions that will start a new stream. */
export function expectLoading(): void {
  player.wantsPlay.value = true;
  player.buffering.value = true;
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
export const seek = (positionMs: number) => {
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
