# Моды

Мод — папка или zip-архив:

```
my-mod/
  manifest.json
  main.js          # entry
  style.css        # необязательно
  icons/…          # любые ассеты
```

## manifest.json

```json
{
  "id": "sleep-timer",
  "name": "Таймер сна",
  "version": "1.0.0",
  "author": "you",
  "description": "Что делает мод",
  "permissions": ["player.control"],
  "entry": "main.js",
  "styles": ["style.css"]
}
```

* `id` — `[a-z0-9][a-z0-9._-]{1,63}`, папка в `files/mods/<id>/`.
* Установка: **Настройки → Моды → Из ZIP / Из папки**. Перед установкой и при включении пользователь видит и подтверждает разрешения.
* Моды загружаются после ядра UI, включаются и выключаются по отдельности.
* Ассеты доступны по `mod.baseUrl` (`https://appassets.androidplatform.net/mods/<id>/`).

## Разрешения

| Разрешение | Даёт |
|---|---|
| `player.control` | `mod.player.*` (кроме `state()`), `play`, `addToQueue` |
| `library.read` | `mod.library.likes/playlists/history` |
| `library.write` | `mod.library.like` |
| `search` | `mod.search` |
| `downloads` | `mod.download` |
| `hooks.search` | `mod.hooks.searchResults` |
| `hooks.queue` | `mod.hooks.queue` |
| `hooks.recommendations` | `mod.hooks.recommendations` |

Без разрешений доступны: события, UI-слоты, стили, иконки, своё хранилище. Вызов без объявленного разрешения бросает ошибку — мод отключается.

## Изоляция ошибок

* `main.js` выполняется внутри `try/catch`. Ошибка при загрузке, в обработчике события, хуке, кнопке или экране отключает **только этот мод** и показывает тост «Мод отключён из-за ошибки».
* Для своих таймеров и слушателей оборачивайте колбэки в `mod.safe(fn)`.
* Хук, вернувший не массив треков, пропускается.
* Мод выполняется в той же JS-среде, что и интерфейс; сырой мост скрыт, но это защита от ошибок, а не песочница для вредоносного кода. Ставьте моды из доверенных источников.

## API (`mod`, он же `window.app.mod` во время загрузки)

```js
mod.id; mod.manifest; mod.apiVersion; mod.baseUrl

// События: trackChanged, stateChanged, queueChanged, progress, like, skip, screen, online
const off = mod.on('trackChanged', ({ track, index }) => {});

// Плеер
mod.player.state()            // {track, queue, index, playing, positionMs, durationMs}
mod.player.toggle() / pause() / resume() / next() / previous() / seek(ms)
mod.player.play(tracks, index)
mod.player.addToQueue(tracks, playNext)

// Библиотека, поиск, загрузки
mod.library.likes(); mod.library.playlists(); await mod.library.history(100); mod.library.like(track, true)
await mod.search('query', 'songs')   // SearchItem[]
mod.download(tracks)

// UI-слоты (все возвращают функцию удаления)
mod.ui.addPlayerButton({ id, icon, label, onClick(track) })
mod.ui.addMenuItem({ id, label, icon, onClick(track) })        // меню «⋮» у трека
mod.ui.addTab({ id, title, icon, render(el) })                  // плитка в «Коллекции» → экран
mod.ui.addSettingsScreen({ id, title, render(el) })             // Настройки → Моды → мод
mod.ui.openSheet({ title, render(el, close) })
mod.ui.toast('текст')
mod.ui.h('div.item', { onclick }, 'текст'); mod.ui.icon('heart')  // хелперы DOM

// Стили и иконки
mod.styles.add('.row-title { letter-spacing: .01em }')         // используйте токены var(--accent) и т.д.
mod.icons.override({ heart: '<path d="…"/>' })                  // 24px, stroke=currentColor
mod.icons.registerSet('my-icons', { play: '…', … })             // выбирается в редакторе тем

// Хуки (могут быть async, должны вернуть массив треков)
mod.hooks.searchResults((tracks, { query }) => tracks)
mod.hooks.queue((tracks, { reason }) => tracks)                 // reason: play | add | wave
mod.hooks.recommendations((tracks, { source }) => tracks)       // source: home | wave

// Хранилище мода
await mod.storage.get('key', defaultValue); await mod.storage.set('key', value); await mod.storage.remove('key')

mod.safe(fn)  // обёртка для своих колбэков
```

Все размеры и цвета берите из CSS-переменных дизайн-системы (`--bg`, `--surface`, `--accent`, `--r-card`, `--s-2`…), тогда мод работает с любой темой.

## Примеры

* `examples/mods/sleep-timer` — кнопка в плеере, шторка, экран настроек, хранилище, замена иконки.
* `examples/mods/clean-versions` — хуки поиска и рекомендаций, пункт меню трека, CSS-оверрайд.

Собранные zip примеров прикладываются к каждому релизу. Проверка в браузере: `cd web && npm run build && node scripts/mods-check.mjs`.
