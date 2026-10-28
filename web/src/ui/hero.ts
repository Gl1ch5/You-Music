import { call } from '../bridge/bridge';
import { h, type Child } from '../core/dom';
import type { Scope } from '../core/signal';

/**
 * Page header for album / artist / playlist screens. With `artUrl`, the background is the blurred,
 * half-desaturated cover rendered natively, under a graphite layer — the cover tints the page, never paints it.
 */
export function pageHero(scope: Scope, opts: { title: string; sub?: Child; cover: HTMLElement; artUrl?: string | null; actions?: Child[] }): HTMLElement {
  const bg = h('div.dyn-bg');
  const dim = h('div.dyn-dim');
  opts.cover.classList.add('big');
  const hero = h(
    'div.hero',
    null,
    bg,
    dim,
    opts.cover,
    h('h1.h1', null, opts.title),
    opts.sub ? h('div.muted', null, opts.sub) : null,
    opts.actions?.length ? h('div.hero-actions', null, opts.actions) : null,
  );
  if (opts.artUrl) applyDynamicBackground(scope, bg, opts.artUrl);
  return hero;
}

export function applyDynamicBackground(scope: Scope, bg: HTMLElement, url: string, onColor?: (color: string | null) => void): void {
  let alive = true;
  scope.add(() => (alive = false));
  call('artworkPalette', { url })
    .then((p) => {
      if (!alive) return;
      onColor?.(p.color ?? null);
      if (!p.blurUrl) return;
      const img = new Image();
      img.onload = () => {
        if (!alive) return;
        bg.style.backgroundImage = `url("${p.blurUrl}")`;
        bg.classList.add('ready');
      };
      img.src = p.blurUrl;
    })
    .catch(() => undefined);
}

export function totalDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  return `${hours} ч ${min % 60} мин`;
}
