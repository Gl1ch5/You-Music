import { h } from '../core/dom';
import { Scope } from '../core/signal';
import { currentTrack, livePosition, player } from '../core/store';
import { artFor } from '../services/art';
import { next, previous, togglePlay } from '../services/playback';
import { cover, haptic, likeButton, onFrame, playButton, setCoverUrls } from '../ui/components';
import { dragPlayer, openPlayer, releasePlayer, setMiniCoverSource } from './full';

/**
 * Mini player above the tab bar. Tap or swipe up opens the full player (it follows the finger);
 * swipe left/right switches tracks with the cover sliding out and the next one sliding in.
 */
export function mountMiniPlayer(): HTMLElement {
  const scope = new Scope();
  const art = cover([], '', 'note');
  const coverBox = h('div.mini-cover', null, art);
  const title = h('div.row-title.ellipsis');
  const artist = h('div.row-sub.ellipsis');
  const swipe = h('div.mini-swipe', null, coverBox, h('div.mini-text', null, title, artist));
  const line = h('i');
  const el = h(
    'div.mini.hidden',
    { attrs: { role: 'button', 'aria-label': 'Открыть плеер' } },
    swipe,
    likeButton(scope, () => currentTrack.value),
    playButton(scope, { size: 'sm', flat: true, playing: () => player.wantsPlay.value, loading: () => player.buffering.value && player.wantsPlay.value, onToggle: togglePlay }),
    h('div.mini-line', null, line),
  );
  setMiniCoverSource(() => (el.classList.contains('hidden') ? null : coverBox.getBoundingClientRect()));

  let lastId: string | null = null;
  let pendingDirection = 0;
  scope.effect(() => {
    const t = currentTrack.value;
    el.classList.toggle('hidden', !t || player.fullOpen.value);
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
    if ((e.target as HTMLElement).closest('button')) return;
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
    if (dragged || (e.target as HTMLElement).closest('button')) return;
    openPlayer();
  });
  return el;
}
