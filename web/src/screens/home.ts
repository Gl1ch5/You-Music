import { defineRoute, navigate } from '../app/router';
import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { h, icon, replaceChildren } from '../core/dom';
import { track, type Scope } from '../core/signal';
import { app, currentTrack, player, type Settings } from '../core/store';
import { Wave } from '../logic/recommend';
import { hooks, runHooks } from '../mods/registry';
import { related } from '../services/catalog';
import { isWaveActive, playTracks, playWave, recoSource, togglePlay } from '../services/playback';
import { saveSettings } from '../services/settings';
import { chip, emptyState, iconButton, likeButton, playButton, sectionHead, skeletonCards, skeletonRows, trackCover } from '../ui/components';
import { trackList } from '../ui/trackList';

const MODES: [Settings['waveMode'], string][] = [
  ['mix', 'Микс'],
  ['familiar', 'Любимое'],
  ['discover', 'Открытия'],
];

let recoCache: Track[] | null = null;

export function trackCard(track: Track, onClick: () => void): HTMLElement {
  return h('div.card', { onclick: onClick, dataset: { trackId: track.id } }, trackCover(track, 'md'), h('div.card-title.ellipsis', null, track.title), h('div.card-sub.ellipsis', null, track.artist));
}

function waveHero(scope: Scope): HTMLElement {
  const rings = h('div.wave-rings', null, h('i'), h('i'), h('i'));
  const btn = playButton(scope, {
    size: 'lg',
    playing: () => player.playing.value && player.context.value?.kind === 'wave',
    onToggle: () => (isWaveActive() ? togglePlay() : playWave()),
  });
  const pill = h('div.now-pill');
  const modes = h('div.chips', { style: { justifyContent: 'center', padding: '0' } });

  scope.effect(() => {
    rings.classList.toggle('paused', !(player.playing.value && player.context.value?.kind === 'wave'));
    const t = currentTrack.value;
    const inWave = player.context.value?.kind === 'wave';
    pill.hidden = !(t && inWave);
    if (t && inWave) replaceChildren(pill, h('span.ellipsis', null, `${t.artist} — ${t.title}`), likeButton(scope, () => currentTrack.peek()));
  });
  scope.effect(() => {
    const mode = app.settings.value.waveMode;
    replaceChildren(
      modes,
      MODES.map(([id, label]) =>
        chip(label, id === mode, () => {
          saveSettings({ waveMode: id });
          recoCache = null;
        }),
      ),
    );
  });

  return h('div.wave-hero', null, rings, h('div.wave-title', null, 'Волна'), h('div.muted.small', null, 'Бесконечный поток под ваш вкус'), btn, pill, modes);
}

async function loadRecommendations(): Promise<Track[]> {
  if (recoCache) return recoCache;
  const wave = new Wave(recoSource, app.settings.peek().waveMode);
  const tracks = await runHooks(hooks.recommendations, await wave.next(16), { source: 'home' });
  recoCache = tracks;
  return tracks;
}

function recommendationsSection(scope: Scope): HTMLElement {
  const body = h('div', null, skeletonCards(4));
  const reload = () => {
    replaceChildren(body, skeletonCards(4));
    loadRecommendations()
      .then((tracks) => {
        if (!tracks.length) {
          replaceChildren(body, h('div.pad.muted.small', null, 'Лайкните несколько треков — и здесь появятся рекомендации.'));
          return;
        }
        replaceChildren(body, h('div.scroll-x', null, tracks.map((t, i) => trackCard(t, () => playTracks(tracks, i, { kind: 'list', title: 'Рекомендации' })))));
      })
      .catch(() => replaceChildren(body, h('div.pad.muted.small', null, 'Не удалось загрузить рекомендации.')));
  };
  scope.effect(() => {
    track(app.settings);
    if (app.online.value) reload();
  });
  const head = h('div.section-head', null, h('h2.h2', { style: { flex: '1' } }, 'Рекомендации'), iconButton('sparkle', 'Обновить', () => {
    recoCache = null;
    reload();
  }));
  return h('section.section', null, head, body);
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
    waveHero(scope),
    offlineSection(scope, screen),
    recommendationsSection(scope),
    similarSection(scope, screen),
    recentSection(scope),
  );
  return screen;
});
