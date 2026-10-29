import { h } from '../core/dom';
import { platform } from '../bridge/bridge';
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
      h('div.mini-side', null, like, iconButton('queue', 'Очередь', () => openQueue(), 'mini-extra'), iconButton('chevron-up', 'Открыть плеер', () => openPlayer(), 'mini-extra')),
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
    if ((e.target as HTMLElement).closest('button, .mini-seek')) return;
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
    if (dragged || (e.target as HTMLElement).closest('button, .mini-seek')) return;
    openPlayer();
  });
  return el;
}
