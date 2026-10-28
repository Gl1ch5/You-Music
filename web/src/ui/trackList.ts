import type { Track } from '../bridge/contract';
import { h } from '../core/dom';
import type { Scope } from '../core/signal';
import type { PlayContext } from '../core/store';
import { playTracks } from '../services/playback';
import { trackRow } from './components';
import { openTrackMenu, type MenuExtras } from './trackMenu';
import { virtualList } from './virtualList';

const VIRTUAL_FROM = 60;
const ROW_H = 64;

/**
 * List of tracks that plays from the tapped row with the given context.
 * Long lists are virtualized against `scroller`.
 */
export function trackList(
  scope: Scope,
  opts: {
    tracks: Track[];
    scroller: HTMLElement;
    context: PlayContext;
    numbered?: boolean;
    menu?: (track: Track, index: number) => MenuExtras;
  },
): HTMLElement {
  const render = (track: Track, i: number) =>
    trackRow(track, {
      number: opts.numbered ? i + 1 : undefined,
      onPlay: () => playTracks(opts.tracks, i, opts.context),
      onMore: () => openTrackMenu(track, opts.menu?.(track, i)),
    });
  if (opts.tracks.length < VIRTUAL_FROM) return h('div.list', null, opts.tracks.map(render));
  const list = virtualList({ items: opts.tracks, rowHeight: ROW_H, scroller: opts.scroller, render });
  scope.add(list.destroy);
  return list.el;
}
