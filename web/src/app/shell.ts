import { h, icon, setIcon } from '../core/dom';
import { effect } from '../core/signal';
import { app, player } from '../core/store';
import { haptic } from '../ui/components';
import { activeTab, mountRouter, switchTab, type Tab } from './router';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Главная', icon: 'wave' },
  { id: 'search', label: 'Поиск', icon: 'search' },
  { id: 'collection', label: 'Коллекция', icon: 'library' },
];

/** App frame: tab roots, mini player slot, bottom navigation. Inactive tabs show outline icons, the active one filled. */
export function mountShell(root: HTMLElement, extras: HTMLElement[]): void {
  const screens = h('div', { style: { position: 'absolute', inset: '0' } });
  const nav = h('nav.tabbar', { attrs: { 'aria-label': 'Разделы' } });
  for (const tab of TABS) {
    const glyph = icon(tab.icon);
    const btn = h('button.tab', { attrs: { 'aria-label': tab.label }, onclick: () => {
      haptic('light');
      switchTab(tab.id);
    } }, glyph, h('span', null, tab.label));
    effect(() => {
      const active = activeTab.value === tab.id;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
      setIcon(glyph, active ? `${tab.icon}-fill` : tab.icon);
    });
    nav.appendChild(btn);
  }
  const bar = h('div.busy-bar', { attrs: { role: 'progressbar', 'aria-label': 'Загрузка' } }, h('i'));
  effect(() => bar.classList.toggle('on', app.busy.value > 0 || player.preparing.value));
  root.append(screens, ...extras, nav, bar);
  mountRouter(screens);
}
