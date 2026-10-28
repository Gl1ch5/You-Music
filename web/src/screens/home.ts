import { defineRoute, navigate } from '../app/router';
import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { h, icon, replaceChildren } from '../core/dom';
import { track, type Scope } from '../core/signal';
import { app, currentTrack, player, type Settings } from '../core/store';
import { Wave } from '../logic/recommend';
import { hooks, runHooks } from '../mods/registry';
import { related } from '../services/catalog';
import { aiSuggest, type AiPick } from '../services/ai';
import { isWaveActive, playTracks, playWave, recoSource, togglePlay } from '../services/playback';
import { saveSettings } from '../services/settings';
import { button, emptyState, iconButton, playButton, sectionHead, skeletonCards, skeletonRows, trackCover } from '../ui/components';
import { actionSheet } from '../ui/sheet';
import { trackList } from '../ui/trackList';

const MODES: [Settings['waveMode'], string, string][] = [
  ['mix', 'Микс', 'Любимое вперемешку с новым'],
  ['familiar', 'Любимое', 'Ближе к тому, что вы уже слушаете'],
  ['discover', 'Открытия', 'Больше новых исполнителей'],
  ['neuro', 'Нейро', 'Подбирает нейросеть'],
];

const modeLabel = (mode: Settings['waveMode']) => MODES.find(([id]) => id === mode)?.[1] ?? 'Микс';

let recoCache: Track[] | null = null;

export function trackCard(track: Track, onClick: () => void): HTMLElement {
  return h('div.card', { onclick: onClick, dataset: { trackId: track.id } }, trackCover(track, 'md'), h('div.card-title.ellipsis', null, track.title), h('div.card-sub.ellipsis', null, track.artist));
}

/** Small "filter" pill: shows the current mode, opens the list of modes. */
function modeFilter(scope: Scope): HTMLElement {
  const label = h('span');
  const btn = h('button.filter-pill', { attrs: { 'aria-label': 'Режим рекомендаций' }, onclick: () => {
    const current = app.settings.peek().waveMode;
    const modes = app.aiEnabled.peek() ? MODES : MODES.filter(([id]) => id !== 'neuro');
    actionSheet(
      h('div.h2', null, 'Рекомендации'),
      modes.map(([id, title, sub]) => ({
        icon: id === current ? 'check' : id === 'neuro' ? 'sparkle' : 'wave',
        label: title,
        sub,
        run: () => {
          if (id === app.settings.peek().waveMode) return;
          recoCache = null;
          saveSettings({ waveMode: id });
        },
      })),
    );
  } }, icon('filter', 'sm'), label);
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
      sub.textContent = app.settings.peek().waveMode === 'neuro' ? 'Нейросеть подбирает треки…' : 'Подбираем треки…';
      return;
    }
    sub.textContent = t && inStream() ? `${t.artist} — ${t.title}` : `${modeLabel(app.settings.value.waveMode)} · бесконечно, под ваш вкус`;
  });
  return h('div.stream-row', { onclick: (e: MouseEvent) => !(e.target as HTMLElement).closest('button') && btn.click() }, btn, h('div.row-main', null, h('div.row-title', null, 'Слушать поток'), sub));
}

async function loadRecommendations(): Promise<Track[]> {
  if (recoCache) return recoCache;
  const mode = app.settings.peek().waveMode;
  const wave = new Wave(recoSource, mode === 'neuro' ? 'mix' : mode);
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
  const head = h('div.section-head', null, h('h2.h2', { style: { flex: '1' } }, 'Для вас'), modeFilter(scope));
  return h('section.section.first', null, head, streamRow(scope), body);
}

let aiCache: AiPick[] | null = null;

function neuroSection(scope: Scope): HTMLElement {
  const body = h('div');
  const box = h('section.section');
  const load = (force = false) => {
    if (force) aiCache = null;
    replaceChildren(body, skeletonCards(4));
    (aiCache ? Promise.resolve(aiCache) : aiSuggest(recoSource, 12))
      .then((picks) => {
        aiCache = picks;
        const tracks = picks.map((p) => p.track);
        replaceChildren(
          body,
          tracks.length
            ? h(
                'div.scroll-x',
                null,
                picks.map((p, i) => {
                  const card = trackCard(p.track, () => playTracks(tracks, i, { kind: 'list', title: 'Нейро-подборка' }));
                  if (p.reason) card.appendChild(h('div.card-sub.ellipsis.faint', null, p.reason));
                  return card;
                }),
              )
            : h('div.pad.muted.small', null, 'Нейросеть ничего не предложила — попробуйте обновить.'),
        );
      })
      .catch((e) => replaceChildren(body, h('div.pad.muted.small', null, `Нейросеть недоступна: ${(e as Error).message}`)));
  };
  scope.effect(() => {
    const on = app.aiEnabled.value && app.online.value;
    box.hidden = !on;
    if (on) load();
  });
  replaceChildren(box, h('div.section-head', null, h('h2.h2', { style: { flex: '1' } }, 'Нейро-подборка'), iconButton('sparkle', 'Обновить', () => load(true))), body);
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
    neuroSection(scope),
    similarSection(scope, screen),
    recentSection(scope),
  );
  return screen;
});
