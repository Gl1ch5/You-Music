import { defineRoute, goBack } from '../app/router';
import { call, onNative } from '../bridge/bridge';
import type { Proxy, ProxyState, UpdateState } from '../bridge/contract';
import { h, icon, replaceChildren } from '../core/dom';
import { app } from '../core/store';
import { refreshAiConfig } from '../services/ai';
import { saveSettings } from '../services/settings';
import { checkUpdates } from '../services/updates';
import { appBar, button, chip, emptyState, iconButton, listItem, switchControl, watchScroll } from '../ui/components';
import { actionSheet } from '../ui/sheet';
import { toast } from '../ui/toast';

function page(title: string, ...content: HTMLElement[]): HTMLElement {
  const screen = h('div.screen');
  const bar = appBar({ title, back: goBack });
  watchScroll(screen, bar);
  screen.append(bar, h('div.page-head', null, h('h1.h1', null, title)), ...content);
  return screen;
}

function pingLabel(p: Proxy): string {
  if (p.pingMs == null) return 'не проверен';
  if (p.pingMs < 0) return 'не отвечает';
  return `${p.pingMs} мс`;
}

/* ───────── Proxies ───────── */

defineRoute('proxy', ({ scope }) => {
  const status = h('div');
  const list = h('div');
  const input = h('input.textfield', { attrs: { placeholder: 'socks5://user:pass@host:1080 или ссылка', autocomplete: 'off' } });
  let state: ProxyState | null = null;

  const render = () => {
    if (!state) return;
    const s = state;
    replaceChildren(
      status,
      s.vpnActive
        ? h('div.banner', null, icon('offline'), 'Включён VPN — прокси не используется, трафик идёт через VPN.')
        : listItem({
            icon: 'storage',
            title: 'Использовать прокси',
            sub: s.inUse ? 'Весь трафик приложения идёт через выбранный прокси' : 'Выключено',
            trailing: switchControl(s.enabled, (on) => call('proxySetEnabled', { enabled: on }).then(load)),
          }),
    );
    replaceChildren(
      list,
      s.proxies.length
        ? s.proxies.map((p) =>
            listItem({
              icon: p.id === s.activeId ? 'check' : 'note',
              title: `${p.type === 'http' ? 'HTTP' : 'SOCKS5'} · ${p.host}:${p.port}`,
              sub: `${pingLabel(p)}${p.user ? ' · с паролем' : ''}`,
              trailing: iconButton('more', 'Действия', (e) => {
                e.stopPropagation();
                actionSheet(h('div.h2', null, `${p.host}:${p.port}`), [
                  { icon: 'check', label: 'Использовать', run: () => call('proxySelect', { id: p.id }).then(load) },
                  { icon: 'sparkle', label: 'Проверить пинг', run: () => ping(p.id) },
                  { icon: 'share', label: 'Поделиться ссылкой', run: async () => call('share', { text: await call('proxyShareLink', { id: p.id }) }) },
                  { icon: 'trash', label: 'Удалить', danger: true, run: () => call('proxyRemove', { id: p.id }).then(load) },
                ]);
              }),
              onClick: () => call('proxySelect', { id: p.id }).then(load),
            }),
          )
        : emptyState('storage', 'Прокси не добавлены', 'Вставьте ссылку выше или откройте ссылку youmusic:// — прокси добавится сам.'),
    );
  };

  const load = async () => {
    state = await call('proxyState');
    render();
  };
  const ping = async (id: string) => {
    const ms = await call('proxyPing', { id });
    toast(ms < 0 ? 'Прокси не отвечает' : `Пинг до YouTube: ${ms} мс`, { icon: ms < 0 ? 'alert' : 'check' });
  };
  scope.add(onNative('proxyChanged', (s) => ((state = s), render())));

  const add = async () => {
    const link = input.value.trim();
    if (!link) return;
    try {
      const p = await call('proxyAdd', { link });
      input.value = '';
      await call('proxySelect', { id: p.id });
      await load();
      ping(p.id);
    } catch (e) {
      toast((e as Error).message, { icon: 'alert' });
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());

  load();
  return page(
    'Прокси',
    status,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-2)', margin: 'var(--s-3) 0' } },
      input,
      h('div', { style: { display: 'flex', gap: 'var(--s-2)' } }, button('Добавить', add, { cls: 'primary', icon: 'plus' }), button('Проверить все', async () => {
        for (const p of state?.proxies ?? []) await call('proxyPing', { id: p.id });
        await load();
      }, { icon: 'sparkle' })),
      h('div.small.faint', null, 'Форматы: socks5://логин:пароль@хост:порт, http://хост:порт, хост:порт, ссылки t.me/socks?… и youmusic://socks?…'),
    ),
    list,
  );
});

/* ───────── Updates ───────── */

const STATUS_TEXT: Record<UpdateState['status'], string> = {
  idle: 'Ещё не проверяли',
  checking: 'Проверяем…',
  uptodate: 'Установлена последняя версия',
  available: 'Доступно обновление',
  downloading: 'Скачиваем…',
  ready: 'Обновление скачано и готово к установке',
  installing: 'Устанавливаем…',
  error: 'Ошибка',
};

defineRoute('updates', ({ scope }) => {
  const card = h('div.pad.stack', { style: { gap: 'var(--s-3)' } });
  const options = h('div');
  scope.effect(() => {
    const u = app.update.value;
    const s = app.settings.value;
    const latest = u?.latest;
    replaceChildren(
      card,
      h('div', null, h('div.small.muted', null, 'Установлено'), h('div.h2.num', null, u?.currentVersion ?? app.version.value.app)),
      latest ? h('div', null, h('div.small.muted', null, `Последняя (${latest.channel})`), h('div.h2.num', null, latest.versionName)) : null,
      h('div.muted', null, u ? `${STATUS_TEXT[u.status]}${u.error ? `: ${u.error}` : ''}` : STATUS_TEXT.idle),
      u?.status === 'downloading' ? h('div.meter', null, h('i', { style: { width: `${Math.round(u.progress * 100)}%` } })) : null,
      latest?.notes && u?.status !== 'uptodate' ? h('div.small', { style: { whiteSpace: 'pre-wrap' } }, latest.notes) : null,
      u?.status === 'ready'
        ? button('Установить', () => call('updateInstall').catch((e) => toast((e as Error).message, { icon: 'alert' })), { cls: 'primary block', icon: 'download' })
        : u?.status === 'available'
          ? button('Скачать', () => call('updateDownload'), { cls: 'primary block', icon: 'download' })
          : button('Проверить сейчас', () => checkUpdates(true), { cls: 'block', icon: 'sparkle' }),
      u?.checkedAt ? h('div.small.faint', null, `Проверено ${new Date(u.checkedAt).toLocaleTimeString('ru-RU')}`) : null,
    );
    replaceChildren(
      options,
      h('div.section-head', null, h('div.small.muted', null, 'Настройки')),
      listItem({
        icon: 'clock',
        title: 'Проверять автоматически',
        sub: 'Каждую минуту, пока приложение открыто, и раз в 15 минут в фоне',
        trailing: switchControl(s.autoUpdate, (autoUpdate) => {
          saveSettings({ autoUpdate });
          call('updateSchedule', { enabled: autoUpdate });
        }),
      }),
      listItem({ icon: 'download', title: 'Скачивать автоматически', sub: 'Останется только нажать «Установить»', trailing: switchControl(s.autoDownloadUpdates, (autoDownloadUpdates) => saveSettings({ autoDownloadUpdates })) }),
      h('div.section-head', null, h('div.small.muted', null, 'Канал')),
      h(
        'div.chips',
        null,
        chip('Nightly — каждая сборка', s.updateChannel === 'nightly', () => saveSettings({ updateChannel: 'nightly' }).then(() => checkUpdates(true))),
        chip('Стабильный — релизы v*', s.updateChannel === 'stable', () => saveSettings({ updateChannel: 'stable' }).then(() => checkUpdates(true))),
      ),
    );
  });
  return page('Обновления', card, options);
});

/* ───────── AI ───────── */

defineRoute('ai', () => {
  const base = h('input.textfield', { attrs: { placeholder: 'https://api.example.com/v1', autocomplete: 'off', inputmode: 'url' } });
  const model = h('input.textfield', { attrs: { placeholder: 'Модель, например gpt-4o-mini', autocomplete: 'off' } });
  const key = h('input.textfield', { attrs: { placeholder: 'API-ключ', autocomplete: 'off', type: 'password' } });
  const toggle = h('div');
  const load = async () => {
    const cfg = await call('aiConfig');
    base.value = cfg.baseUrl;
    model.value = cfg.model;
    key.placeholder = cfg.hasKey ? 'Ключ сохранён — оставьте пустым, чтобы не менять' : 'API-ключ';
    replaceChildren(toggle, listItem({ icon: 'sparkle', title: 'Нейро-рекомендации', sub: 'Подборка на главной и режим «Нейро» в волне', trailing: switchControl(cfg.enabled, async (enabled) => {
      await call('aiConfigure', { enabled });
      await refreshAiConfig();
    }) }));
  };
  const save = async () => {
    await call('aiConfigure', { baseUrl: base.value, model: model.value, key: key.value || undefined, enabled: true });
    key.value = '';
    await refreshAiConfig();
    await load();
    toast('Сохранено', { icon: 'check' });
  };
  const test = async () => {
    try {
      const answer = await call('aiChat', { messages: [{ role: 'user', content: 'Ответь одним словом: работает?' }], temperature: 0 });
      toast(`Нейросеть ответила: ${answer.slice(0, 60)}`, { icon: 'check' });
    } catch (e) {
      toast((e as Error).message, { icon: 'alert' });
    }
  };
  load();
  return page(
    'Нейросеть',
    toggle,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-2)', marginTop: 'var(--s-3)' } },
      h('div.small.muted', null, 'Любой OpenAI-совместимый API (/v1/chat/completions). Нейросеть получает только список исполнителей и названий, которые вы слушаете.'),
      base,
      model,
      key,
      h('div', { style: { display: 'flex', gap: 'var(--s-2)' } }, button('Сохранить', save, { cls: 'primary', icon: 'check' }), button('Проверить', test, { icon: 'sparkle' })),
      h('div.small.faint', null, 'Быстрая настройка ссылкой: youmusic://ai?base=…&model=…&key=…'),
    ),
  );
});

