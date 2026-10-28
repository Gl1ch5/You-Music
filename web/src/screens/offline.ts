import { defineRoute, goBack } from '../app/router';
import { call } from '../bridge/bridge';
import type { Download } from '../bridge/contract';
import { formatBytes, h, replaceChildren, tracksLabel } from '../core/dom';
import { app } from '../core/store';
import { downloadFavorites, downloadLikes, refreshLibrary, removeDownload } from '../services/library';
import { appBar, button, emptyState, trackRow, watchScroll } from '../ui/components';
import { actionSheet, confirmSheet } from '../ui/sheet';
import { toast } from '../ui/toast';
import { trackList } from '../ui/trackList';
import { trackHeader } from '../ui/trackMenu';

function statusText(d: Download): string {
  if (d.status === 'queued') return 'В очереди';
  if (d.status === 'running') return `Загрузка ${Math.round(d.progress * 100)}%`;
  if (d.status === 'failed') return `Ошибка: ${d.error ?? ''}`;
  return '';
}

defineRoute('downloads', ({ scope }) => {
  const screen = h('div.screen');
  const bar = appBar({ title: 'Скачанное', back: goBack });
  watchScroll(screen, bar);
  const storage = h('div.pad.stack', { style: { gap: 'var(--s-1)' } });
  const pending = h('section');
  const done = h('section');

  const loadStorage = async () => {
    const s = await call('storageInfo').catch(() => null);
    if (!s) return;
    const total = s.downloadsBytes + s.cacheBytes + s.freeBytes || 1;
    replaceChildren(
      storage,
      h('div.meter', null, h('i', { style: { width: `${(s.downloadsBytes / total) * 100}%` } }), h('i', { style: { width: `${(s.cacheBytes / total) * 100}%` } })),
      h('div.small.muted', null, `Загрузки ${formatBytes(s.downloadsBytes)} · Кэш ${formatBytes(s.cacheBytes)} из ${formatBytes(s.cacheLimitBytes)} · Свободно ${formatBytes(s.freeBytes)}`),
    );
  };

  scope.effect(() => {
    const all = [...app.downloads.value.values()];
    const active = all.filter((d) => d.status !== 'done');
    const finished = all.filter((d) => d.status === 'done' && d.track).map((d) => d.track!);
    pending.hidden = !active.length;
    replaceChildren(
      pending,
      h('div.section-head', null, h('h2.h2', null, 'В процессе')),
      active.map((d) =>
        d.track
          ? trackRow(d.track, {
              sub: statusText(d),
              onPlay: () => undefined,
              onMore: () => actionSheet(trackHeader(d.track!), [{ icon: 'close', label: 'Отменить загрузку', danger: true, run: () => removeDownload(d.trackId) }]),
            })
          : null,
      ),
    );
    replaceChildren(
      done,
      finished.length
        ? [
            h('div.section-head', null, h('h2.h2', { style: { flex: '1' } }, tracksLabel(finished.length)), button('Удалить все', async () => {
              if (await confirmSheet({ title: 'Удалить все загрузки?', ok: 'Удалить', danger: true })) {
                for (const t of finished) await removeDownload(t.id);
                loadStorage();
              }
            }, { cls: 'ghost danger' })),
            trackList(scope, {
              tracks: finished,
              scroller: screen,
              context: { kind: 'list', title: 'Скачанное' },
              menu: (t) => ({ actions: [{ icon: 'trash', label: 'Удалить загрузку', danger: true, run: () => removeDownload(t.id) }] }),
            }),
          ]
        : emptyState('download', 'Ничего не скачано', 'Скачивайте треки, альбомы и плейлисты, чтобы слушать без сети.'),
    );
  });

  loadStorage();
  screen.append(bar, h('div.page-head', null, h('h1.h1', null, 'Скачанное')), storage, offlineButtons(), pending, h('div.section', null, done));
  return screen;
});

defineRoute('local', ({ scope }) => {
  const screen = h('div.screen');
  const bar = appBar({ title: 'Мои файлы', back: goBack });
  watchScroll(screen, bar);
  const body = h('div');
  const importFrom = async (mode: 'files' | 'folder') => {
    try {
      const added = await call('localImport', { mode });
      if (added.length) toast(`Добавлено: ${tracksLabel(added.length)}`, { icon: 'check' });
      await refreshLibrary();
    } catch {
      toast('Не удалось импортировать файлы', { icon: 'alert' });
    }
  };
  scope.effect(() => {
    const tracks = app.local.value;
    replaceChildren(
      body,
      tracks.length
        ? trackList(scope, {
            tracks,
            scroller: screen,
            context: { kind: 'list', title: 'Мои файлы' },
            menu: (t) => ({
              actions: [{ icon: 'trash', label: 'Убрать из приложения', danger: true, run: async () => {
                await call('localRemove', { id: t.id });
                refreshLibrary();
              } }],
            }),
          })
        : emptyState('folder', 'Своя музыка', 'Добавьте аудиофайлы с телефона: MP3, M4A, FLAC, OGG, WAV. Файлы остаются на месте, приложение только читает их.'),
    );
  });
  screen.append(
    bar,
    h('div.page-head', null, h('h1.h1', null, 'Мои файлы')),
    h('div.pad', { style: { display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-3)' } }, button('Файлы', () => importFrom('files'), { icon: 'file', cls: 'primary' }), button('Папка', () => importFrom('folder'), { icon: 'folder' })),
    body,
  );
  return screen;
});

/** "Download likes" / "Download favourites (likes + playlists)". */
function offlineButtons(): HTMLElement {
  return h(
    'div.button-row',
    null,
    button('Скачать лайки', () => void downloadLikes(), { icon: 'download' }),
    button('Скачать избранное', () => void downloadFavorites(), { icon: 'download' }),
  );
}
