import { defineRoute, goBack, navigate } from '../app/router';
import { BridgeError } from '../bridge/bridge';
import { append, h, replaceChildren } from '../core/dom';
import { resize } from '../services/art';
import { artist, collection } from '../services/catalog';
import { createPlaylist } from '../services/library';
import { playTracks } from '../services/playback';
import { appBar, button, cover, emptyState, iconButton, playButton, sectionHead, skeletonRows, watchScroll } from '../ui/components';
import { pageHero } from '../ui/hero';
import { toast } from '../ui/toast';
import { trackList } from '../ui/trackList';
import { listPage } from './library';

function loadingPage(title: string): HTMLElement {
  const screen = h('div.screen');
  screen.append(appBar({ title, back: goBack, alwaysTitle: true }), h('div.hero', { style: { paddingTop: 'var(--s-4)' } }, h('div.skeleton', { style: { width: '208px', height: '208px' } }), h('div.skeleton.line', { style: { width: '50%' } })), skeletonRows(6));
  return screen;
}

function errorPage(title: string, e: unknown, retry: () => void): HTMLElement {
  const screen = h('div.screen');
  screen.append(appBar({ title, back: goBack, alwaysTitle: true }), emptyState('alert', 'Не удалось открыть', (e as BridgeError).message, button('Повторить', retry)));
  return screen;
}

/** YouTube album or playlist. Can be saved into the local library as a playlist. */
defineRoute('remote', ({ scope, params }) => {
  const url = params.url as string;
  const title = (params.title as string) ?? '';
  const holder = h('div.screen', { style: { padding: '0' } }, loadingPage(title));
  const load = () =>
    collection(url)
      .then((page) => {
        const c = page.collection;
        const save = async () => {
          await createPlaylist(c.title, page.tracks);
          toast(`Сохранено в плейлисты: «${c.title}»`, { icon: 'check' });
        };
        replaceChildren(
          holder,
          listPage(scope, {
            title: c.title,
            cover: cover(c.artwork ? [resize(c.artwork, 544)] : [], '', c.kind === 'album' ? 'disc' : 'playlist'),
            artUrl: c.artwork,
            tracks: page.tracks,
            context: c.title,
            numbered: c.kind === 'album',
            menu: save,
          }),
        );
        holder.querySelector('.appbar .btn-icon:last-child')?.replaceWith(iconButton('plus', 'Сохранить в плейлисты', save));
      })
      .catch((e) => replaceChildren(holder, errorPage(title, e, load)));
  load();
  return holder;
});

defineRoute('artist', ({ scope, params }) => {
  const url = params.url as string;
  const name = ((params.name as string) ?? '').replace(/\s+-\s+Topic$/, '');
  const holder = h('div.screen', { style: { padding: '0' } }, loadingPage(name));
  const load = () =>
    artist(url)
      .then((page) => {
        const screen = h('div.screen');
        const displayName = page.artist.name.replace(/\s+-\s+Topic$/, '');
        const bar = appBar({ title: displayName, back: goBack });
        bar.classList.add('overlay');
        watchScroll(screen, bar, 200);
        const ctx = { kind: 'list' as const, title: displayName };
        const art = page.artist.artwork ? resize(page.artist.artwork, 544) : null;
        const top = page.tracks.slice(0, 10);
        append(screen, [
          bar,
          pageHero(scope, {
            title: displayName,
            sub: page.artist.subscribers ? `${new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(page.artist.subscribers)} подписчиков` : undefined,
            cover: cover(art ? [art] : [], 'round', 'user'),
            artUrl: art,
            actions: page.tracks.length ? [playButton(scope, { playing: () => false, onToggle: () => playTracks(page.tracks, 0, ctx) })] : [],
          }),
          page.tracks.length ? h('section', null, sectionHead('Популярное'), trackList(scope, { tracks: top, scroller: screen, context: ctx })) : emptyState('note', 'Треков не нашлось'),
          page.albums.length
            ? h(
                'section.section',
                null,
                sectionHead('Альбомы и плейлисты'),
                h(
                  'div.scroll-x',
                  null,
                  page.albums.map((a) =>
                    h('div.card', { onclick: () => navigate('remote', { url: a.url, title: a.title }) }, cover(a.artwork ? [resize(a.artwork, 300)] : [], '', 'disc'), h('div.card-title.ellipsis', null, a.title), h('div.card-sub.ellipsis', null, a.subtitle ?? '')),
                  ),
                ),
              )
            : null,
          page.tracks.length > 10 ? h('section.section', null, sectionHead('Все треки'), trackList(scope, { tracks: page.tracks, scroller: screen, context: ctx })) : null,
        ]);
        replaceChildren(holder, screen);
      })
      .catch((e) => replaceChildren(holder, errorPage(name, e, load)));
  load();
  return holder;
});
