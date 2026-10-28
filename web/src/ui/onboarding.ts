import { navigate, switchTab } from '../app/router';
import { call } from '../bridge/bridge';
import { h, icon, replaceChildren } from '../core/dom';
import { app } from '../core/store';
import { authForm, perksList } from '../screens/account';
import { server } from '../services/server';
import { saveSettings } from '../services/settings';
import { activeTheme, allThemes, applyTheme } from '../theme/engine';
import type { Theme } from '../theme/types';
import { button } from './components';

const DONE_KEY = 'onboarding.done';
/** Bumped when a step is added: existing users then see only the new steps. */
const VERSION = '1';

/**
 * First launch: pick a theme → how to bring music over → the optional account, in plain words.
 * Users who already have a library (updated from an older version) only see the account step.
 */
export async function runOnboarding(): Promise<void> {
  const done = await call('kvGet', { key: DONE_KEY }).catch(() => VERSION);
  if (done === VERSION) return;
  const existing = app.likes.peek().length > 0 || app.playlists.peek().length > 0;
  const steps: Step[] = existing ? [accountStep] : [themeStep, importStep, accountStep];
  await new Promise<void>((resolve) => show(steps, resolve));
  await call('kvSet', { key: DONE_KEY, value: VERSION }).catch(() => undefined);
}

type Step = (next: () => void, finish: (after?: () => void) => void) => HTMLElement;

function show(steps: Step[], resolve: () => void): void {
  const body = h('div.onb-body');
  const dots = h('div.onb-dots', null, steps.map(() => h('i')));
  const layer = h('div.onboarding', { attrs: { role: 'dialog', 'aria-modal': 'true' } }, dots, body);
  let index = -1;
  const finish = (after?: () => void) => {
    layer.classList.remove('open');
    setTimeout(() => layer.remove(), 300);
    resolve();
    after?.();
  };
  const next = () => {
    index++;
    if (index >= steps.length) return finish();
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === index));
    const el = steps[index](next, finish);
    el.classList.add('onb-step');
    replaceChildren(body, el);
    body.scrollTop = 0;
  };
  document.body.appendChild(layer);
  next();
  requestAnimationFrame(() => layer.classList.add('open'));
}

function header(title: string, text: string): HTMLElement {
  return h('div.onb-head', null, h('h1.h1', null, title), h('p.muted', null, text));
}

function swatch(t: Theme): HTMLElement {
  const c = t.colors;
  return h(
    `div.onb-theme${t.glass ? '.is-glass' : ''}`,
    { style: { background: c.bg, color: c.text, borderColor: c.line } },
    h('div.onb-theme-bar', { style: { background: c.surface, borderColor: c.line } }, h('i', { style: { background: c.accent } }), h('b', { style: { background: c['text-2'] } })),
    h('div.onb-theme-name', null, t.name),
  );
}

const themeStep: Step = (next) => {
  const grid = h('div.onb-themes');
  const render = () =>
    replaceChildren(
      grid,
      allThemes().map((t) => {
        const el = swatch(t);
        el.classList.toggle('active', t.id === activeTheme.peek().id);
        el.onclick = () => {
          applyTheme(t);
          saveSettings({ themeId: t.id });
          render();
        };
        return el;
      }),
    );
  render();
  return h('div', null, header('Добро пожаловать в You Music', 'Выберите, как будет выглядеть приложение. Поменять можно в любой момент в настройках.'), grid, h('div.onb-actions', null, button('Дальше', next, { cls: 'block' })));
};

const importStep: Step = (next) =>
  h(
    'div',
    null,
    header('Перенесите свою музыку', 'Если вы слушали музыку в другом приложении — заберите лайки и плейлисты оттуда за пару минут.'),
    h(
      'div.onb-howto',
      null,
      howto('Spotify', ['Откройте плейлист в Spotify', 'Нажмите «Поделиться» → «Скопировать ссылку»', 'Вставьте ссылку на экране переноса']),
      howto('Яндекс Музыка', ['Откройте music.yandex.ru → свой профиль', 'Сделайте профиль публичным (Настройки → «Открытый профиль»)', 'Вставьте ссылку на профиль или плейлист']),
      howto('Другое', ['Список «Исполнитель — Название» по строке', 'или CSV-файл из любого сервиса (Exportify, Soundiiz)']),
    ),
    h(
      'div.onb-actions',
      null,
      button('Перенести музыку', () => {
        next();
        // The account step is still worth showing; the import screen waits underneath.
        switchTab('collection');
        navigate('import');
      }, { cls: 'block', icon: 'import' }),
      button('Пропустить', next, { cls: 'ghost block' }),
    ),
  );

function howto(title: string, lines: string[]): HTMLElement {
  return h('div.onb-card', null, h('div.onb-card-title', null, title), h('ol', null, lines.map((l) => h('li', null, l))));
}

const accountStep: Step = (_next, finish) => {
  const box = h('div');
  const render = () => {
    if (server.peek().signedIn) {
      replaceChildren(box, h('div.onb-card', null, icon('check'), ' Готово! Включить бесплатный прокси можно в Настройки → Аккаунт.'), h('div.onb-actions', null, button('Начать слушать', () => finish(), { cls: 'block' })));
      return;
    }
    replaceChildren(
      box,
      perksList(),
      h('div.onb-form', null, authForm(render)),
      h('p.small.muted.onb-note', null, 'Нужен только логин и пароль — без почты и телефона. Можно сделать позже в настройках.'),
      h('div.onb-actions', null, button('Не сейчас', () => finish(), { cls: 'ghost block' })),
    );
  };
  render();
  return h('div', null, header('Аккаунт — по желанию', 'Всё работает и без него. Но с бесплатным аккаунтом станет удобнее:'), box);
};
