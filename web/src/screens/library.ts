import { defineRoute, goBack, navigate } from '../app/router';
import { call } from '../bridge/bridge';
import type { Playlist, Track } from '../bridge/contract';
import { h, icon, plural, replaceChildren, setIcon, tracksLabel } from '../core/dom';
import { track, type Scope } from '../core/signal';
import { app } from '../core/store';
import { createPlaylist, download, notDownloaded } from '../services/library';
import { playListWave, playTracks, shuffle } from '../services/playback';
import { appBar, cover, emptyState, iconButton, listenButtons, pageIntro, playButton, trackRow, watchScroll } from '../ui/components';
import { pageHero, totalDuration } from '../ui/hero';
import { actionSheet, confirmSheet, promptSheet } from '../ui/sheet';
import { toast } from '../ui/toast';
import { trackList } from '../ui/trackList';
import { openTrackMenu, type MenuExtras } from '../ui/trackMenu';

/** Shared list page: hero with play / shuffle / download, then the tracks. */
export function listPage(
  scope: Scope,
  opts: {
    title: string;
    cover: HTMLElement;
    artUrl?: string | null;
    tracks: Track[];
    context: string;
    numbered?: boolean;
    menu?: () => void;
    rowMenu?: (t: Track, i: number) => MenuExtras;
    empty?: HTMLElement;
  },
): HTMLElement {
  const screen = h('div.screen');
  const bar = appBar({ title: opts.title, back: goBack, actions: opts.menu ? [iconButton('more', 'Ещё', opts.menu)] : [] });
  bar.classList.add('overlay');
  watchScroll(screen, bar, 200);
  const ctx = { kind: 'list' as const, title: opts.title };
  const total = opts.tracks.reduce((s, t) => s + t.durationMs, 0);
  const actions = opts.tracks.length
    ? [
        iconButton('shuffle', 'Перемешать', () => playTracks(shuffle(opts.tracks), 0, ctx)),
        playButton(scope, { playing: () => false, onToggle: () => playTracks(opts.tracks, 0, ctx) }),
        downloadAllButton(scope, opts.tracks),
        ...(opts.tracks.filter((t) => t.source === 'yt').length >= 2 ? [iconButton('wave', 'Волна по плейлисту', () => playListWave(opts.title, opts.tracks))] : []),
      ]
    : [];
  screen.append(
    bar,
    pageHero(scope, { title: opts.title, sub: opts.tracks.length ? `${tracksLabel(opts.tracks.length)} · ${totalDuration(total)}` : undefined, cover: opts.cover, artUrl: opts.artUrl, actions }),
    opts.tracks.length ? trackList(scope, { tracks: opts.tracks, scroller: screen, context: ctx, numbered: opts.numbered, menu: opts.rowMenu }) : (opts.empty ?? null) as HTMLElement,
  );
  return screen;
}

/** Round button that downloads every track of a list; the ring shows how much is already offline. */
function downloadAllButton(scope: Scope, tracks: Track[]): HTMLElement {
  const remote = tracks.filter((t) => t.source === 'yt');
  const glyph = icon('download');
  const btn = h('button.btn-icon.dl-all', { attrs: { 'aria-label': 'Скачать всё' }, onclick: () => {
    const rest = notDownloaded(remote);
    if (rest.length) download(rest);
    else toast('Всё уже скачано', { icon: 'downloaded' });
  } }, glyph);
  scope.effect(() => {
    const map = app.downloads.value;
    const done = remote.filter((t) => map.get(t.id)?.status === 'done').length;
    const all = remote.length > 0 && done === remote.length;
    setIcon(glyph, all ? 'downloaded' : 'download');
    btn.classList.toggle('on', all);
    btn.style.setProperty('--dl', String(remote.length ? done / remote.length : 0));
    btn.setAttribute('aria-label', all ? 'Всё скачано' : `Скачать всё (${done} из ${remote.length})`);
  });
  return btn;
}

function heartCover(): HTMLElement {
  const c = h('div.cover', { style: { color: 'var(--like)' } }, icon('heart-fill'));
  c.querySelector('svg')!.style.setProperty('--icon', '72px');
  return c;
}

/** Replaces the page inside `holder`, keeping the scroll position of the previous one. */
export function swapPage(holder: HTMLElement, page: HTMLElement): void {
  const top = holder.querySelector<HTMLElement>('.screen')?.scrollTop ?? 0;
  replaceChildren(holder, page);
  if (top) page.scrollTop = top;
}

defineRoute('likes', ({ scope }) => {
  const holder = h('div.screen', { style: { padding: '0' } });
  let shown = '';
  scope.effect(() => {
    const tracks = app.likes.value.map((l) => l.track);
    // Only a real change of the list re-renders (and even then the scroll stays where it was).
    const ids = tracks.map((t) => t.id).join('|');
    if (ids === shown) return;
    shown = ids;
    swapPage(
      holder,
      listPage(scope, {
        title: 'Мне нравится',
        cover: heartCover(),
        tracks,
        context: 'Мне нравится',
        empty: emptyState('heart', 'Пока пусто', 'Нажимайте на сердце у треков — они появятся здесь.'),
      }),
    );
  });
  return holder;
});

function playlistCover(p: Playlist): HTMLElement {
  return cover(p.artwork ? [p.artwork] : [], '', 'playlist');
}

defineRoute('playlists', ({ scope }) => {
  const screen = h('div.screen');
  const create = async () => {
    const name = await promptSheet({ title: 'Новый плейлист', placeholder: 'Название' });
    if (name) navigate('playlist', { id: (await createPlaylist(name)).id });
  };
  const bar = appBar({ title: 'Плейлисты', back: goBack, actions: [iconButton('plus', 'Новый плейлист', create)] });
  watchScroll(screen, bar);
  const body = h('div');
  scope.effect(() => {
    const list = app.playlists.value;
    replaceChildren(
      body,
      pageIntro('Плейлисты', list.length ? `${list.length} ${plural(list.length, 'плейлист', 'плейлиста', 'плейлистов')}` : null),
      h(
        'div.card-grid.playlists',
        null,
        h('div.card', { onclick: create }, h('div.cover.new-cover', null, icon('plus')), h('div.card-title', null, 'Новый плейлист'), h('div.card-sub', null, 'Создать')),
        list.map((p) => h('div.card', { onclick: () => navigate('playlist', { id: p.id }) }, playlistCover(p), h('div.card-title.ellipsis', null, p.name), h('div.card-sub', null, tracksLabel(p.count)))),
      ),
    );
  });
  screen.append(bar, body);
  return screen;
});

defineRoute('playlist', ({ scope, params }) => {
  const id = params.id as number;
  const holder = h('div.screen', { style: { padding: '0' } });
  let editing = false;

  const render = async () => {
    const page = await call('playlistGet', { id }).catch(() => null);
    if (!page) {
      replaceChildren(holder, emptyState('alert', 'Плейлист не найден'));
      return;
    }
    const { playlist, tracks } = page;
    const menu = () =>
      actionSheet(h('div.h2', null, playlist.name), [
        { icon: 'edit', label: 'Переименовать', run: async () => {
          const name = await promptSheet({ title: 'Название', value: playlist.name });
          if (name) await call('playlistRename', { id, name });
        } },
        { icon: 'grip', label: editing ? 'Готово' : 'Изменить порядок', run: () => {
          editing = !editing;
          render();
        } },
        { icon: 'download', label: 'Скачать плейлист', run: () => download(tracks) },
        { icon: 'trash', label: 'Удалить плейлист', danger: true, run: async () => {
          if (await confirmSheet({ title: `Удалить «${playlist.name}»?`, ok: 'Удалить', danger: true })) {
            await call('playlistDelete', { id });
            goBack();
          }
        } },
      ]);
    if (editing) {
      replaceChildren(holder, reorderPage(playlist, tracks, () => {
        editing = false;
        render();
      }));
      return;
    }
    swapPage(
      holder,
      listPage(scope, {
        title: playlist.name,
        cover: playlistCover(playlist),
        artUrl: playlist.artwork,
        tracks,
        context: playlist.name,
        menu,
        rowMenu: (_t, i) => ({ actions: [{ icon: 'trash', label: 'Убрать из плейлиста', run: () => call('playlistRemove', { id, index: i }) }] }),
        empty: emptyState('playlist', 'Плейлист пуст', 'Добавляйте треки через меню «⋮» → «Добавить в плейлист».'),
      }),
    );
  };

  render();
  onLibraryChange(scope, () => !editing && render());
  return holder;
});

/** Drag rows by the grip to reorder; each drop is saved immediately. */
function reorderPage(playlist: Playlist, tracks: Track[], done: () => void): HTMLElement {
  const screen = h('div.screen');
  const bar = appBar({ title: playlist.name, back: done, alwaysTitle: true, actions: [iconButton('check', 'Готово', done)] });
  const list = h('div.list');
  const order = [...tracks];
  const ROW = 64;
  const rows = order.map((t) => trackRow(t, { onPlay: () => undefined, grip: true }));
  rows.forEach((r) => list.appendChild(r));

  rows.forEach((row) => {
    const grip = row.querySelector<HTMLElement>('.grip')!;
    let startY = 0;
    let from = 0;
    grip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      startY = e.clientY;
      from = [...list.children].indexOf(row);
      row.classList.add('dragging');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!row.classList.contains('dragging')) return;
      row.style.transform = `translateY(${e.clientY - startY}px)`;
    });
    grip.addEventListener('pointerup', async (e) => {
      if (!row.classList.contains('dragging')) return;
      row.classList.remove('dragging');
      row.style.transform = '';
      const to = Math.max(0, Math.min(order.length - 1, from + Math.round((e.clientY - startY) / ROW)));
      if (to === from) return;
      const children = [...list.children];
      list.insertBefore(row, to > from ? children[to].nextSibling : children[to]);
      order.splice(to, 0, order.splice(from, 1)[0]);
      await call('playlistMove', { id: playlist.id, from, to }).catch(() => toast('Не удалось сохранить порядок'));
    });
  });
  screen.append(bar, h('div.pad.muted.small', { style: { padding: 'var(--s-2) var(--gutter)' } }, 'Перетаскивайте треки за ручку слева.'), list);
  return screen;
}

defineRoute('history', () => {
  const screen = h('div.screen');
  const bar = appBar({
    title: 'История',
    back: goBack,
    actions: [
      iconButton('trash', 'Очистить историю', async () => {
        if (await confirmSheet({ title: 'Очистить историю?', text: 'Рекомендации начнут учиться заново.', ok: 'Очистить', danger: true })) {
          await call('historyClear');
          load();
        }
      }),
    ],
  });
  watchScroll(screen, bar);
  const body = h('div');
  const load = async () => {
    const entries = await call('history', { limit: 500 }).catch(() => []);
    if (!entries.length) return replaceChildren(body, pageIntro('История', null), emptyState('clock', 'История пуста', 'Здесь появится всё, что вы слушали.'));
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 864e5).toDateString();
    const groups = new Map<string, typeof entries>();
    for (const e of entries) {
      const d = new Date(e.playedAt);
      const day = d.toDateString() === today ? 'Сегодня' : d.toDateString() === yesterday ? 'Вчера' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      groups.set(day, [...(groups.get(day) ?? []), e]);
    }
    const all = entries.map((e) => e.track);
    let offset = 0;
    replaceChildren(
      body,
      pageIntro('История', tracksLabel(entries.length), listenButtons(all, 'История')),
      [...groups].map(([day, list]) => {
        const start = offset;
        offset += list.length;
        return h(
          'section',
          null,
          h('div.day-head', null, day),
          list.map((e, i) =>
            trackRow(e.track, {
              sub: `${e.track.artist}${e.skipped ? ' · пропущен' : ''}`,
              onPlay: () => playTracks(all, start + i, { kind: 'list', title: 'История' }),
              onMore: () => openTrackMenu(e.track),
            }),
          ),
        );
      }),
    );
  };
  load();
  screen.append(bar, body);
  return screen;
});

/** Re-renders a screen when likes or playlists change (skips the initial run). */
export function onLibraryChange(scope: Scope, fn: () => void): void {
  let first = true;
  scope.effect(() => {
    track(app.playlists, app.likes);
    if (first) first = false;
    else fn();
  });
}
