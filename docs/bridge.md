# Мост UI ↔ Android

Один типизированный контракт. Источник истины для типов — `web/src/bridge/contract.ts`; нативная сторона — модули в `android/app/src/main/java/app/youmusic/bridge/modules/`.

## Транспорт

* UI грузится только через `WebViewAssetLoader` с origin `https://appassets.androidplatform.net` (никакого `file://`).
* Нативный объект `youBridge` внедряется `WebViewCompat.addWebMessageListener` **только для этого origin**. `web/src/bridge/bridge.ts` забирает его и удаляет из `window`, поэтому остальной UI (и моды) не видят платформу.
* Звук никогда не играет в WebView: CSP страницы содержит `media-src 'none'`, всё воспроизведение — Media3 в `PlaybackService`.

Сообщения — JSON-строки:

```jsonc
// UI → native
{ "id": 7, "cmd": "search", "args": { "query": "rasputin", "filter": "all" } }
// native → UI: ответ
{ "type": "res", "id": 7, "ok": true, "result": { "items": [...], "nextPage": "…" } }
{ "type": "res", "id": 7, "ok": false, "error": { "code": "network", "message": "…" } }
// native → UI: событие
{ "type": "event", "name": "progress", "data": { "positionMs": 1200, "durationMs": 215000, "bufferedMs": 40000 } }
```

### Веб-плеер и приложение для компьютера

`bridge.ts` выбирает транспорт: `youBridge` на Android, `web.ts` в сборке `vite build --mode web`, иначе `mock.ts`. Экспорт `platform` — `'android' | 'web' | 'desktop' | 'mock'` (`desktop` — когда бэкенд проставил `<html data-platform="desktop">`).

`web.ts` реализует те же команды поверх Python-бэкенда (`desktop/youmusic/app.py`): каталог и поток — `api/*`, звук — `<audio>` из `api/stream/<id>` (в веб-сборке CSP `media-src 'self' blob:`), аккаунт — `server/*` проксируется на сервер. Библиотека и kv — в `localStorage` (`ym.*`) в формате полной копии Android, свои файлы — в IndexedDB. Скачивание, прокси и открытие ссылок — только на компьютере; иконка, моды, обновления и папка копий — только на Android (в настройках скрыты).

В JS: `call('search', { query, filter })` → `Promise<SearchPage>`, `onNative('progress', fn)`.

## Коды ошибок

| code | Что значит | Что делает UI |
|---|---|---|
| `network` | Ошибка сети | Тост, «Повторить» |
| `offline` | Нет сети, а трек не скачан | Тост с иконкой офлайна |
| `unavailable` | Видео недоступно / 18+ | Тост, плеер сам переходит к следующему |
| `extraction` | YouTube поменял разметку, NewPipeExtractor устарел | Сообщение + кнопка «Обновить приложение» |
| `captcha` | YouTube временно ограничил запросы | Тост |
| `bad_request`, `not_found`, `bad_mod`, `unknown_command`, `internal`, `cancelled` | Прочее | Тост |

## Команды

| Команда | Аргументы | Результат |
|---|---|---|
| **Система** | | |
| `hello` | — | `{appVersion, extractorVersion, sdkInt, online, insets}` |
| `kvGet` / `kvSet` / `kvKeys` | `{key}` / `{key, value\|null}` / `{prefix}` | строка / — / ключи |
| `haptic` | `{kind: light\|medium\|confirm}` | — |
| `share`, `openUrl` | `{text}` | — (`openUrl` — только https) |
| `moveToBack`, `setSystemBars` | — / `{light}` | — |
| `appIconGet` / `appIconSet` | — / `{id}` | id иконки лаунчера (`classic`, `01`…`20`); смена включает нужный `activity-alias` |
| `pickTextFile`, `saveTextFile` | `{mime}` / `{name, text, mime}` | `{name, text}\|null` / `boolean` |
| **Плеер** | | |
| `play` | `{queue: Track[], index, positionMs?}` | — |
| `pause`, `resume`, `next`, `previous`, `queueClear` | — | — |
| `seek` | `{positionMs}` | — |
| `skipTo`, `queueRemove` | `{index}` | — |
| `queueAdd` | `{tracks, next?}` | — |
| `queueMove` | `{from, to}` | — |
| `queueReplaceUpcoming` | `{tracks}` | — (заменяет всё после текущего трека одним изменением очереди) |
| `setRepeat`, `setShuffle` | `{mode: off\|all\|one}` / `{enabled}` | — |
| `getPlayerState` | — | `PlayerState` |
| `trackInfo` | `{track}` | `TrackInfo` — откуда играет (`download\|cache\|stream\|local`), контейнер, кодек, битрейт, частота, размер |
| **Каталог (YouTube)** | | |
| `search` | `{query, filter: all\|songs\|videos\|albums\|artists\|playlists, page?}` | `SearchPage` |
| `searchSuggestions` | `{query}` | `string[]` |
| `trackDetails` | `{id}` | `{track, related}` |
| `trackRadio` | `{id}` | `Track[]` — радио YouTube Music по треку (микс `RDAMVM<id>`, запасной — `RD<id>`), первая страница ≈25 песен без самого трека; основа рекомендаций и волн |
| `getCollection` / `getArtist` | `{url}` | `CollectionPage` / `ArtistPage` |
| `lyrics` | `{artist, title, durationMs}` | `{plain?, synced?}` (LRCLIB: точный запрос, затем поиск по очищенному названию, ближайший по длительности, синхронный текст в приоритете) |
| `translate` | `{lines, to}` | `{lines, from?}` — перевод текста песни построчно (Google Translate без ключа), строки совпадают с оригиналом |
| `importFetch` | `{url}` | `{title, source, tracks: {title, artist, durationMs}[], via?}` — список из Spotify / Яндекс Музыки по публичной ссылке. Если Яндекс не пускает текущую сеть (451, капча, таймаут), запросы идут через бесплатные российские прокси (`net/FreeProxies.kt`); `via` — какой прокси сработал |
| `chart` | `{source: yandex}` | `ImportedList` — чарт Яндекс Музыки (как перенос: напрямую, при 451 — через бесплатные прокси); UI сопоставляет треки с YouTube |
| `trackFeatures` | `{tracks: {id, artist, title, durationMs}[]}` | `{[id]: {found, bpm?, gainDb?, genres, explicit, year?, rank?, cover?}}` — темп, громкость, жанры из публичного API Deezer; кэш на диске (`features.json`), до 40 новых треков за вызов. Только для рекомендаций |
| `artworkPalette` | `{url}` | `{blurUrl, color}` — размытая обесцвеченная обложка + приглушённый тон |
| **Библиотека** | | |
| `getLibrary` | — | `{likes, playlists, downloads, local}` |
| `like` | `{track, liked}` | — |
| `playlistCreate` / `playlistRename` / `playlistDelete` / `playlistGet` | … | `Playlist` / — / — / `PlaylistPage` |
| `playlistAdd` / `playlistRemove` / `playlistMove` | `{id, tracks}` / `{id, index}` / `{id, from, to}` | — |
| `history`, `historyClear` | `{limit}` / — | `HistoryEntry[]` (с `listenedMs`, `completed`, `skipped`) |
| `libraryExport`, `libraryImport` | — / `{json}` | JSON / число треков (импорт: плейлист с тем же именем заменяется, а не дублируется) |
| `backupExport` | — | JSON полной копии (`you-music-library` v2: + `history`, `settings` — все kv, ключ нейросети вырезан) |
| `backupImport` | `{json}` | число треков; принимает и старый экспорт v1; восстанавливает kv, перечитывает прокси, ключ нейросети на устройстве сохраняется |
| `backupStatus` | — | `BackupStatus {folder?, savedAt, error?}` |
| `backupSetFolder` | `{enabled}` | `BackupFolder {status, existing?}` или `null` (выбор отменён); `existing` — в папке уже лежит копия |
| `backupRestoreFolder` | — | число треков (из `you-music-backup.json` в папке автокопии) |
| `backupNow` | — | `true`, если копия записана (пустая библиотека не затирает существующую копию) |
| **Аккаунт You Music (сервер, необязательно)** | | |
| `serverStatus` | — | `ServerStatus {signedIn, login?, syncedAt, syncing, syncError?, ai{enabled,limit,left}, proxyAvailable, proxyOn}` (обновляет данные с сервера) |
| `serverAuth` | `{login, password, register?}` | `ServerStatus`; после входа библиотека сливается с облачной |
| `serverLogout` | — | `ServerStatus`; бесплатный прокси отключается |
| `serverSync` | — | `ServerStatus`; забрать облако (если менялось на другом устройстве, слияние без удалений) и отправить своё. Автоматически через 20 с после изменений и при запуске |
| `serverProxy` | `{on}` | `ServerStatus`; прокси аккаунта (`id: "server"`, логин/пароль наружу не отдаются) |
| `tgLink` | — | `{code, url, linked}`: одноразовая ссылка `t.me/<бот>?start=<код>` (15 мин), привязывает чат с ботом к аккаунту |
| `tgTracks` | — | `{linked, bot, tracks: TgTrack[]}` — аудиофайлы, присланные боту (`cover` — полный URL или null) |
| `tgImport` | `{track: TgTrack, artwork?}` | `Track` (`local:tg-…`): файл скачивается в `files/telegram`, обложка — из Telegram → `artwork` → сгенерированная; копия на сервере удаляется |
| `tgDelete` | `{id}` | Удаляет присланный файл с сервера |
| **Офлайн** | | |
| `download` | `{tracks, quality?}` | — (очередь WorkManager) |
| `downloadRemove` | `{id}` | — |
| `downloads`, `storageInfo`, `clearCache` | — | `Download[]` / `StorageInfo` / — |
| `localImport` | `{mode: files\|folder}` | `Track[]` (системный выбор файлов) |
| `localRemove` | `{id}` | — |
| **Сеть и прокси** | | |
| `proxyState` | — | `{proxies, activeId, enabled, vpnActive, inUse}` |
| `proxyAdd` | `{link}` | `Proxy` — socks5://…, http://…, host:port, t.me/socks?…, youmusic://socks?… |
| `proxyRemove` / `proxySelect` / `proxyShareLink` | `{id}` | — / — / ссылка youmusic:// |
| `proxySetEnabled` | `{enabled}` | — |
| `proxyPing` | `{id}` | мс до YouTube через прокси, `-1` — не отвечает |
| **Обновления (OTA)** | | |
| `updateState` / `updateCheck` / `updateDownload` | — | `UpdateState` |
| `updateInstall` | — | — (сначала обновляет автокопию; ошибка `signature`, если APK подписан другим ключом; PackageInstaller, система может попросить подтверждение) |
| `updateSchedule` | `{enabled}` | — (фоновая проверка WorkManager, раз в 15 мин) |
| **Нейросеть** | | |
| `aiConfig` | — | `{baseUrl, model, enabled, hasKey, server}` (ключ наружу не отдаётся; `server` — доступна нейросеть аккаунта, она используется, если своя выключена) |
| `aiConfigure` | `{baseUrl?, model?, key?, enabled?}` | `AiConfig` |
| `aiChat` | `{messages, temperature?, tier?: fast\|deep}` | текст ответа (OpenAI-совместимый `/chat/completions`). Своя нейросеть (если включена) важнее нейросети аккаунта; `tier` выбирает модель аккаунта (быстрая/тщательная) |
| `consumeDeepLink` | — | ссылка `youmusic://…`, с которой открыли приложение, или `null` |
| **Моды** | | |
| `modsList` | — | `InstalledMod[]` |
| `modStage` | `{kind: zip\|folder}` | `{stageId, manifest}\|null` |
| `modInstall`, `modRemove` | `{stageId}` / `{id}` | `InstalledMod` / — |

## События

| Событие | Данные |
|---|---|
| `progress` | `{positionMs, durationMs, bufferedMs}` — раз в 500 мс во время игры; UI интерполирует через `requestAnimationFrame` |
| `stateChanged` | `{playing, playWhenReady, buffering, repeat, shuffle, ended}` |
| `trackChanged` | `{track, index}` |
| `queueChanged` | `{queue, index}` |
| `playerError` | `{code, message, trackId}` |
| `downloadProgress` | `Download` (статус `queued\|running\|done\|failed\|removed`) |
| `libraryChanged` | `{what}` |
| `network` | `{online, unmetered, vpn}` |
| `insets` | `{top, bottom, left, right}` в dp |
| `proxyChanged` | `ProxyState` |
| `updateState` | `UpdateState` (прогресс скачивания, готовность, `signatureMismatch`) |
| `backupState` | `BackupStatus` (после каждой записи автокопии) |
| `serverState` | `ServerStatus` (вход/выход, начало и конец синхронизации) |
| `deepLink` | `{url}` — открыта ссылка `youmusic://…` |
| `back` | — (системная кнопка «Назад») |

## Как добавить новую нативную функцию

1. Реализовать логику (репозиторий/сервис) и добавить его в `AppGraph` (`YouMusicApp.kt`).
2. Создать `XxxModule : BridgeModule` и зарегистрировать команды: `command<Args, Result>("name") { … }`.
3. Подключить модуль в `MainActivity` (список модулей).
4. Описать типы в `web/src/bridge/contract.ts` и в этой таблице; при необходимости добавить заглушку в `web/src/bridge/mock.ts`.
