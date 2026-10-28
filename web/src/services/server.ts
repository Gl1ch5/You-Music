import { call, onNative } from '../bridge/bridge';
import type { ServerStatus } from '../bridge/contract';
import { signal } from '../core/signal';
import { refreshAiConfig } from './ai';

/** Optional You Music account: cloud sync, 50 AI picks a day and a free proxy. Everything else works without it. */

export const server = signal<ServerStatus>({ signedIn: false, syncedAt: 0, syncing: false, ai: { enabled: false, limit: 0, left: 0 }, proxyAvailable: false, proxyOn: false });

function set(s: ServerStatus): ServerStatus {
  server.value = s;
  return s;
}

export async function signIn(login: string, password: string, register: boolean): Promise<ServerStatus> {
  const s = set(await call('serverAuth', { login, password, register }));
  await refreshAiConfig();
  return s;
}

export async function signOut(): Promise<void> {
  set(await call('serverLogout'));
  await refreshAiConfig();
}

export const syncNow = async () => set(await call('serverSync'));
export const setServerProxy = async (on: boolean) => set(await call('serverProxy', { on }));

export function initServer(): void {
  onNative('serverState', set);
  call('serverStatus')
    .then(set)
    .catch(() => undefined);
}
