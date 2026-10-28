import { call, onNative } from '../bridge/bridge';
import type { UpdateState } from '../bridge/contract';
import { app } from '../core/store';
import { toast } from '../ui/toast';

/** OTA: checks every minute while the app is visible (native WorkManager covers the background). */

const INTERVAL = 60_000;
let announced = 0;

export async function checkUpdates(force = false): Promise<void> {
  if (!force && (!app.settings.peek().autoUpdate || document.visibilityState !== 'visible' || !app.online.peek())) return;
  const s = await call('updateCheck').catch(() => null);
  if (s) setState(s);
}

function setState(s: UpdateState): void {
  app.update.value = s;
  const code = s.latest?.versionCode ?? 0;
  if ((s.status === 'ready' || s.status === 'available') && code > announced) {
    announced = code;
    toast(`Доступна версия ${s.latest?.versionName}`, {
      icon: 'download',
      duration: 8000,
      action: s.status === 'ready' ? { label: 'Установить', run: () => call('updateInstall') } : { label: 'Скачать', run: () => call('updateDownload') },
    });
  }
}

export function initUpdates(): void {
  onNative('updateState', setState);
  call('updateState').then((s) => (app.update.value = s)).catch(() => undefined);
  setTimeout(() => checkUpdates(), 5_000);
  setInterval(() => checkUpdates(), INTERVAL);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkUpdates());
}
