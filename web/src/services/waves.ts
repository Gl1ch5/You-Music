import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { signal } from '../core/signal';

/**
 * Waves the user listened to, so a good one can be continued later from where it stopped. Kept in kv (backup and
 * sync include it); only the last few, with a capped history each.
 */

export interface SavedWave {
  id: string;
  title: string;
  kind: 'reco' | 'track' | 'playlist';
  seed?: Track;
  seeds?: Track[];
  played: Track[];
  at: number;
}

const KEY = 'wave.sessions';
const MAX_WAVES = 8;
const MAX_TRACKS = 80;

export const savedWaves = signal<SavedWave[]>([]);

export async function loadWaves(): Promise<void> {
  const raw = await call('kvGet', { key: KEY }).catch(() => null);
  try {
    const list = raw ? JSON.parse(raw) : [];
    savedWaves.value = Array.isArray(list) ? list : [];
  } catch {
    savedWaves.value = [];
  }
}

export function rememberWave(wave: SavedWave): void {
  const entry = { ...wave, seeds: wave.seeds?.slice(0, MAX_TRACKS), played: wave.played.slice(-MAX_TRACKS), at: Date.now() };
  savedWaves.value = [entry, ...savedWaves.peek().filter((w) => w.id !== wave.id)].slice(0, MAX_WAVES);
  call('kvSet', { key: KEY, value: JSON.stringify(savedWaves.peek()) }).catch(() => undefined);
}

export function forgetWave(id: string): void {
  savedWaves.value = savedWaves.peek().filter((w) => w.id !== id);
  call('kvSet', { key: KEY, value: JSON.stringify(savedWaves.peek()) }).catch(() => undefined);
}
