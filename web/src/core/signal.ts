/** Tiny reactive core: signals, computed values and effects with automatic dependency tracking. */

type Runner = { run: () => void; deps: Set<Set<Runner>> };

let active: Runner | null = null;

export interface ReadSignal<T> {
  readonly value: T;
  peek(): T;
}

export class Signal<T> implements ReadSignal<T> {
  private subs = new Set<Runner>();
  constructor(private current: T) {}

  get value(): T {
    if (active) {
      this.subs.add(active);
      active.deps.add(this.subs);
    }
    return this.current;
  }

  set value(next: T) {
    if (Object.is(next, this.current)) return;
    this.current = next;
    [...this.subs].forEach((s) => s.run());
  }

  peek(): T {
    return this.current;
  }

  update(fn: (v: T) => T): void {
    this.value = fn(this.current);
  }
}

export const signal = <T>(v: T) => new Signal(v);

/** Subscribes the running effect to signals whose values it does not otherwise read. */
export function track(...signals: ReadSignal<unknown>[]): void {
  signals.forEach((s) => s.value);
}

/** Runs `fn` now and whenever a signal it read changes. Returns a disposer. */
export function effect(fn: () => void): () => void {
  const runner: Runner = {
    deps: new Set(),
    run: () => {
      runner.deps.forEach((d) => d.delete(runner));
      runner.deps.clear();
      const prev = active;
      active = runner;
      try {
        fn();
      } catch (e) {
        console.error('[effect]', e);
      } finally {
        active = prev;
      }
    },
  };
  runner.run();
  return () => {
    runner.deps.forEach((d) => d.delete(runner));
    runner.deps.clear();
  };
}

export function computed<T>(fn: () => T): ReadSignal<T> {
  const s = new Signal<T>(undefined as T);
  effect(() => {
    s.value = fn();
  });
  return s;
}

/** Collects disposers for one screen / component so they can be torn down together. */
export class Scope {
  private disposers: (() => void)[] = [];

  effect(fn: () => void): void {
    this.disposers.push(effect(fn));
  }

  add(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  dispose(): void {
    this.disposers.splice(0).forEach((d) => {
      try {
        d();
      } catch (e) {
        console.error(e);
      }
    });
  }
}
