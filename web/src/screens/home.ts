import { defineRoute, navigate } from '../app/router';
import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { h, icon, replaceChildren } from '../core/dom';
import { track, type Scope } from '../core/signal';
import { app, currentTrack, player, type Settings } from '../core/store';
import { RECO_FILTERS, toggleFilter } from '../logic/filters';
import { hooks, runHooks } from '../mods/registry';
import { adoptSourceMeta, findTrack, related } from '../services/catalog';
import { createWave, isWaveActive, playTracks, playWave, restyleWave, resumeWave, togglePlay } from '../services/playback';
import { forgetWave, savedWaves } from '../services/waves';
import { saveSettings } from '../services/settings';
import { button, chip, emptyState, iconButton, playButton, sectionHead, skeletonCards, skeletonRows, trackCover } from '../ui/components';
import { actionSheet, promptSheet } from '../ui/sheet';
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

/** Mode pill inside the stream row: shows the current mode, opens the list of modes. */
function modeFilter(scope: Scope): HTMLElement {
  const label = h('span');
  const btn = h('button.filter-pill', { attrs: { 'aria-label': 'Режим рекомендаций' }, onclick: () => {
    const current = app.settings.peek().waveMode;
    actionSheet(
      h('div.h2', null, 'Рекомендации'),
      MODES.map(([id, title, sub]) => ({
        icon: id === current ? 'check' : 'wave',
        label: title,
        sub,
        run: () => {
          if (id === app.settings.peek().waveMode) return;
          void applyReco({ waveMode: id });
        },
      })),
    );
  } }, icon('tune', 'sm'), label);
  scope.effect(() => (label.textContent = modeLabel(app.settings.value.waveMode)));
  return btn;
}

/** Compact endless-stream row: play / pause the stream of the selected mode. */
function streamRow(scope: Scope): HTMLElement {
  const inStream = () => player.context.value?.kind === 'wave';
  const btn = playButton(scope, {
    size: 'sm',
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
  const sub = h('div.row-sub.ellipsis');
  scope.effect(() => {
    const t = currentTrack.value;
    if (player.preparing.value) {
      sub.textContent = 'Подбираем треки…';
      return;
    }
    sub.textContent = t && inStream() ? `${t.artist} — ${t.title}` : 'Бесконечно, под ваш вкус';
  });
  return h(
    'div.stream-row',
    { onclick: (e: MouseEvent) => !(e.target as HTMLElement).closest('button') && btn.click() },
    btn,
    h('div.row-main', null, h('div.row-title', null, 'Рекомендации'), sub),
    modeFilter(scope),
  );
}

async function loadRecommendations(): Promise<Track[]> {
  if (recoCache) return recoCache;
  const wave = createWave();
  const tracks = await runHooks(hooks.recommendations, await wave.next(12), { source: 'home' });
  recoCache = tracks;
  return tracks;
}

function skeletonGrid(n: number): HTMLElement {
  return h('div.card-grid', null, Array.from({ length: n }, () => h('div.card', null, h('div.skeleton.square'), h('div.skeleton.line', { style: { width: '80%' } }))));
}

/** Main content of the home screen: a grid of recommendations for the selected mode. */
function recommendationsSection(scope: Scope): HTMLElement {
  const body = h('div', null, skeletonGrid(4));
  const reload = () => {
    replaceChildren(body, skeletonGrid(4));
    loadRecommendations()
      .then((tracks) => {
        if (!tracks.length) {
          replaceChildren(body, h('div.pad.muted.small', null, 'Лайкните несколько треков — и здесь появятся рекомендации.'));
          return;
        }
        const ctx = { kind: 'list' as const, title: 'Рекомендации' };
        replaceChildren(
          body,
          h('div.card-grid', null, tracks.map((t, i) => trackCard(t, () => playTracks(tracks, i, ctx)))),
          h('div.pad', { style: { marginTop: 'var(--s-3)' } }, button('Обновить подборку', () => {
            recoCache = null;
            reload();
          }, { cls: 'ghost block', icon: 'sparkle' })),
        );
      })
      .catch(() => replaceChildren(body, h('div.pad.muted.small', null, 'Не удалось загрузить рекомендации.')));
  };
  scope.effect(() => {
    track(app.settings);
    if (app.online.value) reload();
  });
  return h('section.section.first', null, sectionHead('Для вас'), streamRow(scope), filtersRow(scope), body);
}

/** Settings change of recommendations: the grid reloads, a playing stream swaps its upcoming songs. */
async function applyReco(patch: Partial<Settings>): Promise<void> {
  recoCache = null;
  await saveSettings(patch);
  if (isWaveActive()) void restyleWave();
}

/** Filter chips under the stream row. They combine; the user's own wishes in words need a model. */
function filtersRow(scope: Scope): HTMLElement {
  const row = h('div.chips.reco-filters');
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
    replaceChildren(
      row,
      RECO_FILTERS.map((f) => chip(f.label, s.recoFilters.includes(f.id), () => void applyReco({ recoFilters: toggleFilter(app.settings.peek().recoFilters, f.id) }))),
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
        : null,
      h('button.chip', { attrs: { 'aria-label': 'Свой фильтр' }, onclick: addCustom }, icon('plus', 'sm'), 'Свой'),
    );
  });
  return row;
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

function chartSection(scope: Scope): HTMLElement {
  const box = h('section.section');
  const body = h('div', null, skeletonCards(4));
  replaceChildren(box, sectionHead('Чарт'), body);
  let loaded = false;
  scope.effect(() => {
    const online = app.online.value;
    if (!online || loaded) return;
    loaded = true;
    loadChart()
      .then((tracks) => {
        box.hidden = !tracks.length;
        const ctx = { kind: 'list' as const, title: 'Чарт' };
        replaceChildren(body, h('div.scroll-x', null, tracks.map((t, i) => trackCard(t, () => playTracks(tracks, i, ctx)))));
      })
      .catch(() => (box.hidden = true));
  });
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

defineRoute('home', ({ scope }) => {
  const screen = h('div.screen');
  const banner = h('div.banner', null, icon('offline'), 'Нет сети. Играет скачанное и ваши файлы.');
  scope.effect(() => (banner.hidden = app.online.value));
  screen.append(
    h('div', { style: { height: 'var(--safe-top)' } }),
    h('div.page-head', null, h('h1.h1', null, 'Главная'), iconButton('settings', 'Настройки', () => navigate('settings'))),
    banner,
    offlineSection(scope, screen),
    recommendationsSection(scope),
    continueSection(scope),
    chartSection(scope),
    similarSection(scope, screen),
    recentSection(scope),
  );
  return screen;
});
