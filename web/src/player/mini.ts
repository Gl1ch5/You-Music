import { h, setIcon } from '../core/dom';
import { call, platform } from '../bridge/bridge';
import { Scope } from '../core/signal';
import { currentTrack, livePosition, player } from '../core/store';
import { artFor } from '../services/art';
import { next, previous, seek, togglePlay } from '../services/playback';
import { cover, haptic, iconButton, likeButton, onFrame, playButton, progressBar, setCoverUrls } from '../ui/components';
import { dragPlayer, openPlayer, openQueue, releasePlayer, setMiniCoverSource } from './full';

/**
 * Mini player above the tab bar. Tap or swipe up opens the full player (it follows the finger);
 * swipe left/right switches tracks with the cover sliding out and the next one sliding in.
 * In the web player and the desktop app it also carries prev/next, a seek bar and the queue: on a wide window
 * it becomes the bottom player bar (see `html.wide` in components.css); on a narrow one those stay hidden.
 */
export function mountMiniPlayer(): HTMLElement {
  const scope = new Scope();
  const art = cover([], '', 'note');
  const coverBox = h('div.mini-cover', null, art);
  const title = h('div.row-title.ellipsis');
  const artist = h('div.row-sub.ellipsis');
  const swipe = h('div.mini-swipe', null, coverBox, h('div.mini-text', null, title, artist));
  const line = h('i');
  const play = playButton(scope, { size: 'sm', flat: true, playing: () => player.wantsPlay.value, loading: () => player.buffering.value && player.wantsPlay.value, onToggle: togglePlay });
  const like = likeButton(scope, () => currentTrack.value);
  const wide = platform === 'web' || platform === 'desktop';
  let parts: HTMLElement[] = [like, play];
  if (wide) {
    const seekBar = progressBar(scope, (ms) => seek(ms));
    parts = [
      h('div.mini-side', null, like, volumeControl(), iconButton('queue', 'Очередь', () => openQueue(), 'mini-extra'), iconButton('chevron-up', 'Открыть плеер', () => openPlayer(), 'mini-extra')),
      h(
        'div.mini-center',
        null,
        h('div.mini-ctrls', null, iconButton('prev', 'Предыдущий', () => previous(), 'mini-extra'), play, iconButton('next', 'Следующий', () => next(), 'mini-extra')),
        h('div.mini-seek', null, seekBar.elapsed, seekBar.el, seekBar.remaining),
      ),
    ];
  }
  const el = h('div.mini.hidden', { attrs: { role: 'button', 'aria-label': 'Открыть плеер' } }, swipe, ...parts, h('div.mini-line', null, line));
  // Transparent strip around the mini player: taps that miss it by a few pixels must not hit the list below.
  const shield = h('div.mini-shield.hidden');
  // A sibling, not a child: the mini player clips its overflow, including hit testing.
  queueMicrotask(() => el.before(shield));
  setMiniCoverSource(() => (el.classList.contains('hidden') ? null : coverBox.getBoundingClientRect()));

  let lastId: string | null = null;
  let pendingDirection = 0;
  scope.effect(() => {
    const t = currentTrack.value;
    const hidden = !t || player.fullOpen.value;
    el.classList.toggle('hidden', hidden);
    shield.classList.toggle('hidden', hidden);
    if (!t || t.id === lastId) return;
    lastId = t.id;
    title.textContent = t.title;
    artist.textContent = t.artist;
    setCoverUrls(art, artFor(t, 'sm'));
    if (pendingDirection) {
      // Slide the new track in from the side the finger came from.
      swipe.style.transition = 'none';
      swipe.style.transform = `translateX(${pendingDirection * 40}px)`;
      swipe.style.opacity = '0';
      requestAnimationFrame(() => {
        swipe.style.transition = '';
        swipe.style.transform = '';
        swipe.style.opacity = '';
      });
      pendingDirection = 0;
    }
  });

  onFrame(scope, () => {
    const d = player.position.peek().durationMs;
    line.style.transform = `scaleX(${d > 0 ? Math.min(1, livePosition() / d) : 0})`;
  });

  swipe.style.transition = 'transform var(--t-base) var(--ease), opacity var(--t-base) var(--ease)';
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let mode: 'none' | 'h' | 'v' = 'none';
  let dx = 0;
  let dy = 0;
  let dragged = false;

  el.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, .mini-seek, .mini-vol')) return;
    startX = e.clientX;
    startY = e.clientY;
    startT = performance.now();
    mode = 'none';
    dx = dy = 0;
    dragged = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (mode === 'none' && Math.hypot(dx, dy) > 10) mode = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    if (mode === 'h') {
      swipe.style.transition = 'none';
      swipe.style.transform = `translateX(${dx}px)`;
      swipe.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 300));
    } else if (mode === 'v' && dy < 0) {
      dragPlayer(-dy / window.innerHeight);
    }
  });
  const end = (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    const dt = Math.max(1, performance.now() - startT);
    dragged = mode !== 'none';
    if (mode === 'h') {
      swipe.style.transition = '';
      if (Math.abs(dx) > 80 || Math.abs(dx) / dt > 0.5) {
        pendingDirection = dx < 0 ? 1 : -1;
        swipe.style.transform = `translateX(${dx < 0 ? -120 : 120}px)`;
        swipe.style.opacity = '0';
        haptic('light');
        if (dx < 0) next();
        else previous();
        // If the track does not change (end of queue), come back.
        setTimeout(() => {
          if (pendingDirection) {
            pendingDirection = 0;
            swipe.style.transform = '';
            swipe.style.opacity = '';
          }
        }, 600);
      } else {
        swipe.style.transform = '';
        swipe.style.opacity = '';
      }
    } else if (mode === 'v') {
      releasePlayer(-dy > window.innerHeight * 0.18 || -dy / dt > 0.5);
    }
    mode = 'none';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // Open on `click`, not on pointerup: hiding the mini player before the click is dispatched would let that
  // click land on the track row underneath and start it.
  el.addEventListener('click', (e) => {
    if (dragged || (e.target as HTMLElement).closest('button, .mini-seek, .mini-vol')) return;
    openPlayer();
  });
  return el;
}

const VOLUME_KEY = 'player.volume';

/**
 * Volume for the bottom player bar (web player and desktop app): mute button + slider, the wheel works over both.
 * The level lives in kv `player.volume` as `{level, muted}`; the slider is linear, the player gets level² (sounds even).
 */
function volumeControl(): HTMLElement {
  let level = 0.8;
  let muted = false;
  const btn = iconButton('volume', 'Без звука', () => {
    if (muted || level === 0) {
      muted = false;
      if (level === 0) level = 0.5;
    } else muted = true;
    apply(true);
  }, 'mini-extra');
  const fill = h('div.progress-fill');
  const thumb = h('div.progress-thumb');
  const bar = h('div.progress', { attrs: { role: 'slider', 'aria-label': 'Громкость', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, h('div.progress-track', null, fill), thumb);
  const el = h('div.mini-vol', null, btn, bar);

  const apply = (save: boolean) => {
    const shown = muted ? 0 : level;
    fill.style.transform = `scaleX(${shown})`;
    thumb.style.translate = `${shown * bar.clientWidth}px 0`;
    bar.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
    const svg = btn.querySelector('svg');
    if (svg) setIcon(svg, shown === 0 ? 'volume-off' : shown < 0.5 ? 'volume-low' : 'volume');
    btn.setAttribute('aria-label', muted ? 'Включить звук' : 'Без звука');
    btn.title = btn.getAttribute('aria-label')!;
    void call('setVolume', { volume: shown * shown }).catch(() => undefined);
    if (save) void call('kvSet', { key: VOLUME_KEY, value: JSON.stringify({ level, muted }) }).catch(() => undefined);
  };
  const set = (v: number, save: boolean) => {
    level = Math.min(1, Math.max(0, v));
    muted = false;
    apply(save);
  };
  const at = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  };
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('active');
    set(at(e), false);
  });
  bar.addEventListener('pointermove', (e) => dragging && set(at(e), false));
  const end = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('active');
    apply(true);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    set((muted ? 0 : level) - Math.sign(e.deltaY) * 0.05, true);
  }, { passive: false });
  // The thumb is placed in pixels: re-place it once the bar has a width (and when the window is resized).
  new ResizeObserver(() => apply(false)).observe(bar);

  void call('kvGet', { key: VOLUME_KEY })
    .then((raw) => {
      const saved = raw ? (JSON.parse(raw) as { level?: number; muted?: boolean }) : null;
      if (typeof saved?.level === 'number') level = Math.min(1, Math.max(0, saved.level));
      muted = !!saved?.muted;
    })
    .catch(() => undefined)
    .finally(() => apply(false));
  return el;
}
