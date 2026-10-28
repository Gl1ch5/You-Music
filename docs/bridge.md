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
| `pickTextFile`, `saveTextFile` | `{mime}` / `{name, text, mime}` | `{name, text}\|null` / `boolean` |
| **Плеер** | | |
| `play` | `{queue: Track[], index, positionMs?}` | — |
| `pause`, `resume`, `next`, `previous`, `queueClear` | — | — |
| `seek` | `{positionMs}` | — |
| `skipTo`, `queueRemove` | `{index}` | — |
| `queueAdd` | `{tracks, next?}` | — |
| `queueMove` | `{from, to}` | — |
| `setRepeat`, `setShuffle` | `{mode: off\|all\|one}` / `{enabled}` | — |
| `getPlayerState` | — | `PlayerState` |
| **Каталог (YouTube)** | | |
| `search` | `{query, filter: all\|songs\|videos\|albums\|artists\|playlists, page?}` | `SearchPage` |
| `searchSuggestions` | `{query}` | `string[]` |
| `trackDetails` | `{id}` | `{track, related}` |
| `getCollection` / `getArtist` | `{url}` | `CollectionPage` / `ArtistPage` |
| `lyrics` | `{artist, title, durationMs}` | `{plain?, synced?}` (LRCLIB) |
| `importFetch` | `{url}` | `{title, source, tracks: {title, artist, durationMs}[]}` — список из Spotify / Яндекс Музыки по публичной ссылке |
| `artworkPalette` | `{url}` | `{blurUrl, color}` — размытая обесцвеченная обложка + приглушённый тон |
| **Библиотека** | | |
| `getLibrary` | — | `{likes, playlists, downloads, local}` |
| `like` | `{track, liked}` | — |
| `playlistCreate` / `playlistRename` / `playlistDelete` / `playlistGet` | … | `Playlist` / — / — / `PlaylistPage` |
| `playlistAdd` / `playlistRemove` / `playlistMove` | `{id, tracks}` / `{id, index}` / `{id, from, to}` | — |
| `history`, `historyClear` | `{limit}` / — | `HistoryEntry[]` (с `listenedMs`, `completed`, `skipped`) |
| `libraryExport`, `libraryImport` | — / `{json}` | JSON / число треков |
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
| `updateInstall` | — | — (PackageInstaller, система может попросить подтверждение) |
| `updateSchedule` | `{enabled}` | — (фоновая проверка WorkManager, раз в 15 мин) |
| **Нейросеть** | | |
| `aiConfig` | — | `{baseUrl, model, enabled, hasKey}` (ключ наружу не отдаётся) |
| `aiConfigure` | `{baseUrl?, model?, key?, enabled?}` | `AiConfig` |
| `aiChat` | `{messages, temperature?}` | текст ответа (OpenAI-совместимый `/chat/completions`) |
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
| `updateState` | `UpdateState` (прогресс скачивания, готовность) |
| `deepLink` | `{url}` — открыта ссылка `youmusic://…` |
| `back` | — (системная кнопка «Назад») |

## Как добавить новую нативную функцию

1. Реализовать логику (репозиторий/сервис) и добавить его в `AppGraph` (`YouMusicApp.kt`).
2. Создать `XxxModule : BridgeModule` и зарегистрировать команды: `command<Args, Result>("name") { … }`.
3. Подключить модуль в `MainActivity` (список модулей).
4. Описать типы в `web/src/bridge/contract.ts` и в этой таблице; при необходимости добавить заглушку в `web/src/bridge/mock.ts`.
