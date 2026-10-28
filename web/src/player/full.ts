import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { h, icon, prefersReducedMotion, replaceChildren, swallowNextClick } from '../core/dom';
import { Scope } from '../core/signal';
import { currentTrack, livePosition, player } from '../core/store';
import { guard, slots } from '../mods/registry';
import { mutedGlow } from '../theme/engine';
import { artFor } from '../services/art';
import { related } from '../services/catalog';
import { download, removeDownload } from '../services/library';
import { expectLoading, next, playTrackWave, playTracks, previous, seek, togglePlay } from '../services/playback';
import { linkArtist } from '../ui/artistLink';
import { onBack } from '../ui/back';
import { button, emptyState, haptic, iconButton, likeButton, onFrame, playButton, progressBar, reactiveIcon, setCoverUrls, skeletonRows, trackCover, trackRow, cover } from '../ui/components';
import { applyDynamicBackground } from '../ui/hero';
import { openSheet } from '../ui/sheet';
import { openTrackMenu } from '../ui/trackMenu';
import { app } from '../core/store';

let root: HTMLElement;
let artBox: HTMLElement;
let removeBack: (() => void) | null = null;
let miniCoverRect: () => DOMRect | null = () => null;

export function setMiniCoverSource(fn: () => DOMRect | null): void {
  miniCoverRect = fn;
}

export function mountFullPlayer(): HTMLElement {
  const scope = new Scope();
  const bg = h('div.dyn-bg');
  const dim = h('div.dyn-dim');
  artBox = cover([], '', 'note');
  const glow = h('div.glow');
  const art = h('div.player-art', null, glow, artBox);
  const title = h('div.player-title.ellipsis');
  const artist = h('div.player-artist.ellipsis');
  linkArtist(artist, () => currentTrack.peek(), () => closePlayer());
  const context = h('div.player-context.ellipsis');

  const progress = progressBar(scope, (ms) => seek(ms));
  const repeatBtn = h('button.btn-icon', {
    attrs: { 'aria-label': 'Повтор' },
    onclick: () => {
      const order = ['off', 'all', 'one'] as const;
      const nextMode = order[(order.indexOf(player.repeat.peek()) + 1) % 3];
      call('setRepeat', { mode: nextMode });
      haptic();
    },
  }, reactiveIcon(scope, () => (player.repeat.value === 'one' ? 'repeat-one' : 'repeat')));
  const shuffleBtn = iconButton('shuffle', 'Перемешать', () => {
    call('setShuffle', { enabled: !player.shuffle.peek() });
    haptic();
  });
  scope.effect(() => {
    repeatBtn.classList.toggle('accent', player.repeat.value !== 'off');
    shuffleBtn.classList.toggle('accent', player.shuffle.value);
  });

  const action = (glyph: SVGElement, label: string | HTMLElement, onclick: () => void) =>
    h('button.action', { onclick, attrs: { 'aria-label': typeof label === 'string' ? label : 'Скачать' } }, glyph, typeof label === 'string' ? h('span', null, label) : label);
  const dlLabel = h('span');
  scope.effect(() => {
    const d = app.downloads.value.get(currentTrack.value?.id ?? '');
    dlLabel.textContent = d?.status === 'done' ? 'Скачано' : d ? `${Math.round(d.progress * 100)}%` : 'Скачать';
  });
  const fixedActions = [
    action(icon('queue'), 'Очередь', openQueue),
    action(icon('lyrics'), 'Текст', openLyrics),
    action(icon('similar'), 'Похожие', openSimilar),
    action(reactiveIcon(scope, () => (app.downloads.value.get(currentTrack.value?.id ?? '')?.status === 'done' ? 'downloaded' : 'download')), dlLabel, toggleDownload),
  ];
  const actions = h('div.player-actions');
  scope.effect(() => {
    const mods = slots.playerButtons.value.map((b) => action(icon(b.icon), b.label, () => guard(b.modId, b.onClick)(currentTrack.peek())));
    replaceChildren(actions, ...fixedActions, ...mods);
  });

  const head = h('div.player-head', null, iconButton('chevron-down', 'Свернуть', () => closePlayer()), context, iconButton('more', 'Действия', () => {
    const t = currentTrack.peek();
    if (t) openTrackMenu(t);
  }));

  const body = h(
    'div.player-body',
    null,
    head,
    art,
    h('div.player-meta', null, h('div', { style: { flex: '1', minWidth: '0' } }, title, artist), likeButton(scope, () => currentTrack.value)),
    progress.el,
    h('div.times', null, progress.elapsed, progress.remaining),
    h(
      'div.player-controls',
      null,
      shuffleBtn,
      iconButton('prev', 'Предыдущий', () => previous(), 'big on'),
      playButton(scope, { size: 'lg', playing: () => player.wantsPlay.value, loading: () => player.buffering.value && player.wantsPlay.value, onToggle: togglePlay }),
      iconButton('next', 'Следующий', () => next(), 'big on'),
      repeatBtn,
    ),
    actions,
  );

  root = h('div.player', { attrs: { 'aria-hidden': 'true' } }, bg, dim, body);

  let paletteScope = new Scope();
  scope.effect(() => {
    const t = currentTrack.value;
    title.textContent = t?.title ?? '';
    artist.textContent = t?.artist ?? '';
    context.textContent = player.context.value?.title ?? '';
    if (!t) return;
    const urls = artFor(t, 'lg');
    setCoverUrls(artBox, urls);
    paletteScope.dispose();
    paletteScope = new Scope();
    bg.classList.remove('ready');
    applyDynamicBackground(paletteScope, bg, urls[0], (color) => {
      const g = mutedGlow(color);
      if (g) root.style.setProperty('--glow', g);
    });
  });
  scope.effect(() => art.classList.toggle('paused', !player.wantsPlay.value));

  attachDragToClose(head, art);
  return root;
}

function toggleDownload(): void {
  const t = currentTrack.peek();
  if (!t || t.source !== 'yt') return;
  if (app.downloads.peek().has(t.id)) removeDownload(t.id);
  else download([t]);
}

/* ───────── Open / close with a shared cover ───────── */

function setY(y: number, animate: boolean): void {
  root.classList.toggle('animating', animate);
  root.style.transform = `translateY(${y}px)`;
}

export function openPlayer(): void {
  if (!currentTrack.peek()) return;
  swallowNextClick('.player');
  const height = window.innerHeight;
  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  player.fullOpen.value = true;
  removeBack ??= onBack(() => {
    closePlayer();
    return true;
  });
  const from = miniCoverRect();
  if (prefersReducedMotion() || !from) {
    setY(0, !prefersReducedMotion());
    return;
  }
  setY(height, false);
  void root.offsetHeight;
  const to = artBox.getBoundingClientRect();
  flyCover(from, new DOMRect(to.left, to.top - height, to.width, to.height));
  requestAnimationFrame(() => setY(0, true));
}

export function closePlayer(): void {
  if (!root.classList.contains('open')) return;
  const height = window.innerHeight;
  swallowNextClick();
  removeBack?.();
  removeBack = null;
  player.fullOpen.value = false;
  const to = miniCoverRect();
  if (to && !prefersReducedMotion()) {
    const from = artBox.getBoundingClientRect();
    flyCover(from, new DOMRect(to.left, to.top, to.width, to.height));
  }
  setY(height, true);
  setTimeout(() => {
    if (player.fullOpen.peek()) return;
    root.classList.remove('open', 'animating');
    root.setAttribute('aria-hidden', 'true');
  }, 360);
}

/** Clones the cover and moves it between two rects with a single transform transition. */
function flyCover(from: DOMRect, to: DOMRect): void {
  const t = currentTrack.peek();
  if (!t || from.width === 0) return;
  const img = h('img', { src: artFor(t, 'md')[0] ?? '', attrs: { alt: '' } });
  const fly = h('div.flying-cover', { style: { width: `${to.width}px`, height: `${to.height}px` } }, img);
  const sx = from.width / to.width;
  fly.style.transform = `translate(${from.left}px, ${from.top}px) scale(${sx})`;
  document.body.appendChild(fly);
  artBox.style.opacity = '0';
  document.querySelectorAll<HTMLElement>('.mini-cover').forEach((m) => (m.style.opacity = '0'));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      fly.style.transform = `translate(${to.left}px, ${to.top}px) scale(1)`;
    }),
  );
  const done = () => {
    fly.remove();
    artBox.style.opacity = '';
    document.querySelectorAll<HTMLElement>('.mini-cover').forEach((m) => (m.style.opacity = ''));
  };
  fly.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 450);
}

/** Lets the mini player drive the sheet while the finger moves (0 = closed, 1 = open). */
export function dragPlayer(progress: number): void {
  if (!currentTrack.peek()) return;
  root.classList.add('open');
  setY((1 - Math.max(0, Math.min(1, progress))) * window.innerHeight, false);
}

export function releasePlayer(open: boolean): void {
  swallowNextClick('.player');
  if (open) {
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    player.fullOpen.value = true;
    removeBack ??= onBack(() => {
      closePlayer();
      return true;
    });
    setY(0, true);
  } else {
    player.fullOpen.value = true;
    closePlayer();
  }
}

function attachDragToClose(...handles: HTMLElement[]): void {
  for (const handle of handles) {
    let startY = 0;
    let startT = 0;
    let dy = 0;
    let active = false;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      active = true;
      startY = e.clientY;
      startT = performance.now();
      dy = 0;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!active) return;
      dy = Math.max(0, e.clientY - startY);
      setY(dy, false);
    });
    const end = () => {
      if (!active) return;
      active = false;
      const velocity = dy / Math.max(1, performance.now() - startT);
      if (dy > window.innerHeight * 0.2 || velocity > 0.6) closePlayer();
      else setY(0, true);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

/* ───────── Panels: queue, lyrics, similar ───────── */

function openQueue(): void {
  const scope = new Scope();
  openSheet({
    header: h('div.h2', { style: { flex: '1' } }, 'Очередь'),
    onClose: () => scope.dispose(),
    content: () => {
      const list = h('div.list');
      scope.effect(() => {
        const queue = player.queue.value;
        const index = player.index.value;
        replaceChildren(
          list,
          queue.map((t, i) => {
            const row = trackRow(t, {
              sub: i === index ? 'Сейчас играет' : t.artist,
              onPlay: () => {
                expectLoading();
                call('skipTo', { index: i });
              },
              onMore: () =>
                openTrackMenu(t, {
                  actions: [
                    ...(i > 0 ? [{ icon: 'chevron-down', label: 'Выше в очереди', run: () => call('queueMove', { from: i, to: i - 1 }) }] : []),
                    { icon: 'close', label: 'Убрать из очереди', danger: true, run: () => call('queueRemove', { index: i }) },
                  ],
                }),
            });
            if (i < index) row.style.opacity = '0.5';
            return row;
          }),
        );
      });
      requestAnimationFrame(() => list.querySelector('.row.current')?.scrollIntoView({ block: 'center' }));
      return list;
    },
  });
}

interface LrcLine {
  ms: number;
  text: string;
}

function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m) out.push({ ms: (Number(m[1]) * 60 + Number(m[2])) * 1000, text: m[3] || '♪' });
  }
  return out;
}

function openLyrics(): void {
  const t = currentTrack.peek();
  if (!t) return;
  const scope = new Scope();
  const body = h('div', null, skeletonRows(4));
  openSheet({ header: [trackCover(t, 'sm'), h('div.item-main', null, h('div.row-title.ellipsis', null, t.title), h('div.row-sub', null, 'Текст песни'))], content: body, onClose: () => scope.dispose() });
  call('lyrics', { artist: t.artist, title: t.title.replace(/\s*[([].*?[)\]]/g, ''), durationMs: t.durationMs })
    .then((lyr) => {
      if (lyr.synced) {
        const lines = parseLrc(lyr.synced);
        const els = lines.map((l) => h('p', { onclick: () => seek(l.ms) }, l.text));
        replaceChildren(body, h('div.lyrics', null, els));
        let active = -1;
        onFrame(scope, () => {
          if (currentTrack.peek()?.id !== t.id) return;
          const pos = livePosition();
          let idx = -1;
          for (let i = 0; i < lines.length && lines[i].ms <= pos + 200; i++) idx = i;
          if (idx === active) return;
          els[active]?.classList.remove('active');
          els[idx]?.classList.add('active');
          els[idx]?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          active = idx;
        });
      } else if (lyr.plain) {
        replaceChildren(body, h('div.lyrics.plain', null, lyr.plain.split('\n').map((l) => h('p', null, l || ' '))));
      } else {
        replaceChildren(body, emptyState('lyrics', 'Текста нет', 'Для этого трека текст не найден.'));
      }
    })
    .catch(() => replaceChildren(body, emptyState('offline', 'Текст недоступен', 'Нужна сеть, чтобы загрузить текст.')));
}

function openSimilar(): void {
  const t = currentTrack.peek();
  if (!t) return;
  const body = h('div', null, skeletonRows(6));
  const close = openSheet({ header: h('div.h2', null, 'Похожие'), content: body });
  const waveBtn = t.source === 'yt'
    ? h('div.pad', { style: { marginBottom: 'var(--s-2)' } }, button('Волна по этому треку', () => {
        close();
        playTrackWave(t);
      }, { cls: 'primary block', icon: 'wave' }))
    : null;
  related(t)
    .then((tracks) => {
      const list = tracks.filter((x) => x.durationMs < 15 * 60_000);
      replaceChildren(
        body,
        waveBtn,
        list.length
          ? list.map((x: Track, i) => trackRow(x, { onPlay: () => playTracks(list, i, { kind: 'list', title: `Похоже на «${t.title}»` }), onMore: () => openTrackMenu(x) }))
          : emptyState('similar', 'Ничего похожего', t.source === 'local' ? 'Для своих файлов похожие не ищутся.' : undefined),
      );
    })
    .catch(() => replaceChildren(body, emptyState('offline', 'Нужна сеть')));
}

