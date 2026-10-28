import type { Track } from '../bridge/contract';
import { signal } from '../core/signal';

/**
 * Extension points that core UI reads and mods write. Kept free of UI imports so services can use it.
 * Every mod callback is invoked through `guard`, so a throwing mod gets disabled instead of breaking the app.
 */

export interface PlayerButton {
  modId: string;
  id: string;
  icon: string;
  label: string;
  onClick: (track: Track | null) => void;
}

export interface MenuItem {
  modId: string;
  id: string;
  label: string;
  icon?: string;
  onClick: (track: Track) => void;
}

export interface ModPanel {
  modId: string;
  id: string;
  title: string;
  icon?: string;
  /** Fills `container`; may return a cleanup function. */
  render: (container: HTMLElement) => void | (() => void);
}

export const slots = {
  playerButtons: signal<PlayerButton[]>([]),
  trackMenu: signal<MenuItem[]>([]),
  tabs: signal<ModPanel[]>([]),
  settings: signal<ModPanel[]>([]),
};

export interface Hook<C> {
  modId: string;
  fn: (tracks: Track[], ctx: C) => Track[] | Promise<Track[]>;
}

export const hooks = {
  search: [] as Hook<{ query: string }>[],
  queue: [] as Hook<{ reason: 'play' | 'add' | 'wave' }>[],
  recommendations: [] as Hook<{ source: 'home' | 'wave' }>[],
};

type ErrorHandler = (modId: string, error: unknown) => void;
let onError: ErrorHandler = (id, e) => console.error(`[mod ${id}]`, e);

export function setModErrorHandler(handler: ErrorHandler): void {
  onError = handler;
}

export function guard<A extends unknown[], R>(modId: string, fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => {
    try {
      const result = fn(...args);
      if (result instanceof Promise) result.catch((e) => onError(modId, e));
      return result;
    } catch (e) {
      onError(modId, e);
      return undefined;
    }
  };
}

/** Pipes tracks through all hooks of a kind. A hook that throws or returns garbage is skipped (and its mod disabled). */
export async function runHooks<C>(list: Hook<C>[], tracks: Track[], ctx: C): Promise<Track[]> {
  let value = tracks;
  for (const hook of [...list]) {
    try {
      const out = await hook.fn([...value], ctx);
      if (Array.isArray(out) && out.every((t) => t && typeof t.id === 'string')) value = out;
      else throw new Error('Hook must return an array of tracks');
    } catch (e) {
      onError(hook.modId, e);
    }
  }
  return value;
}

/** Removes everything a mod registered. */
export function unregisterMod(modId: string): void {
  slots.playerButtons.update((l) => l.filter((x) => x.modId !== modId));
  slots.trackMenu.update((l) => l.filter((x) => x.modId !== modId));
  slots.tabs.update((l) => l.filter((x) => x.modId !== modId));
  slots.settings.update((l) => l.filter((x) => x.modId !== modId));
  for (const list of Object.values(hooks)) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].modId === modId) list.splice(i, 1);
  }
}
