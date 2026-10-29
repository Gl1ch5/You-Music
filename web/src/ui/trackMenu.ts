import { navigate } from '../app/router';
import { call, platform } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { h, icon } from '../core/dom';
import { app, likedIds } from '../core/store';
import { guard, slots } from '../mods/registry';
import { addToPlaylist, createPlaylist, download, removeDownload, toggleLike } from '../services/library';
import { addToQueue, playTrackWave } from '../services/playback';
import { isDisliked, toggleDislike } from '../services/dislikes';
import { cover, trackCover } from './components';
import { openTrackInfo } from './trackInfo';
import { actionSheet, openSheet, promptSheet, type Action } from './sheet';

export interface MenuExtras {
  /** Extra actions first (e.g. "Remove from playlist"). */
  actions?: Action[];
}

export function trackHeader(track: Track) {
  return [trackCover(track, 'sm'), h('div.item-main', null, h('div.row-title.ellipsis', null, track.title), h('div.row-sub.ellipsis', null, track.artist))];
}

export function openTrackMenu(track: Track, extras: MenuExtras = {}): void {
  const liked = likedIds.peek().has(track.id);
  const dl = app.downloads.peek().get(track.id);
  const actions: Action[] = [
    ...(extras.actions ?? []),
    { icon: 'queue', label: 'Играть следующим', run: () => addToQueue([track], true) },
    { icon: 'playlist', label: 'Добавить в очередь', run: () => addToQueue([track]) },
    { icon: liked ? 'heart-fill' : 'heart', label: liked ? 'Убрать из «Мне нравится»' : 'Мне нравится', run: () => toggleLike(track) },
    { icon: 'plus', label: 'Добавить в плейлист', run: () => pickPlaylist([track]) },
  ];
  if (track.source !== 'local') {
    const off = isDisliked(track);
    actions.push({ icon: off ? 'dislike-fill' : 'dislike', label: off ? 'Снова рекомендовать' : 'Не нравится', sub: off ? undefined : 'Больше не попадётся в рекомендациях', run: () => toggleDislike(track) });
  }
  if (track.source === 'yt') {
    actions.push({ icon: 'wave', label: 'Волна по треку', sub: 'Похожие по звучанию и настроению', run: () => playTrackWave(track) });
    if (platform !== 'web') actions.push(
      dl
        ? { icon: 'trash', label: dl.status === 'done' ? 'Удалить загрузку' : 'Отменить загрузку', run: () => removeDownload(track.id) }
        : { icon: 'download', label: 'Скачать', run: () => download([track]) },
    );
    if (track.artistUrl) actions.push({ icon: 'user', label: 'К исполнителю', run: () => navigate('artist', { url: track.artistUrl, name: track.artist }) });
    actions.push({ icon: 'share', label: 'Поделиться', run: () => shareTrack(track) });
  }
  actions.push({ icon: 'info', label: 'О треке', sub: 'Формат, битрейт, размер', run: () => openTrackInfo(track) });
  for (const item of slots.trackMenu.peek()) {
    actions.push({ icon: item.icon ?? 'puzzle', label: item.label, run: () => guard(item.modId, item.onClick)(track) });
  }
  actionSheet(trackHeader(track), actions);
}

/** A link that opens the track in You Music (the page offers the app, or YouTube without it). */
export function shareLink(track: Track): string {
  return `https://grzxk.ru/youmusic/t/${encodeURIComponent(track.id.replace(/^yt:/, ''))}`;
}

export function shareTrack(track: Track): Promise<void> {
  return call('share', { text: `${track.artist} — ${track.title}\n${shareLink(track)}` });
}

export function pickPlaylist(tracks: Track[]): void {
  openSheet({
    header: h('div.h2', null, 'Добавить в плейлист'),
    content: (close) => [
      h(
        'div.item',
        {
          onclick: async () => {
            close();
            const name = await promptSheet({ title: 'Новый плейлист', placeholder: 'Название' });
            if (name) {
              const p = await createPlaylist(name);
              await addToPlaylist(p.id, tracks);
            }
          },
        },
        h('div.cover', { style: { width: 'var(--cover-row)', height: 'var(--cover-row)' } }, icon('plus')),
        h('div.item-main', null, 'Новый плейлист'),
      ),
      ...app.playlists.peek().map((p) =>
        h(
          'div.item',
          {
            onclick: () => {
              close();
              addToPlaylist(p.id, tracks);
            },
          },
          sized(cover(p.artwork ? [p.artwork] : [], '', 'playlist')),
          h('div.item-main', null, h('div.ellipsis', null, p.name), h('div.item-sub', null, `${p.count}`)),
        ),
      ),
    ],
  });
}

function sized(el: HTMLElement): HTMLElement {
  el.style.width = el.style.height = 'var(--cover-row)';
  return el;
}
