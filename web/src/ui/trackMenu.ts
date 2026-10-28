import { navigate } from '../app/router';
import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { h, icon } from '../core/dom';
import { app, likedIds } from '../core/store';
import { guard, slots } from '../mods/registry';
import { addToPlaylist, createPlaylist, download, removeDownload, toggleLike } from '../services/library';
import { addToQueue } from '../services/playback';
import { cover, trackCover } from './components';
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
  if (track.source === 'yt') {
    actions.push(
      dl
        ? { icon: 'trash', label: dl.status === 'done' ? 'Удалить загрузку' : 'Отменить загрузку', run: () => removeDownload(track.id) }
        : { icon: 'download', label: 'Скачать', run: () => download([track]) },
    );
    if (track.artistUrl) actions.push({ icon: 'user', label: 'К исполнителю', run: () => navigate('artist', { url: track.artistUrl, name: track.artist }) });
    actions.push({ icon: 'share', label: 'Поделиться', run: () => call('share', { text: `${track.artist} — ${track.title}\n${track.url ?? ''}` }) });
  }
  for (const item of slots.trackMenu.peek()) {
    actions.push({ icon: item.icon ?? 'puzzle', label: item.label, run: () => guard(item.modId, item.onClick)(track) });
  }
  actionSheet(trackHeader(track), actions);
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
