import { Bus } from '../core/bus';
import type { ArgsOf, CommandName, NativeEvents, ResultOf } from './contract';

/**
 * The only module that knows about the platform. In the app it talks to the `youBridge` object injected by
 * WebViewCompat.addWebMessageListener (allowed only for https://appassets.androidplatform.net); in a desktop
 * browser (`npm run dev`, screenshots) it falls back to an in-memory mock.
 */

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Transport {
  send(text: string): void;
  listen(cb: (text: string) => void): void;
}

interface NativeObject {
  postMessage(text: string): void;
  onmessage: ((ev: { data: string }) => void) | null;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

const events = new Bus<NativeEvents>();
const pending = new Map<number, Pending>();
let seq = 0;

function captureNative(): NativeObject | undefined {
  const w = window as unknown as { youBridge?: NativeObject };
  const native = w.youBridge;
  // Hide the raw object so mods cannot bypass the permission-checked API.
  try {
    delete w.youBridge;
  } catch {
    /* non-configurable on some WebView versions */
  }
  return native;
}

const native = captureNative();
export const isNative = native !== undefined;

const transport: Promise<Transport> = native
  ? Promise.resolve({
      send: (text) => native.postMessage(text),
      listen: (cb) => {
        native.onmessage = (ev) => cb(ev.data);
      },
    })
  : import('./mock').then((m) => m.createMockTransport());

transport.then((t) =>
  t.listen((text) => {
    let msg: { type: string; id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; name?: string; data?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'res' && msg.id != null) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BridgeError(msg.error?.code ?? 'internal', msg.error?.message ?? 'Ошибка'));
    } else if (msg.type === 'event' && msg.name) {
      events.emit(msg.name as keyof NativeEvents, msg.data as never);
    }
  }),
);

export async function call<K extends CommandName>(cmd: K, ...args: ArgsOf<K> extends Record<string, never> ? [] : [ArgsOf<K>]): Promise<ResultOf<K>> {
  const t = await transport;
  const id = ++seq;
  return new Promise<ResultOf<K>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    t.send(JSON.stringify({ id, cmd, args: args[0] ?? {} }));
  });
}

export function onNative<K extends keyof NativeEvents>(name: K, handler: (data: NativeEvents[K]) => void): () => void {
  return events.on(name, handler);
}

