/** Hyperscript-style element builder. `h('div.card.wide', {onclick}, child...)` */

export type Child = Node | string | number | null | undefined | false | Child[];

export type Props = {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  text?: string;
} & { [K in keyof HTMLElementEventMap as `on${K}`]?: (ev: HTMLElementEventMap[K]) => void } & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(selector: K | `${K}.${string}`, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(selector: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(selector: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const [tagPart, ...classes] = selector.split('.');
  const el = document.createElement(tagPart || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.classList.add(...String(value).split(' ').filter(Boolean));
    else if (key === 'style') {
      for (const [k, v] of Object.entries(value as Record<string, string>)) {
        if (k.startsWith('--')) el.style.setProperty(k, v);
        else (el.style as unknown as Record<string, string>)[k] = v;
      }
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'attrs') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v == null || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    } else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else {
      (el as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: SVGElement[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  children.forEach((c) => el.appendChild(c));
  return el;
}

/** Icon from the active sprite set. Colour follows `currentColor`. */
export function icon(name: string, cls = ''): SVGElement {
  const el = svg('svg', { class: `icon ${cls}`.trim(), 'aria-hidden': 'true', viewBox: '0 0 24 24' });
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  el.appendChild(use);
  return el;
}

export function setIcon(el: SVGElement, name: string): void {
  el.querySelector('use')?.setAttribute('href', `#i-${name}`);
}

export const prefersReducedMotion = (): boolean =>
  document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;

export function formatTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

export const tracksLabel = (n: number) => `${n} ${plural(n, 'трек', 'трека', 'треков')}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Eats the click that follows a gesture which just hid an overlay (player, sheet), so it never reaches
 * whatever was underneath. Clicks inside [keep] still go through.
 */
export function swallowNextClick(keep?: string, ms = 400): void {
  const stop = (e: Event) => {
    if (keep && (e.target as HTMLElement).closest?.(keep)) return;
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener('click', stop, true);
  setTimeout(() => document.removeEventListener('click', stop, true), ms);
}
