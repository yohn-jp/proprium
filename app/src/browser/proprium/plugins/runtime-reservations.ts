/** Reservations include startup and nested calls, not only time inside the Worker. */
export class RuntimeReservations {
  private readonly counts = new Map<string, number>();

  isBusy(pluginId: string): boolean { return this.counts.has(pluginId); }

  async run<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    this.counts.set(pluginId, (this.counts.get(pluginId) ?? 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = (this.counts.get(pluginId) ?? 1) - 1;
      if (remaining) this.counts.set(pluginId, remaining);
      else this.counts.delete(pluginId);
    }
  }
}
