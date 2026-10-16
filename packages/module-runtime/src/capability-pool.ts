import { ModuleRuntimeError } from "./runtime-error.js";

export interface CapabilityProvider<T = unknown> {
  create(): T | Promise<T>;
  dispose?(value: T): void | Promise<void>;
}

interface RegisteredProvider {
  id: string;
  version: string;
  owner?: string;
  provider: CapabilityProvider;
}

interface CapabilityEntry {
  registration: RegisteredProvider;
  promise: Promise<unknown>;
  value?: unknown;
  references: number;
  pending: number;
  disposing?: Promise<void>;
  disposed: boolean;
}

export interface CapabilityLease<T> {
  value: T;
  release(): Promise<void>;
}

/** A lazily created, version-pinned capability value shared by all live consumers. */
export class SharedCapabilityPool {
  private readonly registrations = new Map<string, RegisteredProvider>();
  private readonly entries = new Map<string, CapabilityEntry>();
  private closed = false;

  constructor(hostProviders: ReadonlyMap<string, CapabilityProvider> | Readonly<Record<string, CapabilityProvider>> = {}) {
    const entries = hostProviders instanceof Map ? hostProviders.entries() : Object.entries(hostProviders);
    for (const [id, provider] of entries) this.register(id, "host", provider);
  }

  register(id: string, version: string, provider: CapabilityProvider, owner?: string): void {
    if (this.closed) throw new ModuleRuntimeError("runtime_shutdown", "Capability pool is shut down", true);
    const current = this.registrations.get(id);
    if (current) {
      if (current.owner === owner && current.version === version && current.provider === provider) return;
      throw new ModuleRuntimeError("duplicate_capability_provider", `Capability ${id} already has a provider`);
    }
    this.registrations.set(id, { id, version, owner, provider });
  }

  async unregisterOwner(owner: string): Promise<void> {
    const owned = [...this.registrations.values()].filter((registration) => registration.owner === owner);
    for (const registration of owned) {
      const entry = this.entries.get(this.entryKey(registration));
      if (entry && (entry.references > 0 || entry.pending > 0)) {
        throw new ModuleRuntimeError("capability_in_use", `Capability ${registration.id} still has active consumers`);
      }
      if (entry) await this.disposeEntry(entry);
      if (this.registrations.get(registration.id) === registration) this.registrations.delete(registration.id);
    }
  }

  async acquire<T>(id: string, signal?: AbortSignal): Promise<CapabilityLease<T>> {
    if (this.closed) throw new ModuleRuntimeError("runtime_shutdown", "Capability pool is shut down", true);
    if (signal?.aborted) throw new ModuleRuntimeError("module_disabled", "Capability acquisition was cancelled");
    const registration = this.registrations.get(id);
    if (!registration) throw new ModuleRuntimeError("missing_capability", `No provider is registered for capability ${id}`);
    const key = this.entryKey(registration);
    let entry = this.entries.get(key);
    if (entry?.disposing) {
      await entry.disposing;
      return this.acquire<T>(id, signal);
    }
    if (!entry) {
      const created: CapabilityEntry = {
        registration,
        promise: Promise.resolve().then(() => registration.provider.create()),
        references: 0,
        pending: 0,
        disposed: false,
      };
      entry = created;
      this.entries.set(key, created);
    }
    entry.pending += 1;
    let pending = true;
    try {
      const value = await entry.promise;
      entry.value = value;
      entry.pending -= 1;
      pending = false;
      if (signal?.aborted || this.closed || entry.disposed || this.registrations.get(id) !== registration) {
        await this.disposeIfUnused(entry);
        throw new ModuleRuntimeError("module_disabled", "Capability acquisition was cancelled");
      }
      entry.references += 1;
      let released = false;
      return {
        value: value as T,
        release: async () => {
          if (released) return;
          released = true;
          entry!.references -= 1;
          await this.disposeIfUnused(entry!);
        },
      };
    } catch (error) {
      if (pending) entry.pending -= 1;
      await this.disposeIfUnused(entry);
      throw error;
    }
  }

  referenceCount(id: string): number {
    const registration = this.registrations.get(id);
    return registration ? (this.entries.get(this.entryKey(registration))?.references ?? 0) : 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.disposeEntry(entry)));
    this.entries.clear();
    this.registrations.clear();
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private entryKey(registration: RegisteredProvider): string {
    return `${registration.id}\0${registration.version}`;
  }

  private async disposeIfUnused(entry: CapabilityEntry): Promise<void> {
    if (entry.references !== 0 || entry.pending !== 0) return;
    await this.disposeEntry(entry);
  }

  private async disposeEntry(entry: CapabilityEntry): Promise<void> {
    if (entry.disposing) return entry.disposing;
    if (entry.disposed) return;
    entry.disposing = (async () => {
      let value = entry.value;
      let created = entry.value !== undefined;
      try {
        value = await entry.promise;
        entry.value = value;
        created = true;
      } catch {
        // A failed provider has no value to release.
      }
      try {
        if (created) await entry.registration.provider.dispose?.(value);
      } finally {
        entry.disposed = true;
        if (this.entries.get(this.entryKey(entry.registration)) === entry) {
          this.entries.delete(this.entryKey(entry.registration));
        }
      }
    })();
    return entry.disposing;
  }
}
