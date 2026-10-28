import { defineRoute, goBack } from '../app/router';
import { call } from '../bridge/bridge';
import { h, replaceChildren } from '../core/dom';
import type { Scope } from '../core/signal';
import { iconSetNames } from '../design/icons';
import { saveSettings } from '../services/settings';
import { activeTheme, allThemes, applyTheme, deleteCustomTheme, saveCustomTheme, sanitizeTheme } from '../theme/engine';
import { COLOR_LABELS, COLOR_TOKENS, type Theme } from '../theme/types';
import { appBar, button, chip, iconButton, likeButton, playButton } from '../ui/components';
import { confirmSheet, promptSheet } from '../ui/sheet';
import { toast } from '../ui/toast';

/** Everything applies live through CSS variables: the whole app is the preview, plus a sample block on top. */

function slider(label: string, value: number, min: number, max: number, step: number, unit: string, onInput: (v: number) => void): HTMLElement {
  const out = h('span.small.muted.num', null, `${value}${unit}`);
  const input = h('input', { attrs: { type: 'range', min, max, step }, value: String(value) });
  input.addEventListener('input', () => {
    out.textContent = `${input.value}${unit}`;
    onInput(Number(input.value));
  });
  return h('div.pad', { style: { padding: 'var(--s-1) var(--gutter)' } }, h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', null, label), out), input);
}

function preview(scope: Scope): HTMLElement {
  const sample = { id: 'preview', source: 'local' as const, title: 'Название трека', artist: 'Исполнитель', durationMs: 215000 };
  return h(
    'div.preview',
    null,
    h(
      'div.row',
      null,
      h('div.cover', { style: { background: 'var(--surface-2)' } }),
      h('div.row-main', null, h('div.row-title', null, sample.title), h('div.row-sub', null, sample.artist)),
      likeButton(scope, () => null),
      playButton(scope, { size: 'sm', playing: () => false, onToggle: () => undefined }),
    ),
    h('div.chips', { style: { padding: 'var(--s-1) var(--gutter)' } }, chip('Активный', true, () => undefined), chip('Обычный', false, () => undefined)),
  );
}

defineRoute('themeEditor', ({ scope, params }) => {
  const base = allThemes().find((t) => t.id === params.id) ?? activeTheme.peek();
  const isBuiltin = !base.id.startsWith('custom-');
  let draft: Theme = sanitizeTheme(JSON.parse(JSON.stringify(isBuiltin ? { ...base, id: `custom-${Date.now()}`, name: `${base.name} (моя)` } : base)));
  const original = activeTheme.peek();
  let saved = false;
  scope.add(() => {
    if (!saved) applyTheme(original);
  });

  const update = (fn: (t: Theme) => void) => {
    fn(draft);
    draft = sanitizeTheme(draft);
    applyTheme(draft);
  };

  const screen = h('div.screen');
  const body = h('div');

  const render = () => {
    replaceChildren(
      body,
      h('div.section-head', null, h('div.small.muted', null, 'Предпросмотр')),
      preview(scope),
      h('div.section-head', null, h('div.small.muted', null, 'Основа')),
      h('div.chips', null, allThemes().filter((t) => !t.id.startsWith('custom-')).map((t) => chip(t.name, false, () => {
        draft = sanitizeTheme({ ...t, id: draft.id, name: draft.name });
        applyTheme(draft);
        render();
      }))),
      h('div.section-head', null, h('div.small.muted', null, 'Цвета')),
      COLOR_TOKENS.map((token) => {
        const input = h('input', { attrs: { type: 'color' }, value: draft.colors[token] });
        input.addEventListener('input', () => update((t) => (t.colors[token] = input.value)));
        return h('label.swatch-row', null, input, h('span', { style: { flex: '1' } }, COLOR_LABELS[token]), h('span.small.faint.num', null, `--${token}`));
      }),
      h('div.section-head', null, h('div.small.muted', null, 'Форма')),
      slider('Скругление обложек', draft.radius.cover, 0, 32, 1, 'px', (v) => update((t) => (t.radius.cover = v))),
      slider('Скругление карточек', draft.radius.card, 0, 32, 1, 'px', (v) => update((t) => (t.radius.card = v))),
      slider('Скругление мини-плеера', draft.radius.mini, 0, 32, 1, 'px', (v) => update((t) => (t.radius.mini = v))),
      slider('Шаг сетки', draft.spacing.unit, 6, 12, 1, 'px', (v) => update((t) => (t.spacing.unit = v))),
      slider('Размер заголовков', draft.font.titleSize, 20, 40, 1, 'px', (v) => update((t) => (t.font.titleSize = v))),
      slider('Толщина иконок', draft.icons.stroke, 1, 2.5, 0.25, '', (v) => update((t) => (t.icons.stroke = v))),
      h('div.section-head', null, h('div.small.muted', null, 'Материал и цвет')),
      slider('Зернистость', Math.round(draft.grain * 1000) / 10, 0, 8, 0.5, '%', (v) => update((t) => (t.grain = v / 100))),
      slider('Динамический цвет', Math.round(draft.dynamic.intensity * 100), 0, 100, 5, '%', (v) => update((t) => (t.dynamic.intensity = v / 100))),
      slider('Графитовый слой', Math.round(draft.dynamic.dim * 100), 30, 95, 1, '%', (v) => update((t) => (t.dynamic.dim = v / 100))),
      h('div.section-head', null, h('div.small.muted', null, 'Анимации')),
      slider('Нажатия', draft.motion.press, 0, 400, 10, ' мс', (v) => update((t) => (t.motion.press = v))),
      slider('Переходы', draft.motion.base, 0, 800, 10, ' мс', (v) => update((t) => (t.motion.base = v))),
      slider('Открытие плеера', draft.motion.open, 0, 1000, 10, ' мс', (v) => update((t) => (t.motion.open = v))),
      iconSetNames().length > 1
        ? [h('div.section-head', null, h('div.small.muted', null, 'Иконки')), h('div.chips', null, iconSetNames().map((n) => chip(n, n === draft.icons.set, () => {
            update((t) => (t.icons.set = n));
            render();
          })))]
        : null,
      h(
        'div.pad.stack',
        { style: { marginTop: 'var(--s-6)', gap: 'var(--s-2)' } },
        button('Сохранить тему', async () => {
          const name = await promptSheet({ title: 'Название темы', value: draft.name });
          if (!name) return;
          draft.name = name;
          await saveCustomTheme(draft);
          await saveSettings({ themeId: draft.id });
          saved = true;
          toast(`Тема «${name}» сохранена`, { icon: 'check' });
          goBack();
        }, { cls: 'primary block', icon: 'check' }),
        button('Экспорт в файл', async () => {
          await call('saveTextFile', { name: `${draft.name.replace(/[^\p{L}\p{N}-]+/gu, '-')}.theme.json`, text: JSON.stringify(draft, null, 2), mime: 'application/json' });
        }, { cls: 'block', icon: 'export' }),
        button('Импорт из файла', async () => {
          const file = await call('pickTextFile', { mime: 'application/json' });
          if (!file) return;
          try {
            draft = sanitizeTheme({ ...JSON.parse(file.text), id: `custom-${Date.now()}` });
            applyTheme(draft);
            render();
            toast('Тема загружена — сохраните, чтобы оставить', { icon: 'palette' });
          } catch {
            toast('Файл не похож на тему', { icon: 'alert' });
          }
        }, { cls: 'block', icon: 'import' }),
        !isBuiltin
          ? button('Удалить тему', async () => {
              if (!(await confirmSheet({ title: `Удалить «${base.name}»?`, ok: 'Удалить', danger: true }))) return;
              await deleteCustomTheme(base.id);
              const fallback = allThemes()[0];
              applyTheme(fallback);
              await saveSettings({ themeId: fallback.id });
              saved = true;
              goBack();
            }, { cls: 'block danger', icon: 'trash' })
          : null,
      ),
    );
  };

  render();
  applyTheme(draft);
  screen.append(appBar({ title: 'Редактор тем', back: goBack, alwaysTitle: true, actions: [iconButton('check', 'Сохранить', () => (body.querySelector('.btn.primary') as HTMLButtonElement)?.click())] }), body);
  return screen;
});
