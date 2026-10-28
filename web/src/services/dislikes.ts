import { call } from '../bridge/bridge';
import type { Track } from '../bridge/contract';
import { signal } from '../core/signal';
import { songKey } from '../logic/normalize';
import type { Dislike } from '../logic/recommend';
import { toast } from '../ui/toast';
import { uiBus } from './events';

/**
 * "Не нравится": the song (every upload of it) never comes back in recommendations, and its artist is pushed down.
 * Stored in kv, so it is part of the full backup and the account sync.
 */

const KEY = 'reco.dislikes';
const LIMIT = 2000;

export const dislikes = signal<Dislike[]>([]);

export async function loadDislikes(): Promise<void> {
  const raw = await call('kvGet', { key: KEY }).catch(() => null);
  try {
    const list = raw ? JSON.parse(raw) : [];
    dislikes.value = Array.isArray(list) ? list : [];
  } catch {
    dislikes.value = [];
  }
}

export function isDisliked(track: Track | null | undefined, list = dislikes.peek()): boolean {
  if (!track) return false;
  const key = songKey(track);
  return list.some((d) => d.id === track.id || d.key === key);
}

/** Toggles the mark; returns true when the track is now disliked. */
export async function toggleDislike(track: Track): Promise<boolean> {
  const on = !isDisliked(track);
  const key = songKey(track);
  const list = dislikes.peek().filter((d) => d.id !== track.id && d.key !== key);
  dislikes.value = on ? [{ id: track.id, key, artist: track.artist, at: Date.now() }, ...list].slice(0, LIMIT) : list;
  await call('kvSet', { key: KEY, value: JSON.stringify(dislikes.peek()) }).catch(() => undefined);
  if (on) {
    uiBus.emit('dislike', { track });
    toast('Не будем рекомендовать этот трек', { icon: 'dislike' });
  }
  return on;
}
