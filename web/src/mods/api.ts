import { call } from '../bridge/bridge';
import type { InstalledMod, SearchFilter, Track } from '../bridge/contract';
import { h, icon } from '../core/dom';
import { app, currentTrack, livePosition, player } from '../core/store';
import { overrideIcons, registerIconSet, type IconSet } from '../design/icons';
import { search } from '../services/catalog';
import { uiBus, type UiEvents } from '../services/events';
import { download, setLiked } from '../services/library';
import { addToQueue, next, playTracks, previous, seek, togglePlay } from '../services/playback';
import { openSheet } from '../ui/sheet';
import { toast } from '../ui/toast';
import { guard, hooks, slots, type Hook } from './registry';

/** Bumped when the mod API changes incompatibly. Mods can check `mod.apiVersion`. */
export const MOD_API_VERSION = 1;

export const PERMISSIONS: Record<string, string> = {
  'player.control': 'Управлять воспроизведением и очередью',
  'library.read': 'Читать лайки, плейлисты и историю',
  'library.write': 'Ставить и снимать лайки',
  search: 'Искать музыку',
  downloads: 'Скачивать треки',
  'hooks.search': 'Менять поисковую выдачу',
  'hooks.queue': 'Менять очередь перед воспроизведением',
  'hooks.recommendations': 'Менять рекомендации и волну',
};

/** Everything a mod created, so disabling it can undo it. */
export interface ModRuntime {
  disposers: (() => void)[];
}

export function createModApi(mod: InstalledMod, granted: Set<string>, runtime: ModRuntime) {
  const id = mod.id;
  const need = (perm: string) => {
    if (!granted.has(perm)) throw new Error(`Мод «${mod.manifest.name}» не запрашивал разрешение ${perm}`);
  };
  const track = <T>(dispose: () => T) => {
    runtime.disposers.push(dispose);
    return dispose;
  };
  const addHook = <C>(list: Hook<C>[], perm: string, fn: Hook<C>['fn']) => {
    need(perm);
    const hook: Hook<C> = { modId: id, fn };
    list.push(hook);
    return track(() => {
      const i = list.indexOf(hook);
      if (i >= 0) list.splice(i, 1);
    });
  };

  return Object.freeze({
    id,
    manifest: mod.manifest,
    apiVersion: MOD_API_VERSION,
    baseUrl: mod.baseUrl,

    /** Wraps a callback you schedule yourself (timers, listeners) so an error disables the mod instead of leaking. */
    safe<A extends unknown[], R>(fn: (...args: A) => R) {
      return guard(id, fn);
    },

    /** Subscribe to player and UI events. Returns an unsubscribe function. */
    on<K extends keyof UiEvents>(event: K, handler: (data: UiEvents[K]) => void) {
      return track(uiBus.on(event, guard(id, handler) as (d: UiEvents[K]) => void));
    },

    player: Object.freeze({
      state: () => ({
        track: currentTrack.peek(),
        queue: player.queue.peek(),
        index: player.index.peek(),
        playing: player.playing.peek(),
        positionMs: livePosition(),
        durationMs: player.position.peek().durationMs,
      }),
      toggle: () => (need('player.control'), togglePlay()),
      pause: () => (need('player.control'), call('pause')),
      resume: () => (need('player.control'), call('resume')),
      next: () => (need('player.control'), next()),
      previous: () => (need('player.control'), previous()),
      seek: (ms: number) => (need('player.control'), seek(ms)),
      play: (tracks: Track[], index = 0) => (need('player.control'), playTracks(tracks, index, { kind: 'list', title: mod.manifest.name })),
      addToQueue: (tracks: Track[], playNext = false) => (need('player.control'), addToQueue(tracks, playNext)),
    }),

    library: Object.freeze({
      likes: () => (need('library.read'), app.likes.peek().map((l) => l.track)),
      playlists: () => (need('library.read'), app.playlists.peek()),
      history: (limit = 100) => (need('library.read'), call('history', { limit })),
      like: (t: Track, liked = true) => (need('library.write'), setLiked(t, liked)),
    }),

    search: async (query: string, filter: SearchFilter = 'all') => {
      need('search');
      return (await search(query, filter)).items;
    },

    download: (tracks: Track[]) => (need('downloads'), download(tracks)),

    ui: Object.freeze({
      h,
      icon,
      toast: (message: string) => toast(message, { icon: 'puzzle' }),
      addPlayerButton(b: { id: string; icon: string; label: string; onClick: (t: Track | null) => void }) {
        slots.playerButtons.update((l) => [...l, { ...b, modId: id }]);
        return track(() => slots.playerButtons.update((l) => l.filter((x) => !(x.modId === id && x.id === b.id))));
      },
      addMenuItem(m: { id: string; label: string; icon?: string; onClick: (t: Track) => void }) {
        slots.trackMenu.update((l) => [...l, { ...m, modId: id }]);
        return track(() => slots.trackMenu.update((l) => l.filter((x) => !(x.modId === id && x.id === m.id))));
      },
      addTab(t: { id: string; title: string; icon?: string; render: (el: HTMLElement) => void | (() => void) }) {
        slots.tabs.update((l) => [...l, { ...t, modId: id }]);
        return track(() => slots.tabs.update((l) => l.filter((x) => !(x.modId === id && x.id === t.id))));
      },
      addSettingsScreen(s: { id: string; title: string; render: (el: HTMLElement) => void | (() => void) }) {
        slots.settings.update((l) => [...l, { ...s, modId: id }]);
        return track(() => slots.settings.update((l) => l.filter((x) => !(x.modId === id && x.id === s.id))));
      },
      openSheet(opts: { title: string; render: (el: HTMLElement, close: () => void) => void }) {
        const body = h('div.pad');
        const close = openSheet({ header: h('div.h2', null, opts.title), content: body });
        guard(id, opts.render)(body, close);
        return close;
      },
    }),

    styles: Object.freeze({
      add(css: string) {
        const style = h('style', { dataset: { mod: id } });
        style.textContent = css;
        document.head.appendChild(style);
        return track(() => style.remove());
      },
    }),

    icons: Object.freeze({
      override(map: Record<string, string>) {
        overrideIcons(map);
        return track(() => overrideIcons(Object.fromEntries(Object.keys(map).map((k) => [k, null]))));
      },
      registerSet: (name: string, set: IconSet) => registerIconSet(name, set),
    }),

    hooks: Object.freeze({
      searchResults: (fn: Hook<{ query: string }>['fn']) => addHook(hooks.search, 'hooks.search', fn),
      queue: (fn: Hook<{ reason: 'play' | 'add' | 'wave' }>['fn']) => addHook(hooks.queue, 'hooks.queue', fn),
      recommendations: (fn: Hook<{ source: 'home' | 'wave' }>['fn']) => addHook(hooks.recommendations, 'hooks.recommendations', fn),
    }),

    storage: Object.freeze({
      async get<T>(key: string, fallback: T): Promise<T> {
        const raw = await call('kvGet', { key: `mod:${id}:${key}` });
        try {
          return raw == null ? fallback : (JSON.parse(raw) as T);
        } catch {
          return fallback;
        }
      },
      set: (key: string, value: unknown) => call('kvSet', { key: `mod:${id}:${key}`, value: JSON.stringify(value) }),
      remove: (key: string) => call('kvSet', { key: `mod:${id}:${key}`, value: null }),
    }),
  });
}

export type ModApi = ReturnType<typeof createModApi>;
