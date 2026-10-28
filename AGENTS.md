# AGENTS.md — руководство для ИИ-агентов и разработчиков

> **Обязательное правило.** Любое изменение, которое затрагивает архитектуру, команды моста, структуру папок, сборку, CI, конвенции или поведение приложения, должно в **том же коммите** обновлять этот файл (и `CLAUDE.md`, если меняются правила для Claude). Добавьте строку в раздел «Журнал изменений» внизу. Устаревший AGENTS.md считается багом.

## Что это

You Music — личный Android-плеер: поиск и воспроизведение музыки с YouTube (NewPipeExtractor, без ключей и аккаунта), «Волна» и рекомендации, лайки/плейлисты/история, офлайн-загрузки, свои аудиофайлы, перенос из Spotify/Яндекс Музыки, темы и моды. Интерфейс — веб-UI в WebView, звук и данные — нативные.

## Структура

```
android/                 Kotlin, AGP 9 (встроенный Kotlin), Gradle wrapper
  gradle/libs.versions.toml   ВСЕ версии зависимостей; версия NewPipeExtractor — только здесь (newpipeExtractor)
  app/src/main/java/app/youmusic/
    YouMusicApp.kt       AppGraph — ручной DI; новые сервисы добавлять сюда
    MainActivity.kt      WebView, WebViewAssetLoader, ActivityHost (пикеры, haptics, share), список BridgeModule
    bridge/              BridgeHost (WebMessageListener), CommandRegistry, EventBus, modules/* — команды по доменам
    player/              PlaybackService (Media3), PlayerController (MediaController), PlaybackDataSource (скачанное → кэш → YouTube),
                         ChunkedDataSource (поток короткими range-запросами + перезапрос URL на 403), StreamPrefetcher, FadeController (плавные переходы, равная мощность, ограничение скорости),
                         PlaybackHistoryTracker, TrackInfo (TrackInfoReader: кодек/битрейт/размер для «О треке»)
    source/              YouTubeRepository, StreamResolver, ImportRepository (Spotify/Яндекс, чарт Яндекса), LyricsRepository (LRCLIB, точный → поиск),
                         Translator (перевод текста, Google gtx через Http.client),
                         FeaturesRepository (Deezer: BPM/громкость/жанры для рекомендаций, кэш features.json), Errors (коды ошибок)
    data/                Room (Entities, Daos, AppDatabase), LibraryRepository, KeyValueStore (настройки/темы/моды UI), AppPaths,
                         BackupManager (полная копия: библиотека + история + kv без ключа AI; автокопия в папку SAF)
    download/            DownloadRepository + DownloadWorker (WorkManager)
    net/                 Http (общий OkHttp, пересоздаётся при смене прокси), NetworkMonitor (online/VPN), ProxyManager,
                         FreeProxies (бесплатные прокси РФ только для переноса из Яндекса; Call.await())
    update/              UpdateManager (version.json из GitHub Releases, PackageInstaller), UpdateWorker (фон, 15 мин)
    ai/                  AiClient — OpenAI-совместимый chat/completions; ключ хранится только нативно; AiFallback — нейросеть аккаунта, если своя выключена
    cloud/               ServerClient — необязательный аккаунт на https://grzxk.ru/youmusic: вход, синхронизация (backupExport/merge-import), AI с лимитом, прокси;
                         токен и данные прокси — в отдельных SharedPreferences "server" (не в kv, не попадают в копию);
                         TelegramImporter — файлы от бота → files/telegram, `local:tg-…`, обложка: Telegram → найденный трек → сгенерированная
    system/              ProgressNotifications (уведомления: загрузка новой версии, скачивание музыки), ActivityHost,
                         AppIcons (иконка лаунчера: activity-alias Icon01…Icon20 + IconClassic в манифесте, включён ровно один)
    local/, mods/, art/
  app/src/main/res/drawable-nodpi/app_icon_NN.webp + mipmap-anydpi-v26/ic_launcher_NN.xml — иконки лаунчера; превью — web/public/app-icons/NN.webp
  app/schemas/           схемы Room — коммитить при изменении БД (и писать миграцию)
web/                     TypeScript + Vite, без фреймворков
  src/bridge/            contract.ts (типы команд/событий), bridge.ts (единственное место, знающее о платформе), mock.ts (браузер/скриншоты)
  src/core/              signal.ts (реактивность), dom.ts (h(), иконки, форматтеры), store.ts (глобальное состояние), bus.ts
  src/design/            tokens.css, base.css, components.css, icons.ts (SVG-спрайт), noise.png
  src/theme/             темы (builtin.ts, engine.ts, types.ts)
  src/logic/             чистая логика с тестами: normalize, rank, recommend (волна), features (вайб и эпоха), filters (фильтры рекомендаций), match (перенос), ai (промпт и разбор ответа)
  src/services/          catalog (+findTrack), library (+скачать лайки/избранное), playback (+волна, createWave, playTrackWave), features (вайбы через trackFeatures),
                         dislikes («Не нравится», kv reco.dislikes), waves (сохранённые потоки, kv wave.sessions),
                         backup (экспорт/импорт всего, автокопия, предложение восстановить), ai, updates (OTA, проверка раз в минуту), deeplink (youmusic://), settings, art, events (uiBus для модов)
  src/ui/                компоненты (pageIntro/listenButtons — общая шапка простых экранов коллекции), шторки, виртуальный список, меню трека (+ shareTrack), trackInfo («О треке»), hero, artistLink (каждый исполнитель — ссылка), onboarding (первый запуск)
  src/screens/           экраны; каждый регистрируется через defineRoute() и импортируется в main.ts; home — вкладки «Для вас | Чарт | Подборки»
  src/player/            mini.ts, full.ts
  src/mods/              registry (слоты/хуки), api (window.app.mod), host (загрузка, разрешения, изоляция ошибок)
  scripts/               screenshots.mjs, mods-check.mjs (Playwright + mock)
server/                  Node 22 без зависимостей: аккаунты (scrypt), синхронизация, /api/ai/chat (50 в день, tier fast/deep), HTTP CONNECT-прокси (только 80/443, не в частные сети),
                         Telegram-бот (long polling, /api/tg/*), страницы: сайт со статистикой, /terms, /t/<id> (поделиться);
                         deploy/ (systemd, nginx, env.example). Секреты — только в /opt/youmusic-server/.env на сервере
docs/                    bridge.md (контракт), mods.md (API модов), screenshots/, icon.svg (иконка)
examples/mods/           sleep-timer, clean-versions
.github/workflows/       ci.yml (каждый push + nightly-релиз на основной ветке с version.json), release.yml (теги v*)
```

## Команды

```bash
cd web
npm ci
npm run lint          # ESLint (запрещены хардкод-цвета в TS вне builtin/mock/тестов)
npm run typecheck     # tsc
npm test              # vitest: logic/*.test.ts
npm run build         # tsc + vite → android/app/src/main/assets/ui (в git не коммитится)
npm run dev           # UI в браузере на mock-данных
npm run screenshots   # docs/screenshots (после build)
node scripts/mods-check.mjs   # smoke-тест модов (после build)

cd ../android
./gradlew :app:assembleDebug  # нужен собранный UI в assets/ui
```

Основная сборка APK — GitHub Actions. Перед пушем прогоняйте lint, typecheck, test и, если трогали Kotlin, `assembleDebug`.

## Правила

1. **Слои.** Веб — интерфейс и платформонезависимая логика (экраны, анимации, темы, моды, рекомендации, нормализация). Нативное — только то, что UI не может: звук, сеть/извлечение, файлы, БД, загрузки.
2. **Мост.** Новая команда = Kotlin `BridgeModule` + регистрация в `MainActivity` + тип в `web/src/bridge/contract.ts` + строка в `docs/bridge.md` + заглушка в `mock.ts`. UI вызывает платформу только через `call()`/`onNative()` из `bridge.ts`.
3. **Безопасность WebView.** Только `WebViewAssetLoader` (`https://appassets.androidplatform.net`), мост — только для этого origin. Звук никогда не через `<audio>` (CSP `media-src 'none'`).
4. **Дизайн-система Graphite.** В компонентах — только CSS-переменные из `tokens.css`; никаких сырых цветов и размеров. Анимировать только `transform` и `opacity` (исключение — морфинг `d` у кнопки play). Без `backdrop-filter` и тяжёлых теней — кроме темы Liquid Glass (`theme.glass` → класс `html.glass`): размытие только у мини-плеера, таб-бара и шторок. Иконки — из спрайта (`icon('name')`), стиль 24px / stroke 1.5 / currentColor.
5. **Реактивность.** `scope.effect()` подписывается только на сигналы, прочитанные при выполнении. Не прячьте чтение сигнала за коротким замыканием (`a && sig.value`) — читайте сигнал первым (из-за этого был баг с лайком).
6. **Производительность.** Длинные списки — `trackList()`/`virtualList()`; прогресс — `onFrame()` (rAF); обложки — `artFor(track, size)` нужного размера, `loading="lazy"`.
7. **YouTube.** Ошибки извлечения → коды из `source/Errors.kt`; при `extraction` UI предлагает обновить приложение. Обновлять NewPipeExtractor — правкой одной строки в `libs.versions.toml`.
8. **Моды.** Расширения UI лучше делать модами. Любой вызов мода — через `guard()`; новые возможности API — в `mods/api.ts` + `docs/mods.md`; новые разрешения — в `PERMISSIONS`.
9. **Тесты.** Логику в `src/logic/` покрывать тестами vitest.
10. **Без аналитики и трекинга. Не коммитить секреты и ключи** — ни ключи подписи, ни API-ключи нейросети, ни логины/пароли прокси (они передаются пользователю ссылкой `youmusic://` и хранятся на устройстве).
11. Тексты интерфейса — на русском.
12. **OTA.** `versionCode` в CI — минуты с эпохи (растёт между воркфлоу). Каждый релиз обязан содержать `version.json` (`versionCode, versionName, channel, apk, notes`). Не меняйте ключ подписи nightly — иначе обновление не встанет поверх.
13. **Сеть.** Все HTTP-запросы — через `Http.client` / `Http.callFactory`, тогда работают прокси. При смене маршрута (VPN, прокси, сеть) URL потоков сбрасываются: они привязаны к IP.
14. **Данные пользователя не должны теряться.** Новое долговременное состояние кладите в БД или kv — тогда оно попадёт в полную копию (`BackupManager`) и системный бэкап (`res/xml/*backup*`). Ключи `backup.*` в kv в копию не входят; секреты (ключ AI) из копии вырезаются.
15. **Данные треков (Deezer)** — только для рекомендаций, в плеере их не показываем.
16. **Глубокие ссылки** `youmusic://socks|http|proxy|ai|updates|track` и `https://grzxk.ru/youmusic/t/<id>` — обработка в `services/deeplink.ts`, новые типы описывать в README.
20. **Термины.** В интерфейсе — «Рекомендации», «Волна по треку/плейлисту», «нейросеть»; слова «нейро-…» и режима «Нейро» нет: нейросеть — часть любого режима. Своя нейросеть/свой прокси имеют приоритет над серверными.
21. **Токен Telegram-бота** — только `TELEGRAM_BOT_TOKEN` в `/opt/youmusic-server/.env`; в репозитории и `env.example` — пустой ключ.
17. **Клики сквозь слои.** Всё, что прячет оверлей жестом (плеер, шторки), вызывает `swallowNextClick()` из `core/dom.ts`. Вокруг мини-плеера — прозрачная `.mini-shield`.
22. **Целостность.** Простые экраны коллекции (плейлисты, скачанное, мои файлы, история) строятся одинаково: `pageIntro(title, sub, listenButtons(...))` — заголовок, одна строка фактов, две равные кнопки; редкие действия — в «⋯»/«+» в шапке. Фильтры рекомендаций — только в шторке «Фильтры» на главной, отдельных рядов чипов нет. Плеер — по компоновке Яндекс Музыки: очередь в шапке; рядом с названием «скачать» и «⋮»; ряд «не нравится / назад / play / вперёд / нравится»; три широкие кнопки «повтор / текст / перемешать»; плашка «Волна по треку». Текст песни показывается вместо обложки.
23. **Без повторов.** Сравнивать песни — только через `songKeys()` из `logic/normalize.ts` (любой из ключей совпал → та же песня); новые пути наполнения очереди обязаны отсеивать по ним уже сыгранное и стоящее в очереди.
18. **Загрузка видна всегда.** Действие пользователя, которое ждёт сеть, оборачивайте в `busy()` (`core/busy.ts`, полоска сверху) или показывайте скелетон; запуск потока — `player.preparing`.
19. **Сервер необязателен.** Без аккаунта всё работает как раньше. Секреты сервера (ключ и модель нейросети) — только в env на сервере, в репозиторий и APK не попадают.

## Как добавить…

* **Экран:** `web/src/screens/x.ts` с `defineRoute('x', ({ scope, params }) => el)`, импорт в `main.ts`, переход `navigate('x', params)`.
* **Нативную функцию:** сервис в `AppGraph` → модуль моста → контракт/доки/mock (см. правило 2).
* **Поле в БД:** изменить Entity, поднять `version` в `AppDatabase`, добавить Migration, закоммитить новую схему из `app/schemas`.
* **Тему:** `web/src/theme/builtin.ts` (JSON-структура `Theme`).

## Журнал изменений

| Дата | Что изменилось |
|---|---|
| 2026-10-28 | Первая версия: все 7 этапов (каркас, Graphite, плеер/библиотека, темы, офлайн, моды, рекомендации), CI с nightly-релизом. |
| 2026-10-28 | Прокси (SOCKS5/HTTP, пинг, отключение при VPN), OTA-обновления (version.json, проверка раз в минуту, автоскачивание, PackageInstaller), нейро-рекомендации (OpenAI-совместимый API, режим волны «Нейро»), плавные переходы, поток кусками с переподключением и полным буфером, автоскачивание лайкнутых, кэш 2 ГБ, поиск: треки → плейлисты/альбомы → ещё треки, новая панель действий плеера, ссылки youmusic://. |
| 2026-10-28 | Мгновенная пауза (`playWhenReady` → `player.wantsPlay`), кольцо загрузки на кнопке play, исправлен лайк, быстрее анимации (90/160/240 мс), старт после 0.7 с буфера, предзагрузка следующего трека, прогрев плеерного JS YouTube. Перенос из Spotify/Яндекс Музыки/списка/CSV (`importFetch`, `logic/match.ts`, экран `import`). Добавлены AGENTS.md и CLAUDE.md. |
| 2026-10-28 | Главная — «Для вас» с фильтром режима вместо hero «Волны»; «Волна по треку» с учётом вайба (Deezer: темп/громкость/жанры → `logic/features.ts`, команда `trackFeatures`); перенос из Яндекса через бесплатные прокси (`net/FreeProxies`); кнопки «Скачать лайки/избранное»; исправлены клик сквозь мини-плеер и прыжок прокрутки в «Мне нравится»; полный бэкап (`backup*`, автокопия в папку, предложение восстановить, `allowBackup` с правилами), проверка подписи OTA-APK (`signatureMismatch`), ключ nightly сохраняется в кэш сразу после создания. |
| 2026-10-28 | Кликабельный исполнитель (`ui/artistLink.ts`, поиск канала по имени), `swallowNextClick` после закрытия плеера/шторок и `.mini-shield`; глобальная полоска загрузки (`busy()`, `player.preparing`), «Поток» и нейросеть грузятся параллельно (`Wave.refillExtra`, OkHttp до 16 запросов на хост); замена недоступного видео другой загрузкой (`StreamResolver.resolveOrAlternative`, `q`/`d` в `ym://`-URI); сервер `server/` + `cloud/ServerClient` + команды `server*`; онбординг (тема → перенос → аккаунт); темы Liquid Glass, Catppuccin, Nord, Synthwave; новая иконка (Material You, монохромная версия). |
| 2026-10-28 | Исполнитель в мини-плеере больше не кликабелен — нажатие открывает плеер; ссылка на исполнителя только в открытом плеере и списках. Исправлена сборка (`ServerClient.saveUser`). |
| 2026-10-28 | `.button-row` переносит кнопки на новую строку, если они не помещаются («Скачать избранное» вылезало за край). |
| 2026-10-28 | Уведомления о прогрессе (`system/ProgressNotifications`, канал `progress`): загрузка новой версии и очередь скачивания музыки; слушают `UpdateManager.onState` и `DownloadRepository.onProgress`. |
| 2026-10-28 | Исправлена перемотка: ползунок отдавал дробные мс, а `seek` ждал `Long` — команда падала молча. Веб округляет, `SeekArgs.positionMs` теперь `Double`. |
| 2026-10-28 | Выбор иконки приложения (20 из пакета дизайнера, «Светлые/Тёмные», по умолчанию 10; `appIconGet/appIconSet`, `system/AppIcons`, экран `appIcon`). Правки по дизайн-ревью: в «Коллекции» вместо кнопок «Скачать лайки/избранное» — иконка в строке «Мне нравится» (кнопки остались в «Скачанном»), «История» показывает прослушанное сегодня; мини-плеер светлее, с тенью (`--shadow-mini`) и заметной полоской прогресса; в истории поиска «×» удаляет запрос, «Очистить» — текстовая кнопка (`.text-btn`); режим рекомендаций — в баннере «Слушать поток»; названия в сетке — 2 строки (`.clamp-2`); иконка настроек — шестерёнка (`settings`), ползунки — `tune`; «Скачано» — галочка; ползунок перемотки крупнее, всегда виден и отодвинут от края экрана (жест «назад»). |
| 2026-10-28 | Рекомендации без режима «Нейро»: нейросеть — часть любого режима (`aiSuggest` с tier fast/deep, эпоха и текущий год в промпте), фильтры (`logic/filters.ts`, свои словами), учёт эпохи (`eraOf`), «Не нравится» (`services/dislikes.ts`), «Продолжить волну» (`services/waves.ts`), волна по плейлисту, пересборка очереди без мерцания (`queueReplaceUpcoming`), «Чарт» (`chart`), «Быстрее/Тщательнее» в настройках. Плеер: строка текста поверх обложки, перевод (`translate`), «О треке» (`trackInfo`), дизлайк, ссылки на всех исполнителей, без перерисовки при смене очереди, предзагрузка обложек; плавнее затухание; точнее поиск текстов; обложки Яндекса при переносе и точнее сопоставление. Поделиться — ссылка `grzxk.ru/youmusic/t/<id>` (+ intent-filter, `youmusic://track`). Перенос из Telegram (бот, `tgLink/tgTracks/tgImport/tgDelete`, `cloud/TelegramImporter`). Сервер: tier моделей, `/api/stats`, сайт, соглашение, страница трека. Полоска загрузки появляется с задержкой и тише. |
| 2026-10-28 | Главная: вкладки «Для вас / Чарт / Подборки»; большой анимированный блок «Рекомендации» с одной кнопкой «Фильтры» (режим + все фильтры + свои), «Треки для вас» лентой, чарт с местами, «Подборки» — миксы по любимым исполнителям и плейлисты YouTube. Плеер по компоновке Яндекс Музыки (обложка уже, очередь в шапке, дизлайк/лайк в ряду управления, кнопки повтор/текст/перемешать, плашка «Волна по треку»), текст песни на месте обложки (синхронный, крупный, тап — перемотка, перевод), загрузка с процентом у названия; исправлено отставание ползунка перемотки от полосы (`scale` масштабировал `translate`, теперь свойство `translate`). Единые минималистичные экраны «Плейлисты» (сетка), «Скачанное», «Мои файлы», «История» (`pageIntro`, «Сегодня/Вчера»). Перенос: выбор, куда сохранить (новый плейлист / существующий / «Мне нравится»), чистка названий файлов из Telegram (`cleanFileTrack` в `logic/match.ts` и на сервере). Повторы в рекомендациях и волнах: `songKey` узнаёт перезаливы («Канал» + «Исполнитель - Песня»), шум вне скобок, кириллицу/латиницу; `songKeys` добавляет ключ по одному названию для заметных названий — им пользуются выбор волны, очередь и нейросеть. |
