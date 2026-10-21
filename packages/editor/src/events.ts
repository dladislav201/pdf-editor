type Listener<T> = (payload: T) => void;

export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      // A broken consumer callback must not break the editor.
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        console.error(`[pdfsdk] "${String(event)}" listener threw`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
