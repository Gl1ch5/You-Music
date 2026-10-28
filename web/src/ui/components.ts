import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { formatTime, h, icon, prefersReducedMotion, setIcon, svg, type Child } from '../core/dom';
import { effect, track, type Scope } from '../core/signal';
import { app, currentTrack, isPlayable, likedIds, livePosition, player } from '../core/store';
import { artFor, type ArtSize } from '../services/art';
import { toggleLike } from '../services/library';

/* ───────── Cover ───────── */

/** Lazy image with fallbacks and a neutral placeholder; never a spinner. */
export function cover(urls: string[], cls = '', placeholder = 'note'): HTMLElement {
  const box = h(`div.cover.outline${cls ? '.' + cls.split(' ').join('.') : ''}`, null, icon(placeholder));
  setCoverUrls(box, urls);
  return box;
}

export function setCoverUrls(box: HTMLElement, urls: string[]): void {
  box.querySelector('img')?.remove();
  if (!urls.length) return;
  const img = h('img', { attrs: { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' } });
  let i = 0;
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => {
    i++;
    if (i < urls.length) img.src = urls[i];
    else img.remove();
  };
  img.src = urls[0];
  box.appendChild(img);
}

export const trackCover = (track: Track, size: ArtSize = 'sm', cls = '') => cover(artFor(track, size), cls);

/* ───────── Buttons ───────── */

export function iconButton(name: string, label: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h(`button.btn-icon${cls ? '.' + cls.split(' ').join('.') : ''}`, { attrs: { 'aria-label': label, title: label }, onclick }, icon(name));
}

export function button(label: string, onclick: () => void, opts: { icon?: string; cls?: string } = {}): HTMLButtonElement {
  return h(`button.btn${opts.cls ? '.' + opts.cls.split(' ').join('.') : ''}`, { onclick }, opts.icon ? icon(opts.icon) : null, label);
}

// Play ↔ pause morph: both shapes use the same number of path commands so `d` can transition.
const PLAY_D = 'M8 5 L8 12 L8 19 L19.5 12 Z M19.5 12 L19.5 12 L19.5 12 L19.5 12 Z';
const PAUSE_D = 'M6.5 5 L10.3 5 L10.3 19 L6.5 19 Z M13.7 5 L17.5 5 L17.5 19 L13.7 19 Z';

/** Bone circle with a morphing glyph. `playing` decides the glyph; `onToggle` runs on tap. */
export function playButton(scope: Scope, opts: { size?: 'sm' | 'lg' | ''; playing: () => boolean; onToggle: () => void; flat?: boolean }): HTMLButtonElement {
  const path = svg('path', { d: PLAY_D });
  const glyph = svg('svg', { class: 'morph', viewBox: '0 0 24 24' }, path);
  const btn = h(`button.play-btn${opts.size ? '.' + opts.size : ''}${opts.flat ? '.flat' : ''}`, {
    attrs: { 'aria-label': 'Играть' },
    onclick: () => {
      haptic('light');
      opts.onToggle();
    },
  });
  btn.appendChild(glyph);
  scope.effect(() => {
    const playing = opts.playing();
    path.setAttribute('d', playing ? PAUSE_D : PLAY_D);
    path.style.setProperty('d', `path('${playing ? PAUSE_D : PLAY_D}')`);
    btn.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
  });
  return btn;
}

/** Heart that fills from the bottom with a pulse and a haptic tick. */
export function likeButton(scope: Scope, track: () => Track | null, cls = ''): HTMLButtonElement {
  const glyph = h('span.like-glyph', null, icon('heart'), h('span.like-fill-wrap', null, icon('heart-fill')));
  const btn = h(`button.btn-icon.like${cls ? '.' + cls : ''}`, {
    attrs: { 'aria-label': 'Мне нравится' },
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      const t = track();
      if (!t) return;
      const willLike = !likedIds.peek().has(t.id);
      if (willLike && !prefersReducedMotion()) {
        btn.classList.remove('pulse');
        void btn.offsetWidth;
        btn.classList.add('pulse');
      }
      haptic(willLike ? 'confirm' : 'light');
      toggleLike(t).catch(() => undefined);
    },
  }, glyph);
  scope.effect(() => {
    const t = track();
    const on = !!t && likedIds.value.has(t.id);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  return btn;
}

export function haptic(kind: 'light' | 'medium' | 'confirm' = 'light'): void {
  call('haptic', { kind }).catch(() => undefined);
}

export function chip(label: string, active: boolean, onclick: () => void): HTMLButtonElement {
  return h(`button.chip${active ? '.active' : ''}`, { onclick }, label);
}

export function sectionHead(title: string, onMore?: () => void): HTMLElement {
  return h('div.section-head', { onclick: onMore }, h('h2.h2', null, title), onMore ? icon('chevron-right') : null);
}

export function emptyState(iconName: string, title: string, text?: string, action?: Child): HTMLElement {
  return h('div.empty', null, icon(iconName), h('div.h2', null, title), text ? h('div.small', null, text) : null, action ?? null);
}

export function eqBars(): HTMLElement {
  return h('span.eq', { attrs: { 'aria-label': 'Сейчас играет' } }, h('i'), h('i'), h('i'));
}

export function skeletonRows(n: number): HTMLElement {
  return h(
    'div',
    null,
    Array.from({ length: n }, () =>
      h('div.row', null, h('div.skeleton', { style: { width: 'var(--cover-row)', height: 'var(--cover-row)' } }), h('div.row-main.stack', { style: { gap: 'var(--s-1)' } }, h('div.skeleton.line', { style: { width: '62%' } }), h('div.skeleton.line', { style: { width: '38%' } }))),
    ),
  );
}

export function skeletonCards(n: number): HTMLElement {
  return h(
    'div.scroll-x',
    null,
    Array.from({ length: n }, () => h('div.card', null, h('div.skeleton', { style: { width: 'var(--cover-card)', height: 'var(--cover-card)' } }), h('div.skeleton.line', { style: { width: '80%' } }))),
  );
}

/* ───────── Track rows ───────── */

export interface RowOptions {
  onPlay: () => void;
  onMore?: () => void;
  number?: number;
  grip?: boolean;
  sub?: string;
}

export function trackRow(track: Track, opts: RowOptions): HTMLElement {
  const playable = isPlayable(track);
  const dl = app.downloads.peek().get(track.id)?.status === 'done';
  const lead = opts.number != null ? h('span.row-num.num', null, String(opts.number)) : trackCover(track, 'sm');
  const row = h(
    `div.row${playable ? '' : '.unavailable'}`,
    { dataset: { trackId: track.id }, onclick: opts.onPlay },
    opts.grip ? h('span.grip.btn-icon', { attrs: { 'aria-label': 'Перетащить' } }, icon('grip')) : null,
    lead,
    h(
      'div.row-main',
      null,
      h('div.row-title.ellipsis', null, track.title),
      h('div.row-sub', null, dl ? icon('downloaded') : track.source === 'local' ? icon('file') : null, h('span.ellipsis', null, opts.sub ?? track.artist)),
    ),
    opts.onMore
      ? iconButton('more', 'Действия', (e) => {
          e.stopPropagation();
          opts.onMore!();
        })
      : null,
  );
  markRow(row, track.id);
  return row;
}

/** Marks the now-playing row: accent title and an equaliser instead of the number / over the cover. */
export function markRow(row: HTMLElement, id: string): void {
  const isCurrent = currentTrack.peek()?.id === id;
  row.classList.toggle('current', isCurrent);
  row.querySelector('.eq-slot')?.remove();
  if (!isCurrent) {
    row.querySelector('.row-num')?.removeAttribute('hidden');
    return;
  }
  const eq = eqBars();
  eq.classList.toggle('paused', !player.playing.peek());
  const num = row.querySelector<HTMLElement>('.row-num');
  if (num) {
    num.hidden = true;
    num.after(h('span.row-num.eq-slot', null, eq));
  } else {
    row.querySelector('.cover')?.appendChild(h('span.eq-overlay.eq-slot', null, eq));
  }
}

/** One global effect keeps every visible row's now-playing marker in sync. */
export function initRowMarkers(): void {
  let lastId: string | null = null;
  effect(() => {
    const id = currentTrack.value?.id ?? null;
    const playing = player.playing.value;
    if (id !== lastId) {
      if (lastId) document.querySelectorAll<HTMLElement>(`.row[data-track-id="${CSS.escape(lastId)}"]`).forEach((r) => markRow(r, lastId!));
      if (id) document.querySelectorAll<HTMLElement>(`.row[data-track-id="${CSS.escape(id)}"]`).forEach((r) => markRow(r, id));
      lastId = id;
    }
    document.querySelectorAll('.row.current .eq').forEach((eq) => eq.classList.toggle('paused', !playing));
  });
}

/* ───────── Progress (rAF-driven, transform only) ───────── */

const progressSubscribers = new Set<() => void>();
let rafId = 0;

function tick() {
  progressSubscribers.forEach((fn) => fn());
  rafId = progressSubscribers.size && player.playing.peek() ? requestAnimationFrame(tick) : 0;
}

/** Registers a per-frame updater that runs only while playing and while registered. */
export function onFrame(scope: Scope, fn: () => void): void {
  progressSubscribers.add(fn);
  scope.add(() => progressSubscribers.delete(fn));
  scope.effect(() => {
    track(player.playing, player.position);
    fn();
    if (player.playing.peek() && !rafId) rafId = requestAnimationFrame(tick);
  });
}

/** Seek bar: thin line that thickens on touch, shows a thumb and a time tooltip. */
export function progressBar(scope: Scope, onSeek: (ms: number) => void): { el: HTMLElement; elapsed: HTMLElement; remaining: HTMLElement } {
  const fill = h('div.progress-fill');
  const thumb = h('div.progress-thumb');
  const tip = h('div.progress-tip');
  const el = h('div.progress', { attrs: { role: 'slider', 'aria-label': 'Позиция' } }, h('div.progress-track', null, fill), thumb, tip);
  const elapsed = h('time');
  const remaining = h('time');
  let dragging: number | null = null;

  const render = () => {
    const duration = player.position.peek().durationMs;
    const pos = dragging ?? livePosition();
    const ratio = duration > 0 ? Math.min(1, pos / duration) : 0;
    fill.style.transform = `scaleX(${ratio})`;
    const w = el.clientWidth;
    thumb.style.transform = `translateX(${ratio * w}px)`;
    tip.style.transform = `translateX(${Math.min(Math.max(ratio * w - 24, 0), w - 48)}px)`;
    elapsed.textContent = formatTime(pos);
    remaining.textContent = duration > 0 ? `-${formatTime(duration - pos)}` : '';
    if (dragging != null) tip.textContent = formatTime(dragging);
  };
  onFrame(scope, render);

  const at = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * player.position.peek().durationMs;
  };
  el.addEventListener('pointerdown', (e) => {
    if (!player.position.peek().durationMs) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    dragging = at(e);
    render();
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging == null) return;
    dragging = at(e);
    render();
  });
  const end = () => {
    if (dragging == null) return;
    const ms = dragging;
    dragging = null;
    el.classList.remove('active');
    onSeek(ms);
    haptic('light');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return { el, elapsed, remaining };
}

/** Effect helper for icons whose glyph depends on state. */
export function reactiveIcon(scope: Scope, name: () => string, cls = ''): SVGElement {
  const el = icon(name(), cls);
  scope.effect(() => setIcon(el, name()));
  return el;
}

/** App bar that shows its title and a hairline once the page scrolls past `threshold`. */
export function appBar(opts: { title: string; back?: () => void; actions?: Child[]; alwaysTitle?: boolean }): HTMLElement {
  return h(
    'div.appbar',
    null,
    opts.back ? iconButton('back', 'Назад', opts.back) : h('span', { style: { width: 'var(--s-2)' } }),
    h(`div.appbar-title.ellipsis${opts.alwaysTitle ? '.always' : ''}`, null, opts.title),
    ...(opts.actions ?? []),
  );
}

export function watchScroll(screen: HTMLElement, bar: HTMLElement, threshold = 24): void {
  const update = () => bar.classList.toggle('scrolled', screen.scrollTop > threshold);
  screen.addEventListener('scroll', update, { passive: true });
}

export function switchControl(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h(`button.switch${on ? '.on' : ''}`, {
    attrs: { role: 'switch', 'aria-checked': String(on) },
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      const next = !el.classList.contains('on');
      el.classList.toggle('on', next);
      el.setAttribute('aria-checked', String(next));
      haptic('light');
      onChange(next);
    },
  });
  return el;
}

export function listItem(opts: { icon?: string; title: string; sub?: string; trailing?: Child; onClick?: () => void; danger?: boolean }): HTMLElement {
  return h(
    `div.item${opts.danger ? '.danger' : ''}`,
    { onclick: opts.onClick },
    opts.icon ? icon(opts.icon) : null,
    h('div.item-main', null, h('div.ellipsis', null, opts.title), opts.sub ? h('div.item-sub', null, opts.sub) : null),
    opts.trailing ?? (opts.onClick ? icon('chevron-right', 'sm faint') : null),
  );
}
