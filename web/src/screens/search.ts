import { defineRoute, navigate } from '../app/router';
import { BridgeError, call } from '../bridge/bridge';
import type { Artist, Collection, SearchFilter, SearchItem, Track } from '../bridge/contract';
import { debounce, h, icon, replaceChildren } from '../core/dom';
import { app } from '../core/store';
import { resize } from '../services/art';
import { search, suggestions } from '../services/catalog';
import { playTracks, RELEASES_URL } from '../services/playback';
import { button, chip, cover, emptyState, iconButton, listItem, sectionHead, skeletonRows, trackRow } from '../ui/components';
import { openTrackMenu } from '../ui/trackMenu';

const FILTERS: [SearchFilter, string][] = [
  ['all', 'Всё'],
  ['songs', 'Треки'],
  ['videos', 'Видео'],
  ['albums', 'Альбомы'],
  ['artists', 'Исполнители'],
  ['playlists', 'Плейлисты'],
];

const HISTORY_KEY = 'search.history';
const TOP_TRACKS = 6;

async function readHistory(): Promise<string[]> {
  try {
    return JSON.parse((await call('kvGet', { key: HISTORY_KEY })) ?? '[]');
  } catch {
    return [];
  }
}

async function removeHistory(q: string): Promise<void> {
  const list = (await readHistory()).filter((x) => x !== q);
  await call('kvSet', { key: HISTORY_KEY, value: list.length ? JSON.stringify(list) : null });
}

async function pushHistory(q: string): Promise<void> {
  const list = [q, ...(await readHistory()).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 20);
  await call('kvSet', { key: HISTORY_KEY, value: JSON.stringify(list) });
}

export function collectionRow(c: Collection): HTMLElement {
  const sub = [c.kind === 'album' ? 'Альбом' : 'Плейлист', c.subtitle].filter(Boolean).join(' · ');
  return h(
    'div.row',
    { onclick: () => navigate('remote', { url: c.url, title: c.title }) },
    cover(c.artwork ? [resize(c.artwork, 120)] : [], '', c.kind === 'album' ? 'disc' : 'playlist'),
    h('div.row-main', null, h('div.row-title.ellipsis', null, c.title), h('div.row-sub.ellipsis', null, sub)),
    icon('chevron-right', 'faint'),
  );
}

function collectionCard(c: Collection): HTMLElement {
  return h(
    'div.card',
    { onclick: () => navigate('remote', { url: c.url, title: c.title }) },
    cover(c.artwork ? [resize(c.artwork, 300)] : [], '', c.kind === 'album' ? 'disc' : 'playlist'),
    h('div.card-title.ellipsis', null, c.title),
    h('div.card-sub.ellipsis', null, [c.kind === 'album' ? 'Альбом' : 'Плейлист', c.subtitle].filter(Boolean).join(' · ')),
  );
}

export function artistRow(a: Artist): HTMLElement {
  return h(
    'div.row',
    { onclick: () => navigate('artist', { url: a.url, name: a.name }) },
    cover(a.artwork ? [resize(a.artwork, 120)] : [], 'round', 'user'),
    h('div.row-main', null, h('div.row-title.ellipsis', null, a.name.replace(/\s+-\s+Topic$/, '')), h('div.row-sub', null, 'Исполнитель')),
    icon('chevron-right', 'faint'),
  );
}

defineRoute('search', ({ scope }) => {
  const screen = h('div.screen');
  const input = h('input', { attrs: { type: 'search', placeholder: 'Трек, исполнитель, альбом', enterkeyhint: 'search', autocomplete: 'off' } });
  const clearBtn = iconButton('close', 'Очистить', () => {
    input.value = '';
    showIdle();
    input.focus();
  });
  const field = h('div.field', null, icon('search'), input, clearBtn);
  const chips = h('div.chips', { style: { padding: 'var(--s-2) var(--gutter) 0' } });
  const head = h('div.appbar', { style: { flexDirection: 'column', alignItems: 'stretch', height: 'auto', padding: 'calc(var(--safe-top) + var(--s-2)) 0 var(--s-2)' } }, h('div.pad', null, field), chips);
  const body = h('div');
  screen.append(head, body);
  screen.addEventListener('scroll', () => head.classList.toggle('scrolled', screen.scrollTop > 8), { passive: true });

  let filter: SearchFilter = 'all';
  let query = '';
  let nextPage: string | null = null;
  let loadingMore = false;
  let tracks: Track[] = [];
  let resultList: HTMLElement | null = null;
  let requestId = 0;

  const renderChips = (visible: boolean) => {
    chips.hidden = !visible;
    replaceChildren(
      chips,
      FILTERS.map(([id, label]) =>
        chip(label, id === filter, () => {
          filter = id;
          runSearch(query);
        }),
      ),
    );
  };

  const showIdle = async () => {
    renderChips(false);
    clearBtn.hidden = true;
    const history = await readHistory();
    replaceChildren(
      body,
      history.length
        ? [
            h(
              'div.section-head',
              null,
              h('h2.h2', { style: { flex: '1' } }, 'Вы искали'),
              h('button.text-btn', { attrs: { type: 'button' }, onclick: async () => {
                await call('kvSet', { key: HISTORY_KEY, value: null });
                showIdle();
              } }, 'Очистить'),
            ),
            ...history.map((q) =>
              listItem({
                icon: 'clock',
                title: q,
                onClick: () => submit(q),
                trailing: iconButton('close', `Удалить «${q}» из истории`, async (e) => {
                  e.stopPropagation();
                  await removeHistory(q);
                  showIdle();
                }, 'faint'),
              }),
            ),
          ]
        : emptyState('search', 'Что послушаем?', app.online.peek() ? 'Ищите треки, альбомы и исполнителей.' : 'Поиск работает только с сетью.'),
    );
  };

  const showSuggestions = debounce(async (q: string) => {
    if (!q.trim() || q !== input.value || q.trim() === query) return;
    const list = await suggestions(q).catch(() => [] as string[]);
    if (q !== input.value || q.trim() === query) return;
    renderChips(false);
    replaceChildren(body, list.map((s) => listItem({ icon: 'search', title: s, onClick: () => submit(s), trailing: icon('chevron-right', 'sm faint') })));
  }, 180);

  const renderItems = (items: SearchItem[], target: HTMLElement) => {
    for (const item of items) {
      if (item.track) {
        const track = item.track;
        tracks.push(track);
        const index = tracks.length - 1;
        target.appendChild(trackRow(track, { onPlay: () => playTracks(tracks, index, { kind: 'list', title: `Поиск: ${query}` }), onMore: () => openTrackMenu(track) }));
      } else if (item.collection) target.appendChild(collectionRow(item.collection));
      else if (item.artist) target.appendChild(artistRow(item.artist));
    }
  };

  const loadShelves = (q: string, id: number, target: HTMLElement) => {
    for (const [kind, title] of [['playlists', 'Плейлисты'], ['albums', 'Альбомы']] as const) {
      const shelf = h('section.section');
      target.appendChild(shelf);
      search(q, kind)
        .then((res) => {
          const items = res.items.filter((i) => i.collection).slice(0, 12);
          if (id !== requestId || !items.length) return;
          replaceChildren(shelf, sectionHead(title, () => {
            filter = kind;
            runSearch(q);
          }), h('div.scroll-x', null, items.map((i) => collectionCard(i.collection!))));
        })
        .catch(() => undefined);
    }
  };

  const runSearch = async (q: string) => {
    query = q;
    const id = ++requestId;
    tracks = [];
    renderChips(true);
    replaceChildren(body, skeletonRows(8));
    try {
      const res = await search(q, filter);
      if (id !== requestId) return;
      nextPage = res.nextPage;
      resultList = h('div.list');
      if (filter === 'all') {
        // Tracks first, then playlist and album rows, then the rest of the tracks (infinite scroll continues there).
        const trackItems = res.items.filter((i) => i.track);
        const artists = res.items.filter((i) => i.artist);
        const head = h('div.list');
        renderItems(trackItems.slice(0, TOP_TRACKS), head);
        const shelves = h('div');
        renderItems(trackItems.slice(TOP_TRACKS), resultList);
        replaceChildren(body, res.items.length ? [head, shelves, artists.length ? h('div.list', null, artists.map((a) => artistRow(a.artist!))) : null, trackItems.length > TOP_TRACKS ? sectionHead('Ещё треки') : null, resultList] : emptyState('search', 'Ничего не нашлось', 'Попробуйте другой запрос или фильтр.'));
        loadShelves(q, id, shelves);
        return;
      }
      renderItems(res.items, resultList);
      replaceChildren(body, res.items.length ? resultList : emptyState('search', 'Ничего не нашлось', 'Попробуйте другой запрос или фильтр.'));
    } catch (e) {
      if (id !== requestId) return;
      const err = e as BridgeError;
      replaceChildren(
        body,
        emptyState(
          app.online.peek() ? 'alert' : 'offline',
          app.online.peek() ? 'Поиск не удался' : 'Нет сети',
          err.message,
          err.code === 'extraction' ? button('Обновить приложение', () => call('openUrl', { text: RELEASES_URL }), { cls: 'primary' }) : button('Повторить', () => runSearch(q)),
        ),
      );
    }
  };

  const submit = (q: string) => {
    q = q.trim();
    if (!q) return;
    input.value = q;
    input.blur();
    clearBtn.hidden = false;
    pushHistory(q);
    runSearch(q);
  };

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    query = '';
    requestId++;
    if (!input.value.trim()) showIdle();
    else showSuggestions(input.value);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit(input.value));

  screen.addEventListener(
    'scroll',
    async () => {
      if (!nextPage || loadingMore || !resultList) return;
      if (screen.scrollTop + screen.clientHeight < screen.scrollHeight - 800) return;
      loadingMore = true;
      const id = requestId;
      try {
        const res = await search(query, filter, nextPage);
        if (id === requestId) {
          nextPage = res.nextPage;
          renderItems(res.items, resultList);
        }
      } catch {
        nextPage = null;
      } finally {
        loadingMore = false;
      }
    },
    { passive: true },
  );

  scope.add(() => (requestId = -1));
  showIdle();
  setTimeout(() => input.focus(), 250);
  return screen;
});
