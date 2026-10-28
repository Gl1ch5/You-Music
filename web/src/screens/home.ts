import { defineRoute, navigate } from '../app/router';
import { call } from '../bridge/bridge';
import type { Collection, Track } from '../bridge/contract';
import { h, icon, replaceChildren } from '../core/dom';
import { Scope, track } from '../core/signal';
import { app, currentTrack, player, type Settings } from '../core/store';
import { RECO_FILTERS, toggleFilter } from '../logic/filters';
import { hooks, runHooks } from '../mods/registry';
import { adoptSourceMeta, findTrack, related } from '../services/catalog';
import { createWave, isWaveActive, playTrackWave, playTracks, playWave, restyleWave, resumeWave, togglePlay } from '../services/playback';
import { forgetWave, savedWaves } from '../services/waves';
import { saveSettings } from '../services/settings';
import { button, chip, emptyState, haptic, iconButton, playButton, sectionHead, skeletonCards, skeletonRows, trackCover, trackRow } from '../ui/components';
import { openTrackMenu } from '../ui/trackMenu';
import { collectionCard } from './search';
import { openSheet, promptSheet } from '../ui/sheet';
import { toast } from '../ui/toast';
import { trackList } from '../ui/trackList';

const MODES: [Settings['waveMode'], string, string][] = [
  ['mix', 'Микс', 'Любимое вперемешку с новым'],
  ['familiar', 'Любимое', 'Ближе к тому, что вы уже слушаете'],
  ['discover', 'Открытия', 'Больше новых исполнителей'],
];

const modeLabel = (mode: Settings['waveMode']) => MODES.find(([id]) => id === mode)?.[1] ?? 'Микс';

let recoCache: Track[] | null = null;

export function trackCard(track: Track, onClick: () => void): HTMLElement {
  return h('div.card', { onclick: onClick, dataset: { trackId: track.id } }, trackCover(track, 'md'), h('div.card-title.clamp-2', null, track.title), h('div.card-sub.ellipsis', null, track.artist));
}

/** Number of active filters (mode other than "Микс" counts too), shown on the "Фильтры" button. */
function activeFilterCount(s: Settings): number {
  return s.recoFilters.length + s.recoCustomActive.length + (s.waveMode === 'mix' ? 0 : 1);
}

/**
 * The recommendations hero: a large animated orb with the play button in the middle and one "Фильтры" button
 * that holds the mode and every filter.
 */
function recoHero(scope: Scope): HTMLElement {
  const inStream = () => player.context.value?.kind === 'wave';
  const btn = playButton(scope, {
    size: 'lg',
    playing: () => {
      const on = inStream();
      const prep = player.preparing.value;
      return (player.wantsPlay.value && on) || prep;
    },
    loading: () => {
      const on = inStream();
      const prep = player.preparing.value;
      return (player.buffering.value && player.wantsPlay.value && on) || prep;
    },
    onToggle: () => (isWaveActive() ? togglePlay() : playWave()),
  });
  const sub = h('div.reco-sub.ellipsis');
  const count = h('span.filter-count');
  const filters = h('button.filter-pill.big', { attrs: { 'aria-label': 'Фильтры рекомендаций' }, onclick: () => openFilters() }, icon('tune', 'sm'), h('span', null, 'Фильтры'), count);
  const orb = h('div.reco-orb', { attrs: { 'aria-hidden': 'true' } }, h('i.b1'), h('i.b2'), h('i.b3'));
  const hero = h('section.reco-hero', null, orb, h('div.reco-center', null, btn, h('div.reco-title', null, 'Рекомендации'), sub, filters));
  scope.effect(() => {
    const t = currentTrack.value;
    const prep = player.preparing.value;
    const on = inStream();
    const playing = player.wantsPlay.value;
    const s = app.settings.value;
    hero.classList.toggle('on', on && playing);
    const n = activeFilterCount(s);
    count.textContent = n ? String(n) : '';
    count.hidden = !n;
    if (prep) sub.textContent = 'Подбираем треки…';
    else if (t && on) sub.textContent = `${t.artist} — ${t.title}`;
    else sub.textContent = `${modeLabel(s.waveMode)} · бесконечно, под ваш вкус`;
  });
  return hero;
}

/** One sheet for the mode and all filters; every change applies at once. */
function openFilters(): void {
  const scope = new Scope();
  const body = h('div.filters-sheet');
  const addCustom = async () => {
    if (!app.aiEnabled.peek()) return toast('Свои фильтры понимает только нейросеть — подключите её в настройках или войдите в аккаунт', { icon: 'sparkle' });
    const text = (await promptSheet({ title: 'Свой фильтр', placeholder: 'Например: грустное, для бега, 80-е', ok: 'Добавить' }))?.trim();
    if (!text) return;
    const s = app.settings.peek();
    await applyReco({ recoCustom: [...new Set([...s.recoCustom, text])].slice(-12), recoCustomActive: [...new Set([...s.recoCustomActive, text])] });
  };
  scope.effect(() => {
    const s = app.settings.value;
    const ai = app.aiEnabled.value;
    const group = (title: string, hint: string | null, ...items: (HTMLElement | HTMLElement[] | null)[]) =>
      h('div.filters-group', null, h('div.filters-title', null, title), hint ? h('div.small.muted', null, hint) : null, h('div.chips.wrap', null, ...items));
    replaceChildren(
      body,
      group('Режим', null, MODES.map(([id, title]) => chip(title, s.waveMode === id, () => void applyReco({ waveMode: id })))),
      group('Подбор', 'Можно выбрать несколько', RECO_FILTERS.map((f) => chip(f.label, s.recoFilters.includes(f.id), () => void applyReco({ recoFilters: toggleFilter(app.settings.peek().recoFilters, f.id) })))),
      group(
        'Свои',
        ai ? 'Опишите словами — поймёт нейросеть. Удерживайте, чтобы удалить.' : 'Свои фильтры работают с нейросетью.',
        ai
          ? s.recoCustom.map((text) => {
              const c = chip(text, s.recoCustomActive.includes(text), () => {
                const active = app.settings.peek().recoCustomActive;
                void applyReco({ recoCustomActive: active.includes(text) ? active.filter((x) => x !== text) : [...active, text] });
              });
              c.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const cur = app.settings.peek();
                void applyReco({ recoCustom: cur.recoCustom.filter((x) => x !== text), recoCustomActive: cur.recoCustomActive.filter((x) => x !== text) });
                toast(`Фильтр «${text}» удалён`);
              });
              return c;
            })
          : [],
        h('button.chip', { attrs: { 'aria-label': 'Свой фильтр' }, onclick: addCustom }, icon('plus', 'sm'), 'Свой'),
      ),
      activeFilterCount(s)
        ? button('Сбросить всё', () => void applyReco({ waveMode: 'mix', recoFilters: [], recoCustomActive: [] }), { cls: 'ghost block' })
        : null,
    );
  });
  openSheet({ header: h('div.h2', null, 'Фильтры'), content: body, onClose: () => scope.dispose() });
}

async function loadRecommendations(): Promise<Track[]> {
  if (recoCache) return recoCache;
  const wave = createWave();
  const tracks = await runHooks(hooks.recommendations, await wave.next(12), { source: 'home' });
  recoCache = tracks;
  return tracks;
}

/** Tracks of the current recommendations, as a row of cards under the hero. */
function recommendationsSection(scope: Scope): HTMLElement {
  const body = h('div', null, skeletonCards(4));
  const head = h('div.section-head', null, h('h2.h2', { style: { flex: '1' } }, 'Треки для вас'), iconButton('refresh', 'Обновить подборку', () => {
    recoCache = null;
    haptic('light');
    reload();
  }));
  const reload = () => {
    replaceChildren(body, skeletonCards(4));
    loadRecommendations()
      .then((tracks) => {
        if (!tracks.length) {
          replaceChildren(body, h('div.pad.muted.small', null, 'Лайкните несколько треков — и здесь появятся рекомендации.'));
          return;
        }
        const ctx = { kind: 'list' as const, title: 'Рекомендации' };
        replaceChildren(body, h('div.scroll-x', null, tracks.map((t, i) => trackCard(t, () => playTracks(tracks, i, ctx)))));
      })
      .catch(() => replaceChildren(body, h('div.pad.muted.small', null, 'Не удалось загрузить рекомендации.')));
  };
  scope.effect(() => {
    track(app.settings);
    if (app.online.value) reload();
  });
  return h('section.section', null, head, body);
}

/** Settings change of recommendations: the grid reloads, a playing stream swaps its upcoming songs. */
async function applyReco(patch: Partial<Settings>): Promise<void> {
  recoCache = null;
  await saveSettings(patch);
  if (isWaveActive()) void restyleWave();
}

const CHART_KEY = 'cache.chart';
const CHART_TTL = 12 * 3600_000;

async function loadChart(): Promise<Track[]> {
  const raw = await call('kvGet', { key: CHART_KEY }).catch(() => null);
  try {
    const cached = raw ? (JSON.parse(raw) as { at: number; tracks: Track[] }) : null;
    if (cached && Date.now() - cached.at < CHART_TTL && cached.tracks.length) return cached.tracks;
  } catch {
    /* rebuilt below */
  }
  const list = await call('chart', { source: 'yandex' });
  const top = list.tracks.slice(0, 20);
  const found: (Track | null)[] = new Array(top.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < top.length) {
      const i = next++;
      const match = await findTrack(top[i]).catch(() => null);
      found[i] = match && adoptSourceMeta(match, top[i]);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  const tracks = [...new Map(found.filter((t): t is Track => !!t).map((t) => [t.id, t])).values()];
  if (tracks.length) void call('kvSet', { key: CHART_KEY, value: JSON.stringify({ at: Date.now(), tracks }) });
  return tracks;
}

/** Chart pane: numbered positions, like a real chart. */
function chartPane(scope: Scope): HTMLElement {
  const box = h('div.pane');
  replaceChildren(box, skeletonRows(8));
  let loaded = false;
  scope.effect(() => {
    const online = app.online.value;
    if (!online || loaded) return;
    loaded = true;
    loadChart()
      .then((tracks) => {
        if (!tracks.length) return replaceChildren(box, emptyState('chart', 'Чарт недоступен', 'Попробуйте позже.'));
        const ctx = { kind: 'list' as const, title: 'Чарт' };
        replaceChildren(
          box,
          h(
            'div.pane-head',
            null,
            h('div', { style: { flex: '1' } }, h('div.h2', null, 'Топ недели'), h('div.small.muted', null, `Яндекс Музыка · ${tracks.length} треков`)),
            button('Слушать', () => playTracks(tracks, 0, ctx), { cls: 'primary', icon: 'play' }),
          ),
          h(
            'div.chart-list',
            null,
            tracks.map((t, i) => h('div.chart-item', null, h('span.chart-pos.num', { dataset: { top: String(i < 3) } }, String(i + 1)), trackRow(t, { onPlay: () => playTracks(tracks, i, ctx), onMore: () => openTrackMenu(t) }))),
          ),
        );
      })
      .catch(() => replaceChildren(box, emptyState('offline', 'Чарт недоступен', 'Нужна сеть — попробуйте позже.')));
  });
  return box;
}

/** Recommended playlists: personal mixes from the most liked artists and popular YouTube Music playlists. */
const SHELVES: [string, string][] = [
  ['Хиты сейчас', 'хиты 2026 плейлист'],
  ['Русские хиты', 'русские хиты плейлист'],
  ['Чилл', 'chill плейлист'],
  ['Для тренировки', 'музыка для тренировки плейлист'],
  ['Рэп', 'русский рэп плейлист'],
  ['Рок', 'rock classics playlist'],
];
const shelfCache = new Map<string, Promise<Collection[]>>();

function shelf(title: string, query: string): HTMLElement {
  const box = h('section.section', null, sectionHead(title), skeletonCards(3));
  let p = shelfCache.get(query);
  if (!p) {
    p = call('search', { query, filter: 'playlists' }).then((r) => r.items.map((x) => x.collection).filter((c): c is Collection => !!c).slice(0, 10));
    p.catch(() => shelfCache.delete(query));
    shelfCache.set(query, p);
  }
  p.then((list) => {
    if (!list.length) return (box.hidden = true);
    replaceChildren(box, sectionHead(title), h('div.scroll-x', null, list.map(collectionCard)));
  }).catch(() => (box.hidden = true));
  return box;
}

function mixesSection(scope: Scope): HTMLElement {
  const box = h('section.section.first');
  scope.effect(() => {
    const likes = app.likes.value;
    // The most liked artists, each with their latest liked song as the seed of a wave.
    const byArtist = new Map<string, { name: string; seed: Track; n: number }>();
    for (const l of likes) {
      if (l.track.source !== 'yt') continue;
      const name = l.track.artist.split(/,|&| feat\.? | ft\.? /i)[0].trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const cur = byArtist.get(key);
      if (cur) cur.n++;
      else byArtist.set(key, { name, seed: l.track, n: 1 });
    }
    const top = [...byArtist.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    box.hidden = !top.length;
    if (!top.length) return;
    replaceChildren(
      box,
      sectionHead('Ваши миксы'),
      h('div.scroll-x', null, top.map((a) => h('div.card.mix-card', { onclick: () => playTrackWave(a.seed) }, h('div.mix-cover', null, trackCover(a.seed, 'md'), h('span.mix-label', null, 'Микс')), h('div.card-title.ellipsis', null, a.name), h('div.card-sub.ellipsis', null, 'Волна по исполнителю')))),
    );
  });
  return box;
}

function playlistsPane(scope: Scope): HTMLElement {
  const box = h('div.pane');
  const shelves = h('div');
  let loaded = false;
  scope.effect(() => {
    const online = app.online.value;
    if (!online || loaded) return;
    loaded = true;
    replaceChildren(shelves, SHELVES.map(([title, q]) => shelf(title, q)));
  });
  box.append(mixesSection(scope), shelves);
  return box;
}

function continueSection(scope: Scope): HTMLElement {
  const box = h('section.section');
  scope.effect(() => {
    const list = savedWaves.value.filter((w) => w.played.length >= 5).slice(0, 6);
    box.hidden = !list.length;
    if (!list.length) return;
    replaceChildren(
      box,
      sectionHead('Продолжить волну'),
      h(
        'div.scroll-x',
        null,
        list.map((w) => {
          const cover = w.seed ?? w.played[w.played.length - 1];
          const card = h('div.card', { onclick: () => resumeWave(w) }, trackCover(cover, 'md'), h('div.card-title.clamp-2', null, w.title), h('div.card-sub.ellipsis', null, `Прослушано ${w.played.length}`));
          card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            forgetWave(w.id);
          });
          return card;
        }),
      ),
    );
  });
  return box;
}

function similarSection(scope: Scope, screen: HTMLElement): HTMLElement {
  const box = h('section.section');
  scope.effect(() => {
    const seed = app.likes.value[0]?.track;
    if (!seed || !app.online.value || seed.source !== 'yt') {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    replaceChildren(box, sectionHead(`Похоже на «${seed.title}»`), skeletonRows(4));
    related(seed)
      .then((tracks) => {
        const list = tracks.filter((t) => t.durationMs < 15 * 60_000).slice(0, 6);
        replaceChildren(box, sectionHead(`Похоже на «${seed.title}»`), trackList(scope, { tracks: list, scroller: screen, context: { kind: 'list', title: `Похоже на «${seed.title}»` } }));
      })
      .catch(() => (box.hidden = true));
  });
  return box;
}

function recentSection(scope: Scope): HTMLElement {
  const box = h('section.section');
  const load = () =>
    call('history', { limit: 60 })
      .then((entries) => {
        const seen = new Set<string>();
        const tracks = entries.map((e) => e.track).filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 12);
        box.hidden = !tracks.length;
        replaceChildren(box, sectionHead('Недавно слушали', () => navigate('history')), h('div.scroll-x', null, tracks.map((t, i) => trackCard(t, () => playTracks(tracks, i, { kind: 'list', title: 'Недавно слушали' })))));
      })
      .catch(() => (box.hidden = true));
  scope.effect(() => {
    track(currentTrack);
    load();
  });
  return box;
}

function offlineSection(scope: Scope, screen: HTMLElement): HTMLElement {
  const box = h('section.section');
  scope.effect(() => {
    const offline = !app.online.value;
    box.hidden = !offline;
    if (!offline) return;
    const downloaded = [...app.downloads.value.values()].filter((d) => d.status === 'done' && d.track).map((d) => d.track!);
    replaceChildren(
      box,
      sectionHead('Доступно офлайн'),
      downloaded.length
        ? trackList(scope, { tracks: downloaded, scroller: screen, context: { kind: 'list', title: 'Скачанное' } })
        : emptyState('download', 'Ничего не скачано', 'Скачивайте треки и плейлисты, чтобы слушать их без сети.'),
    );
  });
  return box;
}

const PANES = [
  ['foryou', 'Для вас'],
  ['chart', 'Чарт'],
  ['playlists', 'Подборки'],
] as const;
type PaneId = (typeof PANES)[number][0];
let lastPane: PaneId = 'foryou';

defineRoute('home', ({ scope }) => {
  const screen = h('div.screen');
  const banner = h('div.banner', null, icon('offline'), 'Нет сети. Играет скачанное и ваши файлы.');
  scope.effect(() => (banner.hidden = app.online.value));
  const holder = h('div');
  const built = new Map<PaneId, HTMLElement>();
  const build = (id: PaneId): HTMLElement => {
    if (id === 'chart') return chartPane(scope);
    if (id === 'playlists') return playlistsPane(scope);
    return h('div.pane', null, offlineSection(scope, screen), recoHero(scope), continueSection(scope), recommendationsSection(scope), similarSection(scope, screen), recentSection(scope));
  };
  const tabs = h('div.segmented', { attrs: { role: 'tablist' } });
  const show = (id: PaneId) => {
    lastPane = id;
    let pane = built.get(id);
    if (!pane) built.set(id, (pane = build(id)));
    replaceChildren(holder, pane);
    replaceChildren(
      tabs,
      PANES.map(([pid, label]) =>
        h(`button.segment${pid === id ? '.active' : ''}`, { attrs: { role: 'tab', 'aria-selected': String(pid === id) }, onclick: () => {
          if (pid === lastPane) return;
          haptic('light');
          show(pid);
          screen.scrollTo({ top: 0 });
        } }, label),
      ),
    );
  };
  screen.append(
    h('div', { style: { height: 'var(--safe-top)' } }),
    h('div.page-head', null, h('h1.h1', null, 'Главная'), iconButton('settings', 'Настройки', () => navigate('settings'))),
    tabs,
    banner,
    holder,
  );
  show(lastPane);
  return screen;
});
