import { h, icon } from '../core/dom';

let layer: HTMLElement | null = null;

export interface ToastOptions {
  icon?: string;
  action?: { label: string; run: () => void };
  duration?: number;
}

export function toast(message: string, opts: ToastOptions = {}): void {
  if (!layer) {
    layer = h('div.toast-layer');
    document.body.appendChild(layer);
  }
  const el = h(
    'div.toast',
    { attrs: { role: 'status' } },
    opts.icon ? icon(opts.icon, 'sm') : null,
    h('span', { style: { flex: '1' } }, message),
    opts.action
      ? h('button', {
          text: opts.action.label,
          onclick: () => {
            opts.action!.run();
            dismiss();
          },
        })
      : null,
  );
  const dismiss = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  layer.appendChild(el);
  while (layer.children.length > 2) layer.firstElementChild?.remove();
  setTimeout(dismiss, opts.duration ?? (opts.action ? 5000 : 2600));
}
