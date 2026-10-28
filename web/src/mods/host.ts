import { call } from '../bridge/bridge';
import type { InstalledMod, ModManifest } from '../bridge/contract';
import { h } from '../core/dom';
import { signal } from '../core/signal';
import { button } from '../ui/components';
import { openSheet } from '../ui/sheet';
import { toast } from '../ui/toast';
import { createModApi, PERMISSIONS, type ModApi, type ModRuntime } from './api';
import { setModErrorHandler, unregisterMod } from './registry';

/**
 * Loads mods after the core UI. Each mod's entry script is evaluated with a scoped `mod` API object
 * (also reachable as `window.app.mod` while the entry runs). Any error thrown by a mod — on load or later
 * in a callback — disables that mod and tells the user; the rest of the app keeps working.
 */

interface ModState {
  enabled: boolean;
  granted: string[];
}

export interface ModEntry {
  mod: InstalledMod;
  state: ModState;
  running: boolean;
  error?: string;
}

const STATE_KEY = 'mods.state';
export const mods = signal<ModEntry[]>([]);
const runtimes = new Map<string, ModRuntime>();
let states: Record<string, ModState> = {};

declare global {
  interface Window {
    app: { version: string; mod: ModApi | null };
  }
}

async function saveStates(): Promise<void> {
  await call('kvSet', { key: STATE_KEY, value: JSON.stringify(states) });
}

function setEntry(id: string, patch: Partial<ModEntry>): void {
  mods.value = mods.peek().map((m) => (m.mod.id === id ? { ...m, ...patch } : m));
}

export async function loadMods(appVersion: string): Promise<void> {
  window.app = { version: appVersion, mod: null };
  setModErrorHandler((id, e) => disableMod(id, e));
  try {
    states = JSON.parse((await call('kvGet', { key: STATE_KEY })) ?? '{}');
  } catch {
    states = {};
  }
  const installed = await call('modsList').catch(() => [] as InstalledMod[]);
  mods.value = installed.map((mod) => ({ mod, state: states[mod.id] ?? { enabled: false, granted: [] }, running: false }));
  for (const entry of mods.peek()) if (entry.state.enabled) await startMod(entry.mod);
}

async function startMod(mod: InstalledMod): Promise<void> {
  if (runtimes.has(mod.id)) return;
  const runtime: ModRuntime = { disposers: [] };
  runtimes.set(mod.id, runtime);
  try {
    for (const css of mod.manifest.styles ?? []) {
      const link = h('link', { rel: 'stylesheet', href: new URL(css, mod.baseUrl).href, dataset: { mod: mod.id } });
      document.head.appendChild(link);
      runtime.disposers.push(() => link.remove());
    }
    const res = await fetch(new URL(mod.manifest.entry, mod.baseUrl).href);
    if (!res.ok) throw new Error(`Не найден ${mod.manifest.entry}`);
    const code = await res.text();
    const api = createModApi(mod, new Set(states[mod.id]?.granted ?? []), runtime);
    const run = new Function('mod', 'app', `"use strict";\n${code}\n//# sourceURL=mods/${mod.id}/${mod.manifest.entry}`);
    window.app.mod = api;
    try {
      const result = run(api, window.app);
      if (result instanceof Promise) result.catch((e: unknown) => disableMod(mod.id, e));
    } finally {
      window.app.mod = null;
    }
    setEntry(mod.id, { running: true, error: undefined });
  } catch (e) {
    disableMod(mod.id, e);
  }
}

function stopMod(id: string): void {
  const runtime = runtimes.get(id);
  runtimes.delete(id);
  runtime?.disposers.splice(0).forEach((d) => {
    try {
      d();
    } catch {
      /* cleanup must not throw */
    }
  });
  unregisterMod(id);
  setEntry(id, { running: false });
}

export function disableMod(id: string, error?: unknown): void {
  if (!runtimes.has(id) && !error) return;
  console.error(`[mod ${id}]`, error);
  stopMod(id);
  const name = mods.peek().find((m) => m.mod.id === id)?.mod.manifest.name ?? id;
  states[id] = { ...(states[id] ?? { granted: [] }), enabled: false };
  setEntry(id, { state: states[id], error: error instanceof Error ? error.message : String(error ?? '') });
  saveStates();
  if (error) toast(`Мод «${name}» отключён из-за ошибки`, { icon: 'puzzle' });
}

export async function setModEnabled(id: string, enabled: boolean): Promise<void> {
  const entry = mods.peek().find((m) => m.mod.id === id);
  if (!entry) return;
  states[id] = { ...entry.state, enabled };
  setEntry(id, { state: states[id], error: undefined });
  await saveStates();
  if (enabled) await startMod(entry.mod);
  else stopMod(id);
}

export async function removeMod(id: string): Promise<void> {
  stopMod(id);
  delete states[id];
  await saveStates();
  await call('modRemove', { id });
  for (const key of await call('kvKeys', { prefix: `mod:${id}:` })) await call('kvSet', { key, value: null });
  mods.value = mods.peek().filter((m) => m.mod.id !== id);
}

function validate(m: ModManifest): string | null {
  if (!m.name || !m.version || !m.entry) return 'В manifest.json должны быть name, version и entry';
  if (!/\.js$/.test(m.entry)) return 'entry должен указывать на .js файл';
  const unknown = (m.permissions ?? []).filter((p) => !(p in PERMISSIONS));
  if (unknown.length) return `Неизвестные разрешения: ${unknown.join(', ')}`;
  return null;
}

/** Pick a zip or a folder, show requested permissions, install on confirmation. */
export async function installModFlow(kind: 'zip' | 'folder'): Promise<void> {
  const staged = await call('modStage', { kind }).catch((e) => {
    toast(e.message ?? 'Не удалось прочитать мод', { icon: 'alert' });
    return null;
  });
  if (!staged) return;
  const m = staged.manifest;
  const problem = validate(m);
  if (problem) return toast(problem, { icon: 'alert' });
  const perms = m.permissions ?? [];
  const existing = mods.peek().some((e) => e.mod.id === m.id);
  openSheet({
    header: h('div', null, h('div.h2', null, m.name), h('div.small.muted', null, `${m.version}${m.author ? ' · ' + m.author : ''}`)),
    content: (close) =>
      h(
        'div.pad.stack',
        { style: { gap: 'var(--s-3)', paddingTop: 'var(--s-2)' } },
        m.description ? h('div', null, m.description) : null,
        h('div.small.muted', null, 'Мод сможет добавлять кнопки, вкладки и стили. Дополнительно он запрашивает:'),
        perms.length ? h('ul', { style: { margin: '0', paddingLeft: 'var(--s-4)' } }, perms.map((p) => h('li', null, PERMISSIONS[p]))) : h('div', null, 'Ничего — только интерфейс.'),
        h('div.small.faint', null, 'Устанавливайте моды только из источников, которым доверяете: мод выполняется внутри приложения.'),
        button(existing ? 'Обновить и включить' : 'Установить и включить', async () => {
          close();
          try {
            if (existing) stopMod(m.id);
            const installed = await call('modInstall', { stageId: staged.stageId });
            states[installed.id] = { enabled: true, granted: perms };
            await saveStates();
            mods.value = [...mods.peek().filter((e) => e.mod.id !== installed.id), { mod: installed, state: states[installed.id], running: false }];
            await startMod(installed);
            toast(`Мод «${m.name}» установлен`, { icon: 'check' });
          } catch (e) {
            toast((e as Error).message, { icon: 'alert' });
          }
        }, { cls: 'primary block' }),
        button('Отмена', close, { cls: 'ghost block' }),
      ),
  });
}
