import { h, icon, type Child } from '../core/dom';
import { onBack } from './back';
import { button } from './components';

export interface SheetOptions {
  header?: Child;
  content: Child | ((close: () => void) => Child);
  onClose?: () => void;
}

/** Bottom sheet with a scrim; drag the handle/header down or press back to dismiss. Returns `close`. */
export function openSheet(opts: SheetOptions): () => void {
  const panel = h('div.sheet', { attrs: { role: 'dialog', 'aria-modal': 'true' } });
  const backdrop = h('div.backdrop');
  const layer = h('div.sheet-layer', null, backdrop, panel);
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    removeBack();
    layer.classList.remove('open');
    panel.style.transform = '';
    setTimeout(() => layer.remove(), 340);
    opts.onClose?.();
  };

  const head = h('div', null, h('div.sheet-handle'), opts.header ? h('div.sheet-head', null, opts.header) : null);
  const body = h('div.sheet-body', null, typeof opts.content === 'function' ? opts.content(close) : opts.content);
  panel.append(head, body);
  backdrop.onclick = close;
  document.body.appendChild(layer);
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('open')));
  const removeBack = onBack(() => {
    close();
    return true;
  });

  let startY = 0;
  let dy = 0;
  head.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    dy = 0;
    head.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
  });
  head.addEventListener('pointermove', (e) => {
    if (!panel.classList.contains('dragging')) return;
    dy = Math.max(0, e.clientY - startY);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const release = () => {
    panel.classList.remove('dragging');
    if (dy > panel.offsetHeight * 0.25) close();
    else panel.style.transform = '';
  };
  head.addEventListener('pointerup', release);
  head.addEventListener('pointercancel', release);
  return close;
}

export interface Action {
  icon: string;
  label: string;
  sub?: string;
  danger?: boolean;
  run: () => void;
}

export function actionSheet(header: Child | undefined, actions: Action[]): () => void {
  return openSheet({
    header,
    content: (close) =>
      actions.map((a) =>
        h(
          `div.item${a.danger ? '.danger' : ''}`,
          {
            onclick: () => {
              close();
              a.run();
            },
          },
          icon(a.icon),
          h('div.item-main', null, h('div', null, a.label), a.sub ? h('div.item-sub', null, a.sub) : null),
        ),
      ),
  });
}

export function promptSheet(opts: { title: string; value?: string; placeholder?: string; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input.textfield', { value: opts.value ?? '', attrs: { placeholder: opts.placeholder ?? '', maxlength: 80 } });
    openSheet({
      header: h('div.h2', null, opts.title),
      onClose: () => resolve(result),
      content: (close) => {
        const submit = () => {
          result = input.value.trim() || null;
          close();
        };
        input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
        setTimeout(() => input.focus(), 320);
        return h('div.pad.stack', { style: { gap: 'var(--s-3)', paddingTop: 'var(--s-2)' } }, input, button(opts.ok ?? 'Готово', submit, { cls: 'primary block' }));
      },
    });
  });
}

export function confirmSheet(opts: { title: string; text?: string; ok: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openSheet({
      header: h('div.h2', null, opts.title),
      onClose: () => resolve(result),
      content: (close) =>
        h(
          'div.pad.stack',
          { style: { gap: 'var(--s-3)', paddingTop: 'var(--s-2)' } },
          opts.text ? h('div.muted', null, opts.text) : null,
          button(
            opts.ok,
            () => {
              result = true;
              close();
            },
            { cls: opts.danger ? 'block danger' : 'primary block' },
          ),
          button('Отмена', close, { cls: 'ghost block' }),
        ),
    });
  });
}
