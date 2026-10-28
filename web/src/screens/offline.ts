import { defineRoute, goBack } from '../app/router';
import { call } from '../bridge/bridge';
import type { Download } from '../bridge/contract';
import { formatBytes, h, replaceChildren, tracksLabel } from '../core/dom';
import { app } from '../core/store';
import { downloadFavorites, downloadLikes, refreshLibrary, removeDownload } from '../services/library';
import { appBar, button, emptyState, iconButton, listenButtons, pageIntro, trackRow, watchScroll } from '../ui/components';
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
  const removeAll = async () => {
    const finished = [...app.downloads.peek().values()].filter((d) => d.status === 'done');
    if (!finished.length) return toast('Ничего не скачано');
    if (await confirmSheet({ title: 'Удалить все загрузки?', text: 'Треки останутся в библиотеке, но без сети играть не будут.', ok: 'Удалить', danger: true })) {
      for (const d of finished) await removeDownload(d.trackId);
      loadStorage();
    }
  };
  const menu = () =>
    actionSheet(h('div.h2', null, 'Скачанное'), [
      { icon: 'download', label: 'Скачать лайки', run: () => void downloadLikes() },
      { icon: 'download', label: 'Скачать избранное (лайки и плейлисты)', run: () => void downloadFavorites() },
      { icon: 'trash', label: 'Удалить все загрузки', danger: true, run: removeAll },
    ]);
  const bar = appBar({ title: 'Скачанное', back: goBack, actions: [iconButton('more', 'Ещё', menu)] });
  watchScroll(screen, bar);
  const intro = h('div');
  const pending = h('section');
  const done = h('section');
  let storage = '';

  const loadStorage = async () => {
    const s = await call('storageInfo').catch(() => null);
    storage = s ? `${formatBytes(s.downloadsBytes)} · свободно ${formatBytes(s.freeBytes)}` : '';
    renderIntro();
  };
  const renderIntro = () => {
    const finished = [...app.downloads.peek().values()].filter((d) => d.status === 'done' && d.track).map((d) => d.track!);
    replaceChildren(intro, pageIntro('Скачанное', [finished.length ? tracksLabel(finished.length) : '', storage].filter(Boolean).join(' · ') || null, listenButtons(finished, 'Скачанное')));
  };

  scope.effect(() => {
    const all = [...app.downloads.value.values()];
    const active = all.filter((d) => d.status !== 'done');
    const finished = all.filter((d) => d.status === 'done' && d.track).map((d) => d.track!);
    renderIntro();
    pending.hidden = !active.length;
    replaceChildren(
      pending,
      h('div.day-head', null, 'В процессе'),
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
        ? trackList(scope, {
            tracks: finished,
            scroller: screen,
            context: { kind: 'list', title: 'Скачанное' },
            menu: (t) => ({ actions: [{ icon: 'trash', label: 'Удалить загрузку', danger: true, run: () => removeDownload(t.id) }] }),
          })
        : h(
            'div',
            null,
            emptyState('download', 'Ничего не скачано', 'Скачивайте треки, альбомы и плейлисты, чтобы слушать без сети.'),
            h('div.page-actions.pad', null, button('Скачать лайки', () => void downloadLikes(), { icon: 'download', cls: 'primary' }), button('Избранное', () => void downloadFavorites(), { icon: 'download' })),
          ),
    );
  });

  loadStorage();
  screen.append(bar, intro, pending, done);
  return screen;
});

defineRoute('local', ({ scope }) => {
  const screen = h('div.screen');
  const importFrom = async (mode: 'files' | 'folder') => {
    try {
      const added = await call('localImport', { mode });
      if (added.length) toast(`Добавлено: ${tracksLabel(added.length)}`, { icon: 'check' });
      await refreshLibrary();
    } catch {
      toast('Не удалось импортировать файлы', { icon: 'alert' });
    }
  };
  const add = () =>
    actionSheet(h('div.h2', null, 'Добавить музыку'), [
      { icon: 'file', label: 'Файлы', run: () => importFrom('files') },
      { icon: 'folder', label: 'Папку целиком', run: () => importFrom('folder') },
    ]);
  const bar = appBar({ title: 'Мои файлы', back: goBack, actions: [iconButton('plus', 'Добавить', add)] });
  watchScroll(screen, bar);
  const body = h('div');
  scope.effect(() => {
    const tracks = app.local.value;
    replaceChildren(
      body,
      tracks.length
        ? [
            pageIntro('Мои файлы', tracksLabel(tracks.length), listenButtons(tracks, 'Мои файлы')),
            trackList(scope, {
              tracks,
              scroller: screen,
              context: { kind: 'list', title: 'Мои файлы' },
              menu: (t) => ({
                actions: [{ icon: 'trash', label: 'Убрать из приложения', danger: true, run: async () => {
                  await call('localRemove', { id: t.id });
                  refreshLibrary();
                } }],
              }),
            }),
          ]
        : [
            pageIntro('Мои файлы', null),
            emptyState('folder', 'Своя музыка', 'MP3, M4A, FLAC, OGG, WAV с телефона. Файлы остаются на месте, приложение только читает их.'),
            h('div.page-actions.pad', null, button('Файлы', () => importFrom('files'), { icon: 'file', cls: 'primary' }), button('Папка', () => importFrom('folder'), { icon: 'folder' })),
          ],
    );
  });
  screen.append(bar, body);
  return screen;
});
