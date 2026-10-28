import type { NativeEvents, Track } from '../bridge/contract';
import { Bus } from '../core/bus';

/** UI-level events. Mods subscribe here (through their API), never to the native bridge directly. */
export interface UiEvents {
  trackChanged: { track: Track | null; index: number };
  stateChanged: NativeEvents['stateChanged'];
  queueChanged: { queue: Track[]; index: number };
  progress: NativeEvents['progress'];
  like: { track: Track; liked: boolean };
  dislike: { track: Track };
  skip: { track: Track; positionMs: number };
  screen: { route: string };
  online: { online: boolean };
}

export const uiBus = new Bus<UiEvents>();
