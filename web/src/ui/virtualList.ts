import { h } from '../core/dom';

/**
 * Fixed-height virtual list for long playlists: only rows near the viewport exist in the DOM,
 * positioned with transforms. `scroller` is the screen element that scrolls.
 */
export function virtualList<T>(opts: {
  items: T[];
  rowHeight: number;
  scroller: HTMLElement;
  render: (item: T, index: number) => HTMLElement;
  overscan?: number;
}): { el: HTMLElement; setItems: (items: T[]) => void; destroy: () => void } {
  let items = opts.items;
  const overscan = opts.overscan ?? 8;
  const el = h('div.list');
  const live = new Map<number, HTMLElement>();
  let frame = 0;

  const update = () => {
    frame = 0;
    const top = el.getBoundingClientRect().top - opts.scroller.getBoundingClientRect().top;
    const viewport = opts.scroller.clientHeight;
    const first = Math.max(0, Math.floor(-top / opts.rowHeight) - overscan);
    const last = Math.min(items.length - 1, Math.ceil((viewport - top) / opts.rowHeight) + overscan);
    for (const [i, row] of live) {
      if (i < first || i > last) {
        row.remove();
        live.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (live.has(i)) continue;
      const row = opts.render(items[i], i);
      row.classList.add('virtual-row');
      row.style.transform = `translateY(${i * opts.rowHeight}px)`;
      live.set(i, row);
      el.appendChild(row);
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  const setItems = (next: T[]) => {
    items = next;
    el.style.height = `${items.length * opts.rowHeight}px`;
    live.forEach((row) => row.remove());
    live.clear();
    schedule();
  };

  opts.scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  setItems(items);
  // The list is usually created before it is attached; render once it has a position.
  requestAnimationFrame(schedule);

  return {
    el,
    setItems,
    destroy: () => {
      opts.scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    },
  };
}
