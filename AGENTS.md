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
    player/              PlaybackService (Media3), PlayerController (MediaController), PlaybackDataSource (скачанное → кэш → YouTube), StreamPrefetcher, PlaybackHistoryTracker
    source/              YouTubeRepository, StreamResolver, ImportRepository (Spotify/Яндекс), LyricsRepository (LRCLIB), Errors (коды ошибок)
    data/                Room (Entities, Daos, AppDatabase), LibraryRepository, KeyValueStore (настройки/темы/моды UI), AppPaths
    download/            DownloadRepository + DownloadWorker (WorkManager)
    local/, mods/, art/, net/, system/
  app/schemas/           схемы Room — коммитить при изменении БД (и писать миграцию)
web/                     TypeScript + Vite, без фреймворков
  src/bridge/            contract.ts (типы команд/событий), bridge.ts (единственное место, знающее о платформе), mock.ts (браузер/скриншоты)
  src/core/              signal.ts (реактивность), dom.ts (h(), иконки, форматтеры), store.ts (глобальное состояние), bus.ts
  src/design/            tokens.css, base.css, components.css, icons.ts (SVG-спрайт), noise.png
  src/theme/             темы (builtin.ts, engine.ts, types.ts)
  src/logic/             чистая логика с тестами: normalize, rank, recommend, match
  src/services/          catalog, library, playback (+волна), settings, art, events (uiBus для модов)
  src/ui/                компоненты, шторки, виртуальный список, меню трека, hero
  src/screens/           экраны; каждый регистрируется через defineRoute() и импортируется в main.ts
  src/player/            mini.ts, full.ts
  src/mods/              registry (слоты/хуки), api (window.app.mod), host (загрузка, разрешения, изоляция ошибок)
  scripts/               screenshots.mjs, mods-check.mjs (Playwright + mock)
docs/                    bridge.md (контракт), mods.md (API модов), screenshots/
examples/mods/           sleep-timer, clean-versions
.github/workflows/       ci.yml (каждый push + nightly-релиз на основной ветке), release.yml (теги v*)
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
4. **Дизайн-система Graphite.** В компонентах — только CSS-переменные из `tokens.css`; никаких сырых цветов и размеров. Анимировать только `transform` и `opacity` (исключение — морфинг `d` у кнопки play). Без `backdrop-filter` и тяжёлых теней. Иконки — из спрайта (`icon('name')`), стиль 24px / stroke 1.5 / currentColor.
5. **Реактивность.** `scope.effect()` подписывается только на сигналы, прочитанные при выполнении. Не прячьте чтение сигнала за коротким замыканием (`a && sig.value`) — читайте сигнал первым (из-за этого был баг с лайком).
6. **Производительность.** Длинные списки — `trackList()`/`virtualList()`; прогресс — `onFrame()` (rAF); обложки — `artFor(track, size)` нужного размера, `loading="lazy"`.
7. **YouTube.** Ошибки извлечения → коды из `source/Errors.kt`; при `extraction` UI предлагает обновить приложение. Обновлять NewPipeExtractor — правкой одной строки в `libs.versions.toml`.
8. **Моды.** Расширения UI лучше делать модами. Любой вызов мода — через `guard()`; новые возможности API — в `mods/api.ts` + `docs/mods.md`; новые разрешения — в `PERMISSIONS`.
9. **Тесты.** Логику в `src/logic/` покрывать тестами vitest.
10. **Без аналитики и трекинга. Не коммитить секреты и ключи** (подпись — через секреты GitHub, см. README).
11. Тексты интерфейса — на русском.

## Как добавить…

* **Экран:** `web/src/screens/x.ts` с `defineRoute('x', ({ scope, params }) => el)`, импорт в `main.ts`, переход `navigate('x', params)`.
* **Нативную функцию:** сервис в `AppGraph` → модуль моста → контракт/доки/mock (см. правило 2).
* **Поле в БД:** изменить Entity, поднять `version` в `AppDatabase`, добавить Migration, закоммитить новую схему из `app/schemas`.
* **Тему:** `web/src/theme/builtin.ts` (JSON-структура `Theme`).

## Журнал изменений

| Дата | Что изменилось |
|---|---|
| 2026-10-28 | Первая версия: все 7 этапов (каркас, Graphite, плеер/библиотека, темы, офлайн, моды, рекомендации), CI с nightly-релизом. |
| 2026-10-28 | Мгновенная пауза (`playWhenReady` → `player.wantsPlay`), кольцо загрузки на кнопке play, исправлен лайк, быстрее анимации (90/160/240 мс), старт после 0.7 с буфера, предзагрузка следующего трека, прогрев плеерного JS YouTube. Перенос из Spotify/Яндекс Музыки/списка/CSV (`importFetch`, `logic/match.ts`, экран `import`). Добавлены AGENTS.md и CLAUDE.md. |
