import { defineRoute, goBack, navigate } from '../app/router';
import { call } from '../bridge/bridge';
import { formatBytes, h, replaceChildren } from '../core/dom';
import { app, type Settings } from '../core/store';
import { installModFlow, mods, removeMod, setModEnabled } from '../mods/host';
import { guard, slots } from '../mods/registry';
import { backupNow, backupStatus, backupSub, chooseBackupFolder, disableBackupFolder, exportAll, importAll } from '../services/backup';
import { RELEASES_URL } from '../services/playback';
import { saveSettings } from '../services/settings';
import { activeTheme, allThemes, applyTheme, customThemes } from '../theme/engine';
import { appBar, button, emptyState, listItem, switchControl, watchScroll } from '../ui/components';
import { actionSheet, confirmSheet } from '../ui/sheet';
import { toast } from '../ui/toast';

const QUALITY: Record<Settings['streamQuality'], string> = { high: 'Высокое', normal: 'Обычное', low: 'Экономия трафика' };
const MOTION: Record<Settings['motion'], string> = { system: 'Как в системе', reduced: 'Уменьшить', full: 'Всегда плавно' };

function choose<K extends string>(title: string, options: Record<K, string>, current: K, onPick: (k: K) => void): void {
  actionSheet(
    h('div.h2', null, title),
    (Object.keys(options) as K[]).map((k) => ({ icon: k === current ? 'check' : 'note', label: options[k], run: () => onPick(k) })),
  );
}

function group(title: string, ...items: HTMLElement[]): HTMLElement {
  return h('section.section', null, h('div.section-head', null, h('div.small.muted', null, title)), items);
}

defineRoute('settings', ({ scope }) => {
  const screen = h('div.screen');
  const bar = appBar({ title: 'Настройки', back: goBack });
  watchScroll(screen, bar);
  const body = h('div');
  const storageSub = h('span');

  const refreshStorage = () =>
    call('storageInfo')
      .then((s) => (storageSub.textContent = `Загрузки ${formatBytes(s.downloadsBytes)} · кэш ${formatBytes(s.cacheBytes)}`))
      .catch(() => undefined);

  scope.effect(() => {
    const s = app.settings.value;
    const theme = activeTheme.value;
    const v = app.version.value;
    const backup = backupStatus.value;
    replaceChildren(
      body,
      group(
        'Оформление',
        listItem({ icon: 'palette', title: 'Тема', sub: theme.name, onClick: () => pickTheme() }),
        listItem({ icon: 'edit', title: 'Редактор тем', sub: 'Цвета, скругления, зерно, анимации', onClick: () => navigate('themeEditor', { id: theme.id }) }),
        listItem({ icon: 'sparkle', title: 'Анимации', sub: MOTION[s.motion], onClick: () => choose('Анимации', MOTION, s.motion, (motion) => saveSettings({ motion })) }),
      ),
      group(
        'Звук и поиск',
        listItem({ icon: 'note', title: 'Качество потока', sub: QUALITY[s.streamQuality], onClick: () => choose('Качество потока', QUALITY, s.streamQuality, (streamQuality) => saveSettings({ streamQuality })) }),
        listItem({
          icon: 'similar',
          title: 'Плавные переходы',
          sub: s.crossfadeSec ? `Затухание ${s.crossfadeSec} с между треками` : 'Выключены',
          onClick: () => choose<string>('Плавные переходы', { '0': 'Выключены', '2': '2 секунды', '4': '4 секунды', '6': '6 секунд', '8': '8 секунд' }, String(s.crossfadeSec), (v) => saveSettings({ crossfadeSec: Number(v) })),
        }),
        listItem({ icon: 'sparkle', title: 'Нейро-рекомендации', sub: app.aiEnabled.value ? 'Включены' : 'Настроить модель и API', onClick: () => navigate('ai') }),
        listItem({ icon: 'search', title: 'Скрывать версии в поиске', sub: 'Sped up, slowed, nightcore — только если ищете их', trailing: switchControl(s.hideVersionsInSearch, (hideVersionsInSearch) => saveSettings({ hideVersionsInSearch })) }),
      ),
      group(
        'Загрузки и место',
        listItem({ icon: 'download', title: 'Качество загрузок', sub: QUALITY[s.downloadQuality], onClick: () => choose('Качество загрузок', QUALITY, s.downloadQuality, (downloadQuality) => saveSettings({ downloadQuality })) }),
        listItem({ icon: 'heart', title: 'Скачивать лайкнутые', sub: 'Трек сохраняется целиком, как только вы его лайкнули', trailing: switchControl(s.autoDownloadLiked, (autoDownloadLiked) => saveSettings({ autoDownloadLiked })) }),
        listItem({ icon: 'offline', title: 'Скачивать только по Wi-Fi', trailing: switchControl(s.wifiOnlyDownloads, (wifiOnlyDownloads) => saveSettings({ wifiOnlyDownloads })) }),
        listItem({
          icon: 'storage',
          title: 'Размер кэша',
          sub: `${s.cacheLimitMb} МБ · применится после перезапуска`,
          onClick: () =>
            choose<string>('Размер кэша', { '256': '256 МБ', '512': '512 МБ', '1024': '1 ГБ', '2048': '2 ГБ', '4096': '4 ГБ' }, String(s.cacheLimitMb), (v) => saveSettings({ cacheLimitMb: Number(v) })),
        }),
        h('div.item', null, h('div.item-main', null, h('div', null, 'Хранилище'), h('div.item-sub', null, storageSub)), button('Очистить кэш', async () => {
          await call('clearCache');
          toast('Кэш очищен', { icon: 'check' });
          refreshStorage();
        }, { cls: 'ghost' })),
      ),
      group(
        'Резервная копия',
        listItem({
          icon: 'folder',
          title: 'Автокопия в папку',
          sub: backupSub(backup),
          onClick: () => (backup.folder ? backupMenu() : chooseBackupFolder()),
        }),
        listItem({ icon: 'export', title: 'Экспорт всего', sub: 'Лайки, плейлисты, история, настройки, темы и прокси (без ключа нейросети)', onClick: exportAll }),
        listItem({ icon: 'import', title: 'Импорт всего', sub: 'Из файла копии или старого экспорта библиотеки', onClick: importAll }),
      ),
      group(
        'Библиотека',
        listItem({ icon: 'playlist', title: 'Перенос из Spotify и Яндекс Музыки', sub: 'По ссылке, списком или CSV', onClick: () => navigate('import') }),
      ),
      group(
        'Сеть',
        listItem({ icon: 'storage', title: 'Прокси', sub: 'SOCKS5 / HTTP, пинг, переключение. Не работает при включённом VPN', onClick: () => navigate('proxy') }),
      ),
      group('Моды', listItem({ icon: 'puzzle', title: 'Моды', sub: `${mods.value.filter((m) => m.state.enabled).length} включено`, onClick: () => navigate('mods') })),
      group(
        'О приложении',
        listItem({ icon: 'info', title: 'You Music', sub: `Версия ${v.app} · NewPipeExtractor ${v.extractor}` }),
        listItem({ icon: 'download', title: 'Обновления', sub: updateSub(), onClick: () => navigate('updates') }),
        listItem({ icon: 'export', title: 'Все релизы на GitHub', onClick: () => call('openUrl', { text: RELEASES_URL }) }),
      ),
    );
  });

  refreshStorage();
  screen.append(bar, h('div.page-head', null, h('h1.h1', null, 'Настройки')), body);
  return screen;
});

function updateSub(): string {
  const u = app.update.value;
  if (!u) return 'Проверить и установить новую версию';
  if (u.status === 'ready') return `Готово к установке: ${u.latest?.versionName}`;
  if (u.status === 'available') return `Доступна ${u.latest?.versionName}`;
  return u.status === 'uptodate' ? 'Последняя версия' : 'Проверить и установить новую версию';
}

function pickTheme(): void {
  actionSheet(
    h('div.h2', null, 'Тема'),
    allThemes().map((t) => ({
      icon: t.id === activeTheme.peek().id ? 'check' : 'palette',
      label: t.name,
      sub: customThemes.peek().some((c) => c.id === t.id) ? 'Своя тема' : undefined,
      run: () => {
        applyTheme(t);
        saveSettings({ themeId: t.id });
      },
    })),
  );
}

function backupMenu(): void {
  actionSheet(h('div.h2', null, 'Автокопия'), [
    { icon: 'check', label: 'Сохранить сейчас', run: () => backupNow() },
    { icon: 'folder', label: 'Выбрать другую папку', run: () => chooseBackupFolder() },
    { icon: 'close', label: 'Выключить', run: () => disableBackupFolder() },
  ]);
}

defineRoute('mods', ({ scope }) => {
  const screen = h('div.screen');
  const bar = appBar({ title: 'Моды', back: goBack });
  watchScroll(screen, bar);
  const list = h('div');
  scope.effect(() => {
    const entries = mods.value;
    const settings = slots.settings.value;
    replaceChildren(
      list,
      entries.length
        ? entries.map((e) =>
            h(
              'div',
              null,
              listItem({
                icon: 'puzzle',
                title: e.mod.manifest.name,
                sub: e.error ? `Отключён: ${e.error}` : `${e.mod.manifest.version}${e.mod.manifest.author ? ' · ' + e.mod.manifest.author : ''}`,
                trailing: switchControl(e.state.enabled, (on) => setModEnabled(e.mod.id, on)),
                onClick: () =>
                  actionSheet(h('div.h2', null, e.mod.manifest.name), [
                    ...settings.filter((s) => s.modId === e.mod.id).map((s) => ({ icon: 'settings', label: s.title, run: () => navigate('modPanel', { kind: 'settings', modId: s.modId, id: s.id }) })),
                    { icon: 'trash', label: 'Удалить мод', danger: true, run: async () => {
                      if (await confirmSheet({ title: `Удалить «${e.mod.manifest.name}»?`, text: 'Настройки мода тоже удалятся.', ok: 'Удалить', danger: true })) removeMod(e.mod.id);
                    } },
                  ]),
              }),
            ),
          )
        : emptyState('puzzle', 'Модов пока нет', 'Моды добавляют кнопки, вкладки, фильтры поиска и рекомендаций, темы иконок. Мод — это zip с manifest.json.'),
    );
  });
  screen.append(
    bar,
    h('div.page-head', null, h('h1.h1', null, 'Моды')),
    h('div.pad', { style: { display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-3)' } }, button('Из ZIP', () => installModFlow('zip'), { icon: 'import', cls: 'primary' }), button('Из папки', () => installModFlow('folder'), { icon: 'folder' })),
    list,
  );
  return screen;
});

/** Hosts a mod-provided tab or settings screen. */
defineRoute('modPanel', ({ scope, params }) => {
  const list = params.kind === 'settings' ? slots.settings.peek() : slots.tabs.peek();
  const panel = list.find((p) => p.modId === params.modId && p.id === params.id);
  const screen = h('div.screen');
  const bar = appBar({ title: panel?.title ?? 'Мод', back: goBack, alwaysTitle: true });
  const container = h('div.pad');
  screen.append(bar, container);
  if (!panel) {
    container.appendChild(emptyState('puzzle', 'Мод отключён'));
    return screen;
  }
  const cleanup = guard(panel.modId, panel.render)(container);
  if (typeof cleanup === 'function') scope.add(guard(panel.modId, cleanup));
  return screen;
});
