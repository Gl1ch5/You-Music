import { call, onNative } from '../bridge/bridge';
import type { BackupStatus } from '../bridge/contract';
import { signal } from '../core/signal';
import { app } from '../core/store';
import { h } from '../core/dom';
import { actionSheet, confirmSheet } from '../ui/sheet';
import { toast } from '../ui/toast';

/**
 * Full backup: likes, playlists, history and every setting (themes, mods' state, proxies; the AI key stays on the device).
 * Auto backup writes a copy into a folder the user picked — it survives uninstalling the app.
 */

export const backupStatus = signal<BackupStatus>({ folder: null, savedAt: 0 });

const OFFERED_KEY = 'backup.offered';

const fail = (e: unknown) => toast((e as Error).message, { icon: 'alert' });

export async function exportAll(): Promise<void> {
  try {
    const json = await call('backupExport');
    const date = new Date().toISOString().slice(0, 10);
    if (await call('saveTextFile', { name: `you-music-backup-${date}.json`, text: json, mime: 'application/json' })) toast('Резервная копия сохранена', { icon: 'check' });
  } catch (e) {
    fail(e);
  }
}

/** Settings, theme and mods are re-read on start, so the UI restarts after a restore. */
function restored(n: number): void {
  toast(`Восстановлено треков: ${n}`, { icon: 'check' });
  setTimeout(() => location.reload(), 900);
}

export async function importAll(): Promise<void> {
  const file = await call('pickTextFile', { mime: 'application/json' });
  if (!file) return;
  try {
    restored(await call('backupImport', { json: file.text }));
  } catch (e) {
    fail(e);
  }
}

/** Picks the auto backup folder; offers to restore when it already holds a copy (after reinstalling). */
export async function chooseBackupFolder(): Promise<void> {
  try {
    const r = await call('backupSetFolder', { enabled: true });
    if (!r) return;
    backupStatus.value = r.status;
    const old = r.existing;
    if (!old) return void toast('Автокопия включена', { icon: 'check' });
    const ok = await confirmSheet({
      title: 'В папке уже есть копия',
      text: `${new Date(old.exportedAt).toLocaleString('ru-RU')} · лайков ${old.likes}, плейлистов ${old.playlists}. Восстановить её? Текущие данные объединятся с копией.`,
      ok: 'Восстановить',
    });
    if (ok) restored(await call('backupRestoreFolder'));
  } catch (e) {
    fail(e);
  }
}

export async function disableBackupFolder(): Promise<void> {
  const r = await call('backupSetFolder', { enabled: false }).catch(() => null);
  if (r) backupStatus.value = r.status;
}

export async function backupNow(): Promise<void> {
  const ok = await call('backupNow').catch(() => false);
  toast(ok ? 'Копия обновлена' : backupStatus.peek().error || 'Не удалось сохранить копию', { icon: ok ? 'check' : 'alert' });
}

export function backupSub(s: BackupStatus): string {
  if (!s.folder) return 'Выключена — после переустановки данные пропадут';
  if (s.error) return `Ошибка: ${s.error}`;
  return s.savedAt ? `«${s.folder}» · сохранено ${new Date(s.savedAt).toLocaleString('ru-RU')}` : `«${s.folder}»`;
}

/** First start with an empty library (e.g. after reinstalling): offer to restore once. */
async function offerRestore(): Promise<void> {
  if (app.likes.peek().length || app.playlists.peek().length || backupStatus.peek().folder) return;
  if (await call('kvGet', { key: OFFERED_KEY }).catch(() => '1')) return;
  await call('kvSet', { key: OFFERED_KEY, value: '1' });
  toast('Переустановили приложение? Верните лайки и настройки из копии', {
    icon: 'import',
    duration: 10_000,
    action: {
      label: 'Восстановить',
      run: () =>
        actionSheet(h('div.h2', null, 'Восстановить данные'), [
          { icon: 'folder', label: 'Из папки автокопии', sub: 'Выберите папку, где лежит you-music-backup.json', run: () => chooseBackupFolder() },
          { icon: 'import', label: 'Из файла', sub: 'Файл «Экспорт всего» или экспорт библиотеки', run: () => importAll() },
        ]),
    },
  });
}

export function initBackup(): void {
  onNative('backupState', (s) => (backupStatus.value = s));
  call('backupStatus')
    .then((s) => (backupStatus.value = s))
    .catch(() => undefined)
    .finally(() => setTimeout(() => offerRestore().catch(() => undefined), 4_000));
}
