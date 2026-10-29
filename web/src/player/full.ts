import { call, platform } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { h, icon, prefersReducedMotion, replaceChildren, swallowNextClick } from '../core/dom';
import { Scope } from '../core/signal';
import { currentTrack, livePosition, player } from '../core/store';
import { guard, slots } from '../mods/registry';
import { mutedGlow } from '../theme/engine';
import { artFor } from '../services/art';
import { download, removeDownload } from '../services/library';
import { expectLoading, next, playTrackWave, previous, seek, togglePlay } from '../services/playback';
import { linkArtist, refreshArtistLinks } from '../ui/artistLink';
import { dislikes, isDisliked, toggleDislike } from '../services/dislikes';
import type { Lyrics } from '../bridge/contract';
import { onBack } from '../ui/back';
import { haptic, iconButton, likeButton, onFrame, playButton, progressBar, reactiveIcon, setCoverUrls, trackRow, cover } from '../ui/components';
import { applyDynamicBackground } from '../ui/hero';
import { openSheet } from '../ui/sheet';
import { openTrackMenu } from '../ui/trackMenu';
import { busy } from '../core/busy';
import { normalizeTrack } from '../logic/normalize';
import { toast } from '../ui/toast';
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
  const bg = h('div.dyn-stack');
  const dim = h('div.dyn-dim');
  artBox = cover([], '', 'note');
  const glow = h('div.glow');
  const lyrics = lyricsPanel(scope);
  const art = h('div.player-art', null, glow, h('div.art-frame', null, artBox, lyrics.el));
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
    repeatBtn.classList.toggle('on', player.repeat.value !== 'off');
    shuffleBtn.classList.toggle('on', player.shuffle.value);
  });

  // Layout after Yandex Music: queue in the header; download and menu beside the title; dislike / prev / play / next / like;
  // three wide toggles (repeat, lyrics, shuffle) and the "Волна по треку" banner at the bottom.
  const dlBadge = h('span.action-badge');
  const dlBtn = h('button.btn-icon.dl', { onclick: toggleDownload, attrs: { 'aria-label': 'Скачать' } }, reactiveIcon(scope, () => (app.downloads.value.get(currentTrack.value?.id ?? '')?.status === 'done' ? 'downloaded' : 'download')), dlBadge);
  scope.effect(() => {
    const t = currentTrack.value;
    const d = app.downloads.value.get(t?.id ?? '');
    const running = !!d && d.status !== 'done' && d.status !== 'failed';
    dlBadge.textContent = running ? `${Math.round(d.progress * 100)}` : '';
    dlBadge.hidden = !running;
    dlBtn.classList.toggle('accent', d?.status === 'done');
    dlBtn.setAttribute('aria-label', d?.status === 'done' ? 'Скачано' : 'Скачать');
    dlBtn.hidden = t?.source !== 'yt' || platform === 'web';
  });
  const pill = (glyph: SVGElement, label: string, onclick: () => void) =>
    h('button.player-pill', { onclick, attrs: { 'aria-label': label, title: label } }, glyph);
  repeatBtn.className = 'player-pill';
  shuffleBtn.className = 'player-pill';
  const lyricsBtn = lyrics.toggle(pill(icon('lyrics'), 'Текст', () => lyrics.set(!lyrics.on(), art)));
  const pills = h('div.player-pills');
  scope.effect(() => {
    const mods = slots.playerButtons.value.map((b) => pill(icon(b.icon), b.label, () => guard(b.modId, b.onClick)(currentTrack.peek())));
    replaceChildren(pills, repeatBtn, lyricsBtn, shuffleBtn, ...mods);
  });
  const waveTitle = h('div.wave-banner-title.ellipsis');
  const waveLabel = h('div.wave-banner-label');
  const waveIcon = h('span.wave-banner-icon');
  const wave = h('button.wave-banner', { onclick: () => {
    const t = currentTrack.peek();
    if (t) void playTrackWave(t);
  } }, waveLabel, h('div.wave-banner-row', null, waveIcon, waveTitle));
  scope.effect(() => {
    const t = currentTrack.value;
    const ctx = player.context.value;
    waveTitle.textContent = t ? normalizeTrack(t).title : '';
    // While this very wave plays the banner stays in place (no layout jump), only its state changes.
    const active = !!t && ctx?.kind === 'wave' && ctx.title === `Волна по «${t.title}»`;
    wave.classList.toggle('on', active);
    wave.disabled = active;
    waveLabel.textContent = active ? 'Играет волна по треку' : 'Волна по треку';
    waveIcon.replaceChildren(icon(active ? 'wave' : 'play', 'sm'));
    wave.hidden = !t || t.source !== 'yt';
  });

  const head = h('div.player-head', null, iconButton('chevron-down', 'Свернуть', () => closePlayer()), context, iconButton('queue', 'Очередь', openQueue));

  const body = h(
    'div.player-body',
    null,
    head,
    art,
    h(
      'div.player-meta',
      null,
      h('div', { style: { flex: '1', minWidth: '0' } }, title, artist),
      dlBtn,
      iconButton('more', 'Действия', () => {
        const t = currentTrack.peek();
        if (t) openTrackMenu(t);
      }),
    ),
    progress.el,
    h('div.times', null, progress.elapsed, progress.remaining),
    h(
      'div.player-controls',
      null,
      dislikeButton(scope),
      iconButton('prev', 'Предыдущий', () => previous(), 'big on'),
      playButton(scope, { size: 'lg', playing: () => player.wantsPlay.value, loading: () => player.buffering.value && player.wantsPlay.value, onToggle: togglePlay }),
      iconButton('next', 'Следующий', () => next(), 'big on'),
      likeButton(scope, () => currentTrack.value),
    ),
    pills,
    wave,
  );

  root = h('div.player', { attrs: { 'aria-hidden': 'true' } }, bg, dim, body);

  let paletteScope = new Scope();
  let shownKey = '';
  scope.effect(() => {
    const t = currentTrack.value;
    context.textContent = player.context.value?.title ?? '';
    // The queue and context change often (a wave refills, a track swaps); redraw only when the song itself changed.
    const urls = t ? artFor(t, 'lg') : [];
    const key = t ? `${t.id}|${t.title}|${t.artist}|${urls[0] ?? ''}` : '';
    if (key === shownKey) return;
    shownKey = key;
    // Old likes may keep raw YouTube titles ("Sia - Snowman [Official Video]"): show them cleaned.
    title.textContent = t ? normalizeTrack(t).title : '';
    refreshArtistLinks(artist);
    if (!t) return;
    setCoverUrls(artBox, urls);
    paletteScope.dispose();
    paletteScope = new Scope();
    applyDynamicBackground(paletteScope, bg, urls[0], (color) => {
      const g = mutedGlow(color);
      if (g) root.style.setProperty('--glow', g);
    });
  });
  scope.effect(() => art.classList.toggle('paused', !player.wantsPlay.value));

  attachDragToClose(head, art);
  return root;
}

function dislikeButton(scope: Scope): HTMLButtonElement {
  const btn = h('button.btn-icon.dislike', {
    attrs: { 'aria-label': 'Не нравится' },
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      const t = currentTrack.peek();
      if (!t) return;
      haptic('light');
      void toggleDislike(t);
    },
  }, reactiveIcon(scope, () => {
    const list = dislikes.value;
    return isDisliked(currentTrack.value, list) ? 'dislike-fill' : 'dislike';
  }));
  scope.effect(() => {
    const list = dislikes.value;
    const t = currentTrack.value;
    btn.hidden = !t || t.source === 'local';
    btn.classList.toggle('on', isDisliked(t, list));
  });
  return btn;
}

const lyricsCache = new Map<string, Promise<Lyrics>>();

function lyricsOf(t: Track): Promise<Lyrics> {
  let p = lyricsCache.get(t.id);
  if (!p) {
    p = call('lyrics', { artist: t.artist, title: t.title.replace(/\s*[([].*?[)\]]/g, ''), durationMs: t.durationMs });
    p.catch(() => lyricsCache.delete(t.id));
    lyricsCache.set(t.id, p);
    if (lyricsCache.size > 30) lyricsCache.delete(lyricsCache.keys().next().value!);
  }
  return p;
}

/**
 * Lyrics in place of the cover: the "Текст" action swaps the cover for the full text (synced lines follow the
 * song, a tap on a line seeks). The mode stays on from track to track until turned off.
 */
function lyricsPanel(scope: Scope) {
  const scroller = h('div.art-lyrics-scroll');
  const translateBtn = iconButton('translate', 'Перевести на русский', () => void translate());
  translateBtn.hidden = true;
  const el = h('div.art-lyrics', { attrs: { 'aria-hidden': 'true' } }, scroller, translateBtn);
  let on = false;
  let forId = '';
  let lines: LrcLine[] = [];
  let lineEls: HTMLElement[] = [];
  let texts: string[] = [];
  let active = -2;
  let translated = false;
  let button: HTMLElement | null = null;

  const translate = async () => {
    if (translated) return;
    translated = true;
    translateBtn.classList.add('accent');
    try {
      const res = await busy(call('translate', { lines: texts, to: 'ru' }));
      res.lines.forEach((line, i) => {
        if (lineEls[i] && line && line !== texts[i]) lineEls[i].append(h('span.lyric-tr', null, line));
      });
    } catch (e) {
      translated = false;
      translateBtn.classList.remove('accent');
      toast(`Не удалось перевести: ${(e as Error).message}`, { icon: 'alert' });
    }
  };
  /** Russian text needs no translation: offer it only when most of the letters are not Cyrillic. */
  const offerTranslation = (list: string[]) => {
    texts = list;
    const letters = list.join('').replace(/[^\p{L}]/gu, '');
    const cyr = letters.replace(/[^а-яё]/gi, '').length;
    translateBtn.hidden = letters.length < 20 || cyr / letters.length > 0.5;
  };
  const message = (title: string, text: string) => replaceChildren(scroller, h('div.art-lyrics-empty', null, icon('lyrics'), h('div', null, title), h('div.small.muted', null, text)));

  const load = (t: Track) => {
    forId = t.id;
    lines = [];
    lineEls = [];
    active = -2;
    translated = false;
    translateBtn.hidden = true;
    translateBtn.classList.remove('accent');
    scroller.scrollTop = 0;
    replaceChildren(scroller, h('div.lyrics-skeleton', null, [70, 55, 80, 45, 65].map((w) => h('i', { style: { width: `${w}%` } }))));
    lyricsOf(t)
      .then((lyr) => {
        if (forId !== t.id) return;
        if (lyr.synced) {
          lines = parseLrc(lyr.synced);
          lineEls = lines.map((l) => h('p', { onclick: () => seek(l.ms) }, l.text));
          offerTranslation(lines.map((l) => (l.text === '♪' ? '' : l.text)));
          replaceChildren(scroller, h('div.lyrics.synced', null, lineEls));
        } else if (lyr.plain) {
          const plain = lyr.plain.split('\n');
          lineEls = plain.map((l) => h('p', null, l || ' '));
          offerTranslation(plain);
          replaceChildren(scroller, h('div.lyrics.plain', null, lineEls));
        } else {
          message('Текста нет', 'Для этого трека текст не найден.');
        }
      })
      .catch(() => forId === t.id && message('Текст недоступен', 'Нужна сеть, чтобы загрузить текст.'));
  };

  scope.effect(() => {
    const open = player.fullOpen.value;
    const t = currentTrack.value;
    if (!open || !on || !t || t.id === forId) return;
    load(t);
  });
  onFrame(scope, () => {
    if (!on || !lines.length || !player.fullOpen.peek()) return;
    const pos = livePosition();
    let idx = -1;
    for (let i = 0; i < lines.length && lines[i].ms <= pos + 200; i++) idx = i;
    if (idx === active) return;
    lineEls[active]?.classList.remove('active');
    lineEls[idx]?.classList.add('active');
    active = idx;
    const line = lineEls[idx];
    if (line) scroller.scrollTo({ top: line.offsetTop - scroller.clientHeight / 2 + line.offsetHeight / 2, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });

  return {
    el,
    on: () => on,
    toggle(btn: HTMLElement) {
      button = btn;
      return btn;
    },
    set(value: boolean, art: HTMLElement) {
      on = value;
      art.classList.toggle('lyrics-on', on);
      el.setAttribute('aria-hidden', String(!on));
      button?.classList.toggle('on', on);
      haptic('light');
      const t = currentTrack.peek();
      if (on && t && t.id !== forId) load(t);
    },
  };
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

export function openQueue(): void {
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


