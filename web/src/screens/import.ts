import { defineRoute, goBack, navigate } from '../app/router';
import { call } from '../bridge/bridge';
import type { ImportedList, TgList, Track } from '../bridge/contract';
import { busy } from '../core/busy';
import { server } from '../services/server';
import { formatBytes, h, replaceChildren, tracksLabel } from '../core/dom';
import type { Scope } from '../core/signal';
import { app } from '../core/store';
import { parseTrackList } from '../logic/match';
import { adoptSourceMeta, findTrack } from '../services/catalog';
import { createPlaylist, refreshLibrary } from '../services/library';
import { appBar, button, chip, emptyState, listItem, skeletonRows, watchScroll } from '../ui/components';
import { toast } from '../ui/toast';

/**
 * Moves playlists from Spotify / Yandex Music (by public link), a pasted list / CSV export or the Telegram bot:
 * every track is searched on YouTube and the closest match is added to a new playlist or to likes.
 */

const PARALLEL = 3;

defineRoute('import', ({ scope }) => {
  const screen = h('div.screen');
  const bar = appBar({ title: 'Перенос музыки', back: goBack });
  watchScroll(screen, bar);
  const body = h('div');
  screen.append(bar, h('div.page-head', null, h('h1.h1', null, 'Перенос музыки')), body);
  showSource(scope, body);
  return screen;
});

function showSource(scope: Scope, body: HTMLElement): void {
  const link = h('input.textfield', { attrs: { placeholder: 'Ссылка на плейлист или альбом', inputmode: 'url', autocomplete: 'off' } });
  const text = h('textarea.textfield.area', { attrs: { placeholder: 'Или вставьте список: «Исполнитель — Название», по строке на трек' } });
  const loadLink = async () => {
    const url = link.value.trim();
    if (!url) return;
    loadBtn.disabled = true;
    try {
      showPreview(scope, body, await call('importFetch', { url }));
    } catch (e) {
      toast((e as Error).message, { icon: 'alert' });
    } finally {
      loadBtn.disabled = false;
    }
  };
  const loadBtn = button('Загрузить', loadLink, { cls: 'primary' });
  replaceChildren(
    body,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-3)' } },
      h('div.muted.small', null, 'Spotify и Яндекс Музыка: откройте плейлист → «Поделиться» → «Скопировать ссылку». Плейлист должен быть публичным. «Мне нравится» из Яндекса переносится по ссылке на профиль: music.yandex.ru/users/ЛОГИН/tracks.'),
      link,
      loadBtn,
      h('div.section-head', { style: { padding: '0', marginTop: 'var(--s-2)' } }, h('div.small.muted', null, 'Без ссылки')),
      text,
      h(
        'div',
        { style: { display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' } },
        button('Из списка', () => {
          const tracks = parseTrackList(text.value);
          if (!tracks.length) return toast('Список пуст');
          showPreview(scope, body, { title: 'Импорт', source: 'text', tracks });
        }),
        button('Из файла CSV / TXT', async () => {
          const file = await call('pickTextFile', { mime: 'text/*' });
          if (!file) return;
          const tracks = parseTrackList(file.text);
          if (!tracks.length) return toast('В файле не нашлось треков', { icon: 'alert' });
          showPreview(scope, body, { title: file.name.replace(/\.[^.]+$/, ''), source: 'file', tracks });
        }, { icon: 'file' }),
      ),
      h('div.section-head', { style: { padding: '0', marginTop: 'var(--s-2)' } }, h('div.small.muted', null, 'Из Telegram')),
      button('Музыка из Telegram', () => showTelegram(scope, body), { icon: 'import' }),
      h('div.small.faint', null, 'Большие плейлисты Spotify по ссылке читаются до 100 треков — для полного списка выгрузите CSV через exportify.app и откройте его здесь.'),
    ),
  );
  link.addEventListener('keydown', (e) => e.key === 'Enter' && loadLink());
}

function showPreview(scope: Scope, body: HTMLElement, list: ImportedList): void {
  let target: 'playlist' | 'likes' = 'playlist';
  const chips = h('div.chips', { style: { padding: '0' } });
  const renderChips = () =>
    replaceChildren(chips, chip('Новый плейлист', target === 'playlist', () => ((target = 'playlist'), renderChips())), chip('В «Мне нравится»', target === 'likes', () => ((target = 'likes'), renderChips())));
  renderChips();
  replaceChildren(
    body,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-3)' } },
      h('div.h2', null, list.title),
      h('div.muted', null, `${tracksLabel(list.tracks.length)} · ${list.source === 'spotify' ? 'Spotify' : list.source === 'yandex' ? 'Яндекс Музыка' : 'список'}`),
      chips,
      button('Перенести', () => runImport(scope, body, list, target), { cls: 'primary block' }),
      button('Назад', () => showSource(scope, body), { cls: 'ghost block' }),
    ),
    h('div.section'),
    list.tracks.slice(0, 50).map((t) => listItem({ title: t.title, sub: t.artist })),
  );
}

/**
 * Telegram: the user links the bot to the account, sends audio files there, then imports them here. A song found on
 * YouTube plays from there (with the Telegram cover when it had one); the rest is copied to the phone from the server.
 */
async function showTelegram(scope: Scope, body: HTMLElement): Promise<void> {
  if (!server.peek().signedIn) {
    replaceChildren(
      body,
      h(
        'div.pad.stack',
        { style: { gap: 'var(--s-3)' } },
        h('div.h2', null, 'Музыка из Telegram'),
        h('div.muted', null, 'Перенос идёт через бота You Music и ваш аккаунт: войдите, привяжите Telegram и отправьте боту аудиофайлы.'),
        button('Войти в аккаунт', () => navigate('account'), { cls: 'primary block' }),
        button('Назад', () => showSource(scope, body), { cls: 'ghost block' }),
      ),
    );
    return;
  }
  replaceChildren(body, skeletonRows(4));
  let list: TgList;
  try {
    list = await busy(call('tgTracks'));
  } catch (e) {
    toast((e as Error).message, { icon: 'alert' });
    showSource(scope, body);
    return;
  }
  const link = async () => {
    try {
      const l = await busy(call('tgLink'));
      await call('openUrl', { text: l.url });
      toast('Нажмите «Старт» в боте, затем присылайте музыку', { icon: 'check' });
    } catch (e) {
      toast((e as Error).message, { icon: 'alert' });
    }
  };
  let target: 'playlist' | 'likes' = 'playlist';
  const chips = h('div.chips', { style: { padding: '0' } });
  const renderChips = () =>
    replaceChildren(chips, chip('Новый плейлист', target === 'playlist', () => ((target = 'playlist'), renderChips())), chip('В «Мне нравится»', target === 'likes', () => ((target = 'likes'), renderChips())));
  renderChips();
  replaceChildren(
    body,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-3)' } },
      h('div.h2', null, 'Музыка из Telegram'),
      h('div.muted', null, list.linked
        ? `Пересылайте или отправляйте аудиофайлы боту @${list.bot} — они появятся здесь. До 20 МБ на файл.`
        : `Привяжите Telegram к аккаунту: откроется бот @${list.bot}, нажмите «Старт». Потом отправляйте ему аудиофайлы.`),
      button(list.linked ? 'Открыть бота' : 'Привязать Telegram', list.linked ? () => call('openUrl', { text: `https://t.me/${list.bot}` }) : link, { cls: list.linked ? 'ghost block' : 'primary block' }),
      list.tracks.length ? chips : null,
      list.tracks.length ? button(`Перенести ${tracksLabel(list.tracks.length)}`, () => runTelegramImport(scope, body, list, target), { cls: 'primary block' }) : null,
      button('Обновить', () => showTelegram(scope, body), { cls: 'ghost block' }),
      button('Назад', () => showSource(scope, body), { cls: 'ghost block' }),
    ),
    list.tracks.length ? h('div.section') : emptyState('import', 'Пока пусто', 'Отправьте боту аудиофайлы и нажмите «Обновить».'),
    list.tracks.map((t) => listItem({ title: t.title, sub: [t.artist, formatBytes(t.size)].filter(Boolean).join(' · ') })),
  );
}

async function runTelegramImport(scope: Scope, body: HTMLElement, list: TgList, target: 'playlist' | 'likes'): Promise<void> {
  let cancelled = false;
  scope.add(() => (cancelled = true));
  const fill = h('i', { style: { width: '0%' } });
  const status = h('div.muted.small.num');
  const current = h('div.small.ellipsis');
  replaceChildren(body, h('div.pad.stack', { style: { gap: 'var(--s-3)' } }, h('div.h2', null, 'Переносим из Telegram'), h('div.meter', null, fill), status, current, button('Остановить', () => (cancelled = true), { cls: 'ghost block' })));
  const done: Track[] = [];
  let online = 0;
  let copied = 0;
  let failed = 0;
  for (const [i, t] of list.tracks.entries()) {
    if (cancelled) break;
    current.textContent = `${t.artist ? `${t.artist} — ` : ''}${t.title}`;
    const src = { title: t.title, artist: t.artist, durationMs: t.durationMs, artwork: t.cover ?? null };
    const match = t.artist ? await findTrack(src).catch(() => null) : null;
    try {
      if (match) {
        done.push(adoptSourceMeta(match, src));
        online++;
        void call('tgDelete', { id: t.id }).catch(() => undefined);
      } else {
        done.push(await call('tgImport', { track: t }));
        copied++;
      }
    } catch {
      failed++;
    }
    fill.style.width = `${((i + 1) / list.tracks.length) * 100}%`;
    status.textContent = `${i + 1} из ${list.tracks.length} · с YouTube ${online} · файлом ${copied}${failed ? ` · ошибок ${failed}` : ''}`;
  }
  let playlistId: number | null = null;
  if (done.length) {
    if (target === 'playlist') playlistId = (await createPlaylist('Из Telegram', done)).id;
    else for (const t of [...done].reverse()) await call('like', { track: t, liked: true });
    await refreshLibrary();
  }
  replaceChildren(
    body,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-3)' } },
      h('div.h2', null, cancelled ? 'Перенос остановлен' : 'Готово'),
      h('div.muted', null, `Перенесено ${tracksLabel(done.length)}: ${online} найдено на YouTube, ${copied} скачано файлом${failed ? `, ${failed} не удалось` : ''}.`),
      playlistId != null ? button('Открыть плейлист', () => navigate('playlist', { id: playlistId }), { cls: 'primary block' }) : done.length ? button('Открыть «Мне нравится»', () => navigate('likes'), { cls: 'primary block' }) : null,
      button('Ещё из Telegram', () => showTelegram(scope, body), { cls: 'ghost block' }),
    ),
  );
}

async function runImport(scope: Scope, body: HTMLElement, list: ImportedList, target: 'playlist' | 'likes'): Promise<void> {
  let cancelled = false;
  scope.add(() => (cancelled = true));
  const fill = h('i', { style: { width: '0%' } });
  const status = h('div.muted.small.num');
  const current = h('div.small.ellipsis');
  replaceChildren(
    body,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-3)' } },
      h('div.h2', null, `Переносим «${list.title}»`),
      h('div.meter', null, fill),
      status,
      current,
      button('Остановить', () => (cancelled = true), { cls: 'ghost block' }),
    ),
  );

  const found: (Track | null)[] = new Array(list.tracks.length).fill(null);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (!cancelled && next < list.tracks.length) {
      const i = next++;
      const src = list.tracks[i];
      current.textContent = `${src.artist} — ${src.title}`;
      const match = await findTrack(src).catch(() => null);
      found[i] = match && adoptSourceMeta(match, src);
      done++;
      fill.style.width = `${(done / list.tracks.length) * 100}%`;
      status.textContent = `${done} из ${list.tracks.length} · найдено ${found.filter(Boolean).length}`;
    }
  };
  if (!app.online.peek()) return toast('Для переноса нужна сеть', { icon: 'offline' });
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const matched = [...new Map(found.filter((t): t is Track => !!t).map((t) => [t.id, t])).values()];
  const missing = list.tracks.filter((_, i) => !found[i]);
  let playlistId: number | null = null;
  if (matched.length) {
    if (target === 'playlist') {
      playlistId = (await createPlaylist(list.title, matched)).id;
    } else {
      // Oldest first so the list keeps its order at the top of "Мне нравится".
      for (const t of [...matched].reverse()) await call('like', { track: t, liked: true });
      await refreshLibrary();
    }
  }

  replaceChildren(
    body,
    h(
      'div.pad.stack',
      { style: { gap: 'var(--s-3)' } },
      h('div.h2', null, cancelled ? 'Перенос остановлен' : 'Готово'),
      h('div.muted', null, `Перенесено ${tracksLabel(matched.length)} из ${list.tracks.length}${missing.length ? `, не найдено ${missing.length}` : ''}.`),
      playlistId != null
        ? button('Открыть плейлист', () => navigate('playlist', { id: playlistId }), { cls: 'primary block' })
        : matched.length
          ? button('Открыть «Мне нравится»', () => navigate('likes'), { cls: 'primary block' })
          : null,
      button('Перенести ещё', () => showSource(scope, body), { cls: 'ghost block' }),
    ),
    missing.length
      ? [h('div.section-head', { style: { marginTop: 'var(--s-4)' } }, h('div.small.muted', null, 'Не найдены на YouTube')), missing.map((t) => listItem({ title: t.title, sub: t.artist }))]
      : emptyState('check', 'Всё найдено'),
  );
}
