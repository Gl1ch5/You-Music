/** Minimal typed pub/sub. Handlers are isolated so one failing listener (e.g. a mod) never breaks the others. */
export class Bus<Events extends object> {
  private handlers = new Map<keyof Events, Set<(data: never) => void>>();

  on<K extends keyof Events>(name: K, handler: (data: Events[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(handler as (data: never) => void);
    return () => set.delete(handler as (data: never) => void);
  }

  emit<K extends keyof Events>(name: K, data: Events[K]): void {
    this.handlers.get(name)?.forEach((h) => {
      try {
        (h as (d: Events[K]) => void)(data);
      } catch (e) {
        console.error(`[bus] handler for ${String(name)} failed`, e);
      }
    });
  }
}
