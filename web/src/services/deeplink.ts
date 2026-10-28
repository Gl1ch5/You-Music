import { navigate } from '../app/router';
import { call, onNative } from '../bridge/bridge';
import { confirmSheet } from '../ui/sheet';
import { toast } from '../ui/toast';
import { refreshAiConfig } from './ai';

/**
 * youmusic:// links:
 *   youmusic://socks?server=H&port=P&user=U&pass=X   youmusic://http?…   youmusic://proxy?url=<socks5://…>
 *   youmusic://ai?base=<url>&model=<id>&key=<key>      youmusic://updates
 */
export async function handleDeepLink(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  const kind = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
  const q = url.searchParams;
  if (kind === 'socks' || kind === 'http' || kind === 'proxy') {
    const where = kind === 'proxy' ? q.get('url') ?? '' : `${q.get('server')}:${q.get('port')}`;
    if (!(await confirmSheet({ title: 'Добавить прокси?', text: where, ok: 'Добавить и включить' }))) return;
    try {
      const p = await call('proxyAdd', { link: raw });
      await call('proxySelect', { id: p.id });
      const ms = await call('proxyPing', { id: p.id });
      toast(ms < 0 ? 'Прокси добавлен, но не отвечает' : `Прокси включён · ${ms} мс`, { icon: ms < 0 ? 'alert' : 'check' });
      navigate('proxy');
    } catch (e) {
      toast((e as Error).message, { icon: 'alert' });
    }
  } else if (kind === 'ai') {
    const base = q.get('base') ?? q.get('url') ?? '';
    const model = q.get('model') ?? '';
    if (!base || !model) return toast('В ссылке нет base или model', { icon: 'alert' });
    if (!(await confirmSheet({ title: 'Подключить нейросеть?', text: `${model}\n${base}`, ok: 'Подключить' }))) return;
    await call('aiConfigure', { baseUrl: base, model, key: q.get('key') ?? undefined, enabled: true });
    await refreshAiConfig();
    toast('Нейро-рекомендации включены', { icon: 'sparkle' });
    navigate('ai');
  } else if (kind === 'updates') {
    navigate('updates');
  } else {
    toast('Неизвестная ссылка', { icon: 'alert' });
  }
}

export function initDeepLinks(): void {
  onNative('deepLink', ({ url }) => {
    call('consumeDeepLink').catch(() => undefined);
    handleDeepLink(url);
  });
  call('consumeDeepLink')
    .then((url) => {
      if (url) handleDeepLink(url);
    })
    .catch(() => undefined);
}
