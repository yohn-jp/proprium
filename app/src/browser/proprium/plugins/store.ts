import type { PluginManifest } from "../plugin-artifact.js";
import { compareVersions, type PluginDependency, type SignedRegistrySnapshot } from "./registry.js";

export interface InstalledPluginRecord {
  readonly key: string;
  readonly id: string;
  readonly version: string;
  readonly registryUrl: string;
  readonly registryDigest: string;
  /** Root key that admitted this installed package; root rotation invalidates the old admission. */
  readonly registryRootFingerprint: string;
  readonly manifestBytes: Uint8Array;
  /** Cached parsed form only; every use is re-admitted from manifestBytes and its signed registry proof. */
  readonly manifest?: PluginManifest;
  readonly manifestSha256: string;
  readonly manifestSignature: string;
  readonly publisherKey: string;
  readonly dependencies: readonly PluginDependency[];
  readonly resolvedDependencies: readonly { readonly id: string; readonly range: string; readonly version: string }[];
  readonly artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  readonly installedAt: number;
}

export interface PluginStore {
  listPlugins(): Promise<InstalledPluginRecord[]>;
  getPlugin(key: string): Promise<InstalledPluginRecord | undefined>;
  putPlugins(records: readonly InstalledPluginRecord[]): Promise<void>;
  deletePlugin(key: string): Promise<void>;
  getRegistry(url: string, digest: string): Promise<SignedRegistrySnapshot | undefined>;
  putRegistry(snapshot: SignedRegistrySnapshot): Promise<void>;
  /** Atomically advance the highest signed version with its retained snapshot. */
  advanceRegistry(snapshot: SignedRegistrySnapshot, latestStateKey: string): Promise<void>;
  getState(key: string): Promise<string | undefined>;
  setState(key: string, value: string | undefined): Promise<void>;
}

export function pluginKey(id: string, version: string): string { return `${id}@${version}`; }

/** Browser-local store. Installed bytes are disposable cache, never repository data. */
export class IndexedDbPluginStore implements PluginStore {
  private database?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is unavailable")); return; }
      const request = indexedDB.open("proprium-plugin-store", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("plugins")) db.createObjectStore("plugins", { keyPath: "key" });
        if (!db.objectStoreNames.contains("registries")) db.createObjectStore("registries", { keyPath: "key" });
        if (!db.objectStoreNames.contains("state")) db.createObjectStore("state", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Plugin store could not be opened"));
      request.onblocked = () => reject(new Error("Plugin store upgrade is blocked by another tab"));
    });
    return this.database;
  }

  async listPlugins(): Promise<InstalledPluginRecord[]> {
    const db = await this.open();
    return this.request<InstalledPluginRecord[]>(db.transaction("plugins", "readonly").objectStore("plugins").getAll());
  }

  async getPlugin(key: string): Promise<InstalledPluginRecord | undefined> {
    const db = await this.open();
    return this.request<InstalledPluginRecord | undefined>(db.transaction("plugins", "readonly").objectStore("plugins").get(key));
  }

  async putPlugins(records: readonly InstalledPluginRecord[]): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("plugins", "readwrite");
    const store = transaction.objectStore("plugins");
    for (const record of records) store.put(record);
    await this.transaction(transaction);
  }

  async deletePlugin(key: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("plugins", "readwrite");
    transaction.objectStore("plugins").delete(key);
    await this.transaction(transaction);
  }

  async getRegistry(url: string, digest: string): Promise<SignedRegistrySnapshot | undefined> {
    const db = await this.open();
    const item = await this.request<{ key: string; snapshot: SignedRegistrySnapshot } | undefined>(db.transaction("registries", "readonly").objectStore("registries").get(`${url}\n${digest}`));
    return item?.snapshot;
  }

  async putRegistry(snapshot: SignedRegistrySnapshot): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("registries", "readwrite");
    transaction.objectStore("registries").put({ key: `${snapshot.url}\n${snapshot.digest}`, snapshot });
    await this.transaction(transaction);
  }

  async advanceRegistry(snapshot: SignedRegistrySnapshot, latestStateKey: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(["registries", "state"], "readwrite", { durability: "strict" });
    const registries = transaction.objectStore("registries");
    const state = transaction.objectStore("state");
    const current = state.get(latestStateKey) as IDBRequest<{ key: string; value: string } | undefined>;
    return new Promise((resolve, reject) => {
      let failed = false;
      const abort = (error: Error) => {
        failed = true;
        try { transaction.abort(); } catch { /* Transaction already terminated. */ }
        reject(error);
      };
      const persist = () => {
        registries.put({ key: `${snapshot.url}\n${snapshot.digest}`, snapshot });
        state.put({ key: latestStateKey, value: snapshot.digest });
      };
      current.onsuccess = () => {
        const priorDigest = current.result?.value;
        if (!priorDigest || priorDigest === snapshot.digest) { persist(); return; }
        const prior = registries.get(`${snapshot.url}\n${priorDigest}`) as IDBRequest<{ key: string; snapshot: SignedRegistrySnapshot } | undefined>;
        prior.onsuccess = () => {
          const existing = prior.result?.snapshot;
          if (!existing || existing.digest !== priorDigest) {
            abort(new Error("Latest signed registry proof is missing or corrupt")); return;
          }
          const order = compareVersions(snapshot.document.version, existing.document.version);
          if (order < 0) { abort(new Error("Signed registry version rollback is rejected")); return; }
          if (order === 0) { abort(new Error("Conflicting signed registry bytes reuse an observed registry version")); return; }
          persist();
        };
        prior.onerror = () => abort(new Error("Latest registry state could not be read"));
      };
      current.onerror = () => abort(new Error("Latest registry pointer could not be read"));
      transaction.oncomplete = () => { if (!failed) resolve(); };
      transaction.onerror = () => { if (!failed) reject(new Error("Atomic registry advance failed")); };
      transaction.onabort = () => { if (!failed) reject(new Error("Atomic registry advance was interrupted")); };
    });
  }

  async getState(key: string): Promise<string | undefined> {
    const db = await this.open();
    const item = await this.request<{ key: string; value: string } | undefined>(db.transaction("state", "readonly").objectStore("state").get(key));
    return item?.value;
  }

  async setState(key: string, value: string | undefined): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("state", "readwrite");
    if (value === undefined) transaction.objectStore("state").delete(key);
    else transaction.objectStore("state").put({ key, value });
    await this.transaction(transaction);
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Plugin store read failed"));
    });
  }

  private transaction(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Plugin store write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Plugin store write was interrupted"));
    });
  }
}

/** Memory store for deterministic unit tests and short-lived non-browser harnesses. */
export class MemoryPluginStore implements PluginStore {
  private readonly plugins = new Map<string, InstalledPluginRecord>();
  private readonly registries = new Map<string, SignedRegistrySnapshot>();
  private readonly state = new Map<string, string>();
  async listPlugins(): Promise<InstalledPluginRecord[]> { return [...this.plugins.values()].map(cloneRecord); }
  async getPlugin(key: string): Promise<InstalledPluginRecord | undefined> { const value = this.plugins.get(key); return value && cloneRecord(value); }
  async putPlugins(records: readonly InstalledPluginRecord[]): Promise<void> { for (const record of records) this.plugins.set(record.key, cloneRecord(record)); }
  async deletePlugin(key: string): Promise<void> { this.plugins.delete(key); }
  async getRegistry(url: string, digest: string): Promise<SignedRegistrySnapshot | undefined> {
    const snapshot = this.registries.get(`${url}\n${digest}`);
    return snapshot && { ...snapshot, bytes: Uint8Array.from(snapshot.bytes), signature: Uint8Array.from(snapshot.signature) };
  }
  async putRegistry(snapshot: SignedRegistrySnapshot): Promise<void> {
    this.registries.set(`${snapshot.url}\n${snapshot.digest}`, { ...snapshot, bytes: Uint8Array.from(snapshot.bytes), signature: Uint8Array.from(snapshot.signature) });
  }
  async advanceRegistry(snapshot: SignedRegistrySnapshot, latestStateKey: string): Promise<void> {
    const digest = this.state.get(latestStateKey);
    if (digest && digest !== snapshot.digest) {
      const prior = this.registries.get(`${snapshot.url}\n${digest}`);
      if (!prior || prior.digest !== digest) throw new Error("Latest signed registry proof is missing or corrupt");
      const order = compareVersions(snapshot.document.version, prior.document.version);
      if (order < 0) throw new Error("Signed registry version rollback is rejected");
      if (order === 0) throw new Error("Conflicting signed registry bytes reuse an observed registry version");
    }
    await this.putRegistry(snapshot);
    this.state.set(latestStateKey, snapshot.digest);
  }
  async getState(key: string): Promise<string | undefined> { return this.state.get(key); }
  async setState(key: string, value: string | undefined): Promise<void> { if (value === undefined) this.state.delete(key); else this.state.set(key, value); }
}

function cloneRecord(record: InstalledPluginRecord): InstalledPluginRecord {
  return {
    ...record,
    ...(record.manifest ? { manifest: structuredClone(record.manifest) } : {}),
    manifestBytes: Uint8Array.from(record.manifestBytes),
    dependencies: record.dependencies.map(dependency => ({ ...dependency })),
    resolvedDependencies: record.resolvedDependencies.map(dependency => ({ ...dependency })),
    artifacts: record.artifacts.map(artifact => ({ path: artifact.path, bytes: Uint8Array.from(artifact.bytes) })),
  };
}
