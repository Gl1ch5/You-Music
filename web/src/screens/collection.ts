import { defineRoute, navigate } from '../app/router';
import type { Track } from '../bridge/contract';
import { h, icon, replaceChildren, tracksLabel } from '../core/dom';
import { app } from '../core/store';
import { artistKey } from '../logic/normalize';
import { slots } from '../mods/registry';
import { artFor } from '../services/art';
import { playTracks } from '../services/playback';
import { cover, iconButton, sectionHead, trackRow } from '../ui/components';
import { openTrackMenu } from '../ui/trackMenu';

function tile(iconName: string, title: string, sub: string, onclick: () => void): HTMLElement {
  return h('div.tile', { onclick }, icon(iconName), h('div.tile-title', null, title), h('div.small.muted', null, sub));
}

/** Artists ranked by how many liked tracks they have; artwork borrowed from one of those tracks. */
export function favoriteArtists(likes: Track[]): { name: string; url?: string | null; track: Track; count: number }[] {
  const map = new Map<string, { name: string; url?: string | null; track: Track; count: number }>();
  for (const t of likes) {
    const k = artistKey(t.artist);
    if (!k) continue;
    const e = map.get(k) ?? { name: t.artist.split(/,|&/)[0].trim(), url: t.artistUrl, track: t, count: 0 };
    e.count++;
    e.url ??= t.artistUrl;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 12);
}

defineRoute('collection', ({ scope }) => {
  const screen = h('div.screen');
  const likesBlock = h('section');
  const tiles = h('div.tiles');
  const artists = h('section.section');
  const modTabs = h('section.section');

  scope.effect(() => {
    const likes = app.likes.value.map((l) => l.track);
    const heart = h('div.cover', { style: { width: '64px', height: '64px', background: 'var(--surface-2)', color: 'var(--like)' } }, icon('heart-fill'));
    replaceChildren(
      likesBlock,
      h('div.row', { style: { height: '88px' }, onclick: () => navigate('likes') }, heart, h('div.row-main', null, h('div.h2', null, 'Мне нравится'), h('div.row-sub', null, tracksLabel(likes.length))), icon('chevron-right', 'faint')),
      likes.slice(0, 3).map((t, i) => trackRow(t, { onPlay: () => playTracks(likes, i, { kind: 'list', title: 'Мне нравится' }), onMore: () => openTrackMenu(t) })),
    );
  });

  scope.effect(() => {
    const done = [...app.downloads.value.values()].filter((d) => d.status === 'done').length;
    replaceChildren(
      tiles,
      tile('playlist', 'Плейлисты', `${app.playlists.value.length}`, () => navigate('playlists')),
      tile('download', 'Скачанное', tracksLabel(done), () => navigate('downloads')),
      tile('folder', 'Мои файлы', tracksLabel(app.local.value.length), () => navigate('local')),
      tile('clock', 'История', 'Прослушивания', () => navigate('history')),
    );
  });

  scope.effect(() => {
    const list = favoriteArtists(app.likes.value.map((l) => l.track));
    artists.hidden = list.length < 2;
    replaceChildren(
      artists,
      sectionHead('Любимые исполнители'),
      h(
        'div.scroll-x',
        null,
        list.map((a) =>
          h(
            'div.card',
            { style: { width: '104px' }, onclick: () => (a.url ? navigate('artist', { url: a.url, name: a.name }) : undefined) },
            sized(cover(artFor(a.track, 'sm'), 'round', 'user'), '104px'),
            h('div.card-title.ellipsis', { style: { textAlign: 'center' } }, a.name),
          ),
        ),
      ),
    );
  });

  scope.effect(() => {
    const tabs = slots.tabs.value;
    modTabs.hidden = !tabs.length;
    replaceChildren(modTabs, sectionHead('Из модов'), h('div.tiles', null, tabs.map((t) => tile(t.icon ?? 'puzzle', t.title, 'Мод', () => navigate('modPanel', { kind: 'tabs', modId: t.modId, id: t.id })))));
  });

  screen.append(
    h('div', { style: { height: 'var(--safe-top)' } }),
    h('div.page-head', null, h('h1.h1', null, 'Коллекция'), iconButton('settings', 'Настройки', () => navigate('settings'))),
    likesBlock,
    h('div.section', null, tiles),
    artists,
    modTabs,
  );
  return screen;
});

export function sized(el: HTMLElement, size: string): HTMLElement {
  el.style.width = el.style.height = size;
  return el;
}
