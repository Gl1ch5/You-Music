import { call, onNative } from '../bridge/bridge';
import type { Download, Track } from '../bridge/contract';
import { debounce } from '../core/dom';
import { app, likedIds } from '../core/store';
import { toast } from '../ui/toast';
import { uiBus } from './events';

/** Likes, playlists, downloads and local files: thin wrappers that keep the signals in `app` in sync. */

export async function refreshLibrary(): Promise<void> {
  const lib = await call('getLibrary');
  app.likes.value = lib.likes;
  app.playlists.value = lib.playlists;
  app.local.value = lib.local;
  app.downloads.value = new Map(lib.downloads.map((d) => [d.trackId, d]));
}

const refreshSoon = debounce(() => refreshLibrary().catch(console.error), 150);

export function initLibrary(): void {
  onNative('libraryChanged', refreshSoon);
  onNative('downloadProgress', (d: Download) => {
    const map = new Map(app.downloads.peek());
    if (d.status === 'removed') map.delete(d.trackId);
    else map.set(d.trackId, { ...map.get(d.trackId), ...d, track: d.track ?? map.get(d.trackId)?.track });
    app.downloads.value = map;
    if (d.status === 'failed') toast(`Не удалось скачать: ${d.error ?? 'ошибка'}`, { icon: 'alert' });
  });
}

export async function setLiked(track: Track, liked: boolean): Promise<void> {
  // Optimistic: flip locally first, the libraryChanged event reconciles.
  app.likes.value = liked
    ? [{ track, likedAt: Date.now() }, ...app.likes.peek().filter((l) => l.track.id !== track.id)]
    : app.likes.peek().filter((l) => l.track.id !== track.id);
  uiBus.emit('like', { track, liked });
  try {
    await call('like', { track, liked });
  } catch (e) {
    toast('Не удалось сохранить лайк');
    refreshSoon();
    throw e;
  }
}

export const toggleLike = (track: Track) => setLiked(track, !likedIds.peek().has(track.id));

export async function download(tracks: Track[]): Promise<void> {
  const remote = tracks.filter((t) => t.source === 'yt');
  if (!remote.length) return;
  if (!app.online.peek()) {
    toast('Нет сети — загрузка начнётся позже', { icon: 'offline' });
  }
  await call('download', { tracks: remote, quality: app.settings.peek().downloadQuality });
  toast(remote.length === 1 ? 'Трек добавлен в загрузки' : `В загрузки: ${remote.length}`, { icon: 'download' });
}

export const removeDownload = (id: string) => call('downloadRemove', { id });

export async function createPlaylist(name: string, tracks: Track[] = []) {
  const p = await call('playlistCreate', { name, tracks });
  await refreshLibrary();
  return p;
}

export async function addToPlaylist(id: number, tracks: Track[]): Promise<void> {
  await call('playlistAdd', { id, tracks });
  const name = app.playlists.peek().find((p) => p.id === id)?.name ?? 'плейлист';
  toast(`Добавлено в «${name}»`, { icon: 'check' });
}
