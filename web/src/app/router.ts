import { h } from '../core/dom';
import { Scope, signal } from '../core/signal';
import { uiBus } from '../services/events';

/**
 * Per-tab navigation stacks (like the reference app: each bottom tab remembers its own history).
 * A screen is a factory returning a `.screen` element; its Scope is disposed when it is popped.
 */

export type Tab = 'home' | 'search' | 'collection';
export type Params = Record<string, unknown>;

export interface ScreenContext {
  scope: Scope;
  params: Params;
}

export type ScreenFactory = (ctx: ScreenContext) => HTMLElement;

interface Entry {
  route: string;
  el: HTMLElement;
  scope: Scope;
}

const routes = new Map<string, ScreenFactory>();
const stacks: Record<Tab, Entry[]> = { home: [], search: [], collection: [] };
const roots = {} as Record<Tab, HTMLElement>;

export const activeTab = signal<Tab>('home');

export function defineRoute(name: string, factory: ScreenFactory): void {
  routes.set(name, factory);
}

export function mountRouter(container: HTMLElement): void {
  for (const tab of Object.keys(stacks) as Tab[]) {
    roots[tab] = h('div.tab-root', { attrs: { hidden: tab !== 'home' } });
    container.appendChild(roots[tab]);
  }
  push('home', 'home', {}, false);
}

function push(tab: Tab, route: string, params: Params, animate: boolean): void {
  const factory = routes.get(route);
  if (!factory) throw new Error(`Unknown route ${route}`);
  const scope = new Scope();
  const el = factory({ scope, params });
  el.dataset.route = route;
  const stack = stacks[tab];
  const prev = stack[stack.length - 1];
  stack.push({ route, el, scope });
  roots[tab].appendChild(el);
  if (animate) {
    el.classList.add('screen-enter');
    el.addEventListener('animationend', () => {
      el.classList.remove('screen-enter');
      if (prev) prev.el.hidden = true;
    }, { once: true });
  } else if (prev) {
    prev.el.hidden = true;
  }
  uiBus.emit('screen', { route });
}

export function navigate(route: string, params: Params = {}): void {
  push(activeTab.peek(), route, params, true);
}

/** Pops the current tab's stack; returns false when already at the tab root. */
export function goBack(): boolean {
  const stack = stacks[activeTab.peek()];
  if (stack.length <= 1) {
    if (activeTab.peek() !== 'home') {
      switchTab('home');
      return true;
    }
    return false;
  }
  const top = stack.pop()!;
  const prev = stack[stack.length - 1];
  prev.el.hidden = false;
  top.el.classList.add('screen-leave');
  const done = () => {
    top.el.remove();
    top.scope.dispose();
  };
  top.el.addEventListener('animationend', done, { once: true });
  setTimeout(done, 400);
  uiBus.emit('screen', { route: prev.route });
  return true;
}

export function switchTab(tab: Tab): void {
  const current = activeTab.peek();
  if (tab === current) {
    // Second tap: back to the tab root, or scroll to top.
    const stack = stacks[tab];
    if (stack.length > 1) {
      while (stack.length > 1) {
        const e = stack.pop()!;
        e.el.remove();
        e.scope.dispose();
      }
      stack[0].el.hidden = false;
    } else {
      stack[0]?.el.scrollTo({ top: 0, behavior: 'smooth' });
    }
    return;
  }
  roots[current].hidden = true;
  roots[tab].hidden = false;
  activeTab.value = tab;
  if (!stacks[tab].length) push(tab, tab, {}, false);
  const top = stacks[tab][stacks[tab].length - 1];
  top.el.classList.add('screen-enter');
  top.el.addEventListener('animationend', () => top.el.classList.remove('screen-enter'), { once: true });
  uiBus.emit('screen', { route: top.route });
}

export function currentScreen(): HTMLElement | undefined {
  const stack = stacks[activeTab.peek()];
  return stack[stack.length - 1]?.el;
}
