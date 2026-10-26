import type { ArtifactMetadata, CacheKey, Scope, Snapshot } from "./types.js";

const DB_NAME = "proprium-authoring-brokers-v1";
const CACHE_LIMIT = 64 * 1024 * 1024;
const PREFERENCE_LIMIT = 64 * 1024;
const ARTIFACT_LIMIT = 128 * 1024 * 1024;
const CHUNK_LIMIT = 256 * 1024;

export class BrokerError extends Error {
  constructor(readonly code: "invalid_input" | "capability_denied" | "capacity" | "storage_unknown" | "file_not_found", message: string) {
    super(message); this.name = "BrokerError";
  }
}

export interface CacheRecord {
  readonly key: string;
  readonly plugin_id: string;
  readonly bytes: number;
  readonly value: unknown;
  readonly touched_at: number;
}
export interface PreferenceRecord {
  readonly key: string;
  readonly plugin_id: string;
  readonly user_partition: string;
  readonly preference_key: string;
  readonly schema_version: number;
  readonly value: unknown;
}
export interface ArtifactRecord {
  readonly artifact_id: string;
  readonly plugin_id: string;
  readonly filename: string;
  readonly media_type: string;
  readonly scope: Scope;
  readonly snapshot: Snapshot;
  readonly max_bytes: number;
  readonly state: "writing" | "sealed";
  readonly next_sequence: number;
  readonly received_bytes: number;
  readonly sha256?: string;
  readonly proposal_id?: string;
  readonly created_at: number;
}
export interface ArtifactChunk { readonly key: string; readonly artifact_id: string; readonly sequence: number; readonly sha256: string; readonly bytes: Uint8Array }

/** The narrow persistence boundary allows browser IndexedDB and deterministic tests. */
export interface BrokerStore {
  getCache(key: string): Promise<CacheRecord | undefined>;
  touchCache(key: string, touchedAt: number): Promise<void>;
  listCache(pluginId: string): Promise<CacheRecord[]>;
  putCacheBounded(record: CacheRecord, limit: number): Promise<void>;
  evictCache(pluginId: string, key?: string): Promise<boolean>;
  getPreference(key: string): Promise<PreferenceRecord | undefined>;
  listPreferences(pluginId: string, userPartition?: string): Promise<PreferenceRecord[]>;
  putPreference(record: PreferenceRecord): Promise<void>;
  getArtifact(id: string): Promise<ArtifactRecord | undefined>;
  listArtifacts(pluginId: string): Promise<ArtifactRecord[]>;
  reserveArtifact(record: ArtifactRecord): Promise<boolean>;
  putArtifact(record: ArtifactRecord, chunk?: ArtifactChunk): Promise<void>;
  getChunk(artifactId: string, sequence: number): Promise<ArtifactChunk | undefined>;
  listChunks(artifactId: string): Promise<ArtifactChunk[]>;
  deleteArtifact(artifactId: string): Promise<void>;
}

/** IndexedDB persistence separate from Git, drafts and the plugin installation store. */
export class IndexedDbBrokerStore implements BrokerStore {
  private db?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new BrokerError("storage_unknown", "IndexedDB is unavailable")); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("cache")) database.createObjectStore("cache", { keyPath: "key" });
        if (!database.objectStoreNames.contains("preferences")) database.createObjectStore("preferences", { keyPath: "key" });
        if (!database.objectStoreNames.contains("artifacts")) database.createObjectStore("artifacts", { keyPath: "artifact_id" });
        if (!database.objectStoreNames.contains("artifact_chunks")) database.createObjectStore("artifact_chunks", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new BrokerError("storage_unknown", "Authoring storage could not be opened"));
      request.onblocked = () => reject(new BrokerError("storage_unknown", "Authoring storage upgrade is blocked"));
    });
    return this.db;
  }
  async getCache(key: string): Promise<CacheRecord | undefined> {
    const db = await this.open(); return this.req(db.transaction("cache", "readonly").objectStore("cache").get(key));
  }
  async touchCache(key: string, touchedAt: number): Promise<void> {
    const db = await this.open(); const tx = db.transaction("cache", "readwrite"); const store = tx.objectStore("cache");
    const request = store.get(key); request.onsuccess = () => { if (request.result) store.put({ ...(request.result as CacheRecord), touched_at: touchedAt }); };
    await this.done(tx);
  }
  async listCache(pluginId: string): Promise<CacheRecord[]> {
    const db = await this.open(); const records = await this.req<CacheRecord[]>(db.transaction("cache", "readonly").objectStore("cache").getAll());
    return records.filter(item => item.plugin_id === pluginId);
  }
  async putCacheBounded(record: CacheRecord, limit: number): Promise<void> {
    const db = await this.open(); const tx = db.transaction("cache", "readwrite"); const store = tx.objectStore("cache");
    let quotaError = false; const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result as CacheRecord[];
      const next = all.filter(item => item.plugin_id === record.plugin_id && item.key !== record.key).sort((a, b) => a.touched_at - b.touched_at);
      let used = next.reduce((sum, item) => sum + item.bytes, 0);
      while (used + record.bytes > limit && next.length) used -= next.shift()!.bytes;
      if (used + record.bytes > limit) { quotaError = true; tx.abort(); return; }
      for (const item of all) if (item.plugin_id === record.plugin_id) store.delete(item.key);
      for (const item of next) store.put(item);
      store.put(record);
    };
    try { await this.done(tx); } catch (error) { if (quotaError) throw new BrokerError("capacity", "Derived cache quota is exhausted"); throw error; }
  }
  async evictCache(pluginId: string, key?: string): Promise<boolean> {
    const db = await this.open(); const tx = db.transaction("cache", "readwrite"); const store = tx.objectStore("cache");
    let evicted = false; const request = store.getAll();
    request.onsuccess = () => {
      for (const item of request.result as CacheRecord[]) if (item.plugin_id === pluginId && (key === undefined || item.key === key)) { store.delete(item.key); evicted = true; }
    };
    await this.done(tx); return evicted;
  }
  async getPreference(key: string): Promise<PreferenceRecord | undefined> {
    const db = await this.open(); return this.req(db.transaction("preferences", "readonly").objectStore("preferences").get(key));
  }
  async listPreferences(pluginId: string, userPartition?: string): Promise<PreferenceRecord[]> {
    const db = await this.open(); const records = await this.req<PreferenceRecord[]>(db.transaction("preferences", "readonly").objectStore("preferences").getAll());
    return records.filter(item => item.plugin_id === pluginId && (userPartition === undefined || item.user_partition === userPartition));
  }
  async putPreference(record: PreferenceRecord): Promise<void> {
    const db = await this.open(); const tx = db.transaction("preferences", "readwrite"); const store = tx.objectStore("preferences");
    let quotaError = false;
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = (request.result as PreferenceRecord[]).filter(item => item.plugin_id === record.plugin_id && item.key !== record.key);
      const size = entries.reduce((sum, item) => sum + jsonSize(item), 0) + jsonSize(record);
      if (size > PREFERENCE_LIMIT) { quotaError = true; tx.abort(); return; }
      store.put(record);
    };
    try { await this.done(tx); } catch (error) { if (quotaError) throw new BrokerError("capacity", "Plugin preferences exceed their 64 KiB quota"); throw error; }
  }
  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    const db = await this.open(); return this.req(db.transaction("artifacts", "readonly").objectStore("artifacts").get(id));
  }
  async listArtifacts(pluginId: string): Promise<ArtifactRecord[]> {
    const db = await this.open(); const records = await this.req<ArtifactRecord[]>(db.transaction("artifacts", "readonly").objectStore("artifacts").getAll());
    return records.filter(item => item.plugin_id === pluginId);
  }
  async reserveArtifact(record: ArtifactRecord): Promise<boolean> {
    const db = await this.open(); const tx = db.transaction("artifacts", "readwrite"); const store = tx.objectStore("artifacts");
    let reserved = false; const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result as ArtifactRecord[];
      if (records.some(item => item.plugin_id === record.plugin_id && item.state === "writing")) return;
      store.add(record); reserved = true;
    };
    await this.done(tx); return reserved;
  }
  async putArtifact(record: ArtifactRecord, chunk?: ArtifactChunk): Promise<void> {
    const db = await this.open(); const tx = db.transaction(chunk ? ["artifacts", "artifact_chunks"] : ["artifacts"], "readwrite");
    tx.objectStore("artifacts").put(record);
    if (chunk) tx.objectStore("artifact_chunks").put(chunk);
    await this.done(tx);
  }
  async getChunk(artifactId: string, sequence: number): Promise<ArtifactChunk | undefined> {
    const db = await this.open(); return this.req(db.transaction("artifact_chunks", "readonly").objectStore("artifact_chunks").get(chunkKey(artifactId, sequence)));
  }
  async listChunks(artifactId: string): Promise<ArtifactChunk[]> {
    const db = await this.open(); const records = await this.req<ArtifactChunk[]>(db.transaction("artifact_chunks", "readonly").objectStore("artifact_chunks").getAll());
    return records.filter(item => item.artifact_id === artifactId).sort((a, b) => a.sequence - b.sequence);
  }
  async deleteArtifact(artifactId: string): Promise<void> {
    const db = await this.open(); const tx = db.transaction(["artifacts", "artifact_chunks"], "readwrite");
    const store = tx.objectStore("artifact_chunks"); const req = store.getAll();
    req.onsuccess = () => { for (const chunk of req.result as ArtifactChunk[]) if (chunk.artifact_id === artifactId) store.delete(chunk.key); };
    tx.objectStore("artifacts").delete(artifactId); await this.done(tx);
  }
  private req<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new BrokerError("storage_unknown", "Authoring storage read failed")); });
  }
  private done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new BrokerError("storage_unknown", "Authoring storage write failed or was interrupted"));
    });
  }
}

/** In-memory store is a test adapter only; production must use IndexedDbBrokerStore. */
export class MemoryBrokerStore implements BrokerStore {
  private cache = new Map<string, CacheRecord>(); private preferences = new Map<string, PreferenceRecord>();
  private artifacts = new Map<string, ArtifactRecord>(); private chunks = new Map<string, ArtifactChunk>();
  async getCache(key: string) { const r = this.cache.get(key); return r && structuredClone(r); }
  async touchCache(key: string, touchedAt: number) { const r = this.cache.get(key); if (r) this.cache.set(key, { ...r, touched_at: touchedAt }); }
  async listCache(plugin: string) { return [...this.cache.values()].filter(r => r.plugin_id === plugin).map(r => structuredClone(r)); }
  async putCacheBounded(record: CacheRecord, limit: number) {
    const next = [...this.cache.values()].filter(item => item.plugin_id === record.plugin_id && item.key !== record.key).sort((a, b) => a.touched_at - b.touched_at);
    let used = next.reduce((sum, item) => sum + item.bytes, 0);
    while (used + record.bytes > limit && next.length) used -= next.shift()!.bytes;
    if (used + record.bytes > limit) throw new BrokerError("capacity", "Derived cache quota is exhausted");
    for (const [key, item] of this.cache) if (item.plugin_id === record.plugin_id) this.cache.delete(key);
    for (const item of next) this.cache.set(item.key, structuredClone(item));
    this.cache.set(record.key, structuredClone(record));
  }
  async evictCache(plugin: string, key?: string) {
    let removed = false;
    for (const [entryKey, item] of this.cache) if (item.plugin_id === plugin && (key === undefined || item.key === key)) { removed = true; this.cache.delete(entryKey); }
    return removed;
  }
  async getPreference(key: string) { const r = this.preferences.get(key); return r && structuredClone(r); }
  async listPreferences(plugin: string, user?: string) { return [...this.preferences.values()].filter(r => r.plugin_id === plugin && (user === undefined || r.user_partition === user)).map(r => structuredClone(r)); }
  async putPreference(record: PreferenceRecord) {
    const entries = [...this.preferences.values()].filter(r => r.plugin_id === record.plugin_id && r.key !== record.key);
    if (entries.reduce((sum, item) => sum + jsonSize(item), 0) + jsonSize(record) > PREFERENCE_LIMIT) throw new BrokerError("capacity", "Plugin preferences exceed their 64 KiB quota");
    this.preferences.set(record.key, structuredClone(record));
  }
  async getArtifact(id: string) { const r = this.artifacts.get(id); return r && structuredClone(r); }
  async listArtifacts(plugin: string) { return [...this.artifacts.values()].filter(r => r.plugin_id === plugin).map(r => structuredClone(r)); }
  async reserveArtifact(record: ArtifactRecord) {
    if ([...this.artifacts.values()].some(item => item.plugin_id === record.plugin_id && item.state === "writing")) return false;
    this.artifacts.set(record.artifact_id, structuredClone(record)); return true;
  }
  async putArtifact(record: ArtifactRecord, chunk?: ArtifactChunk) { this.artifacts.set(record.artifact_id, structuredClone(record)); if (chunk) this.chunks.set(chunk.key, { ...chunk, bytes: Uint8Array.from(chunk.bytes) }); }
  async getChunk(id: string, sequence: number) { const r = this.chunks.get(chunkKey(id, sequence)); return r && { ...r, bytes: Uint8Array.from(r.bytes) }; }
  async listChunks(id: string) { return [...this.chunks.values()].filter(c => c.artifact_id === id).sort((a, b) => a.sequence - b.sequence).map(c => ({ ...c, bytes: Uint8Array.from(c.bytes) })); }
  async deleteArtifact(id: string) { this.artifacts.delete(id); for (const [key, chunk] of this.chunks) if (chunk.artifact_id === id) this.chunks.delete(key); }
}

export class DerivedCacheBroker {
  constructor(private readonly store: BrokerStore, private readonly now = () => Date.now()) {}
  async get(pluginId: string, key: CacheKey): Promise<{ found: boolean; value?: unknown }> {
    this.validateKey(pluginId, key);
    const storageKey = cacheKey(key); const record = await this.store.getCache(storageKey);
    if (!record) return { found: false };
    if (record.plugin_id !== pluginId || record.key !== storageKey || record.bytes !== jsonSize(record.value)) {
      await this.store.evictCache(pluginId, storageKey);
      return { found: false };
    }
    await this.store.touchCache(storageKey, this.now());
    return { found: true, value: structuredClone(record.value) };
  }
  async put(pluginId: string, key: CacheKey, value: unknown): Promise<{ stored: true }> {
    this.validateKey(pluginId, key); const encoded = canonicalJson(value); const size = new TextEncoder().encode(encoded).byteLength;
    if (size > CACHE_LIMIT) throw new BrokerError("capacity", "A derived cache item exceeds the per-plugin quota");
    const storageKey = cacheKey(key);
    await this.store.putCacheBounded({ key: storageKey, plugin_id: pluginId, bytes: size, value: JSON.parse(encoded) as unknown, touched_at: this.now() }, CACHE_LIMIT);
    return { stored: true };
  }
  async evict(pluginId: string, key?: CacheKey): Promise<{ evicted: boolean }> {
    if (key) { this.validateKey(pluginId, key); return { evicted: await this.store.evictCache(pluginId, cacheKey(key)) }; }
    return { evicted: await this.store.evictCache(pluginId) };
  }
  private validateKey(plugin: string, key: CacheKey) {
    if (!key || key.plugin_id !== plugin || !key.snapshot?.id || !Number.isSafeInteger(key.schema_version) || key.schema_version < 1 ||
        !key.config_digest || key.config_digest.length > 256 || !key.key || key.key.length > 1024 ||
        (key.model_digest !== undefined && key.model_digest.length > 256)) throw new BrokerError("invalid_input", "Derived cache key is invalid or outside this plugin namespace");
  }
}

/** One-use grants are minted only by trusted UI handlers for fresh user events. */
export class FreshGestureAuthority {
  private readonly tokens = new WeakSet<object>();
  issue(event: Event): object {
    if (!event.isTrusted) throw new BrokerError("capability_denied", "A trusted user gesture is required");
    const token = Object.freeze({ issued_at: Date.now() }); this.tokens.add(token); return token;
  }
  consume(token: object): boolean {
    const age = Date.now() - (token as { issued_at: number }).issued_at;
    if (!this.tokens.has(token) || age < 0 || age > 1500) return false;
    this.tokens.delete(token); return true;
  }
}

export class PluginPreferencesBroker {
  constructor(private readonly store: BrokerStore, private readonly gestures: FreshGestureAuthority,
    private readonly validate: (pluginId: string, key: string, schemaVersion: number, value: unknown) => boolean) {}
  async read(pluginId: string, userPartition: string, key: string, schemaVersion: number): Promise<{ found: boolean; value?: unknown }> {
    validateIdentifier(pluginId, "plugin"); validateIdentifier(userPartition, "user partition"); validateIdentifier(key, "preference key");
    const record = await this.store.getPreference(preferenceKey(pluginId, userPartition, key));
    if (!record || record.plugin_id !== pluginId || record.user_partition !== userPartition || record.preference_key !== key ||
        record.schema_version !== schemaVersion || !this.validate(pluginId, key, schemaVersion, record.value)) return { found: false };
    return { found: true, value: structuredClone(record.value) };
  }
  async write(pluginId: string, userPartition: string, key: string, schemaVersion: number, value: unknown, gesture: object): Promise<{ stored: true }> {
    validateIdentifier(pluginId, "plugin"); validateIdentifier(userPartition, "user partition"); validateIdentifier(key, "preference key");
    if (!this.gestures.consume(gesture)) throw new BrokerError("capability_denied", "Preference changes require a fresh Host user gesture");
    const safe = JSON.parse(canonicalJson(value)) as unknown;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || !this.validate(pluginId, key, schemaVersion, safe)) throw new BrokerError("invalid_input", "Preference value does not match its declared schema");
    const storageKey = preferenceKey(pluginId, userPartition, key);
    const record: PreferenceRecord = { key: storageKey, plugin_id: pluginId, user_partition: userPartition, preference_key: key, schema_version: schemaVersion, value: safe };
    const current = await this.store.listPreferences(pluginId);
    const size = current.filter(item => item.key !== storageKey).reduce((sum, item) => sum + jsonSize(item), 0) + jsonSize(record);
    if (size > PREFERENCE_LIMIT) throw new BrokerError("capacity", "Plugin preferences exceed their 64 KiB quota");
    await this.store.putPreference(record); return { stored: true };
  }
}

export class ArtifactBroker {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly verified = new Set<string>();
  constructor(private readonly store: BrokerStore, private readonly now = () => Date.now(), private readonly id = randomArtifactId) {}
  create(pluginId: string, input: { media_type: string; filename: string; scope: Scope; snapshot: Snapshot }): Promise<{ artifact_id: string; max_bytes: number; max_chunk_bytes: number }> {
    return this.serial(async () => {
      validateIdentifier(pluginId, "plugin");
      if (!input || !/^[\w.+-]+\/[\w.+-]+$/u.test(input.media_type) || !input.filename || input.filename.length > 255 || /[\\/\0-\x1f]/u.test(input.filename) || !validScopeSnapshot(input.scope, input.snapshot)) throw new BrokerError("invalid_input", "Artifact declaration is invalid");
      const artifact_id = this.id();
      const record: ArtifactRecord = { artifact_id, plugin_id: pluginId, filename: input.filename, media_type: input.media_type, scope: structuredClone(input.scope), snapshot: structuredClone(input.snapshot), max_bytes: ARTIFACT_LIMIT, state: "writing", next_sequence: 0, received_bytes: 0, created_at: this.now() };
      if (!await this.store.reserveArtifact(record)) throw new BrokerError("capacity", "Only one artifact may be in flight per plugin");
      return { artifact_id, max_bytes: ARTIFACT_LIMIT, max_chunk_bytes: CHUNK_LIMIT };
    });
  }
  append(pluginId: string, artifactId: string, sequence: number, bytes: readonly number[]): Promise<{ artifact_id: string; next_sequence: number; received_bytes: number }> {
    return this.serial(async () => {
      const record = await this.requireOwned(pluginId, artifactId);
      if (record.state !== "writing" || !Number.isSafeInteger(sequence) || sequence < 0 || !Array.isArray(bytes) || bytes.length === 0 || bytes.length > CHUNK_LIMIT || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new BrokerError("invalid_input", "Artifact chunk is invalid");
      const chunkBytes = Uint8Array.from(bytes); const digest = await sha256(chunkBytes);
      if (sequence < record.next_sequence) {
        const old = await this.store.getChunk(artifactId, sequence);
        if (!old || old.sha256 !== digest || !equalBytes(old.bytes, chunkBytes)) throw new BrokerError("invalid_input", "Duplicate artifact chunks must be byte-identical");
        return { artifact_id: artifactId, next_sequence: record.next_sequence, received_bytes: record.received_bytes };
      }
      if (sequence !== record.next_sequence) throw new BrokerError("invalid_input", "Artifact chunks must arrive in order");
      if (record.received_bytes + chunkBytes.byteLength > record.max_bytes) { await this.store.deleteArtifact(artifactId); throw new BrokerError("capacity", "Artifact exceeds the negotiated output limit"); }
      const next: ArtifactRecord = { ...record, next_sequence: sequence + 1, received_bytes: record.received_bytes + chunkBytes.byteLength };
      await this.store.putArtifact(next, { key: chunkKey(artifactId, sequence), artifact_id: artifactId, sequence, sha256: digest, bytes: chunkBytes });
      return { artifact_id: artifactId, next_sequence: next.next_sequence, received_bytes: next.received_bytes };
    });
  }
  seal(pluginId: string, artifactId: string, expectedSha256: string, totalBytes: number): Promise<ArtifactMetadata> {
    return this.serial(async () => {
      const record = await this.requireOwned(pluginId, artifactId);
      if (record.state !== "writing" || !/^[a-f\d]{64}$/u.test(expectedSha256) || totalBytes !== record.received_bytes) { await this.store.deleteArtifact(artifactId); throw new BrokerError("invalid_input", "Artifact seal metadata does not match its staged bytes"); }
      const chunks = await this.store.listChunks(artifactId);
      if (chunks.length !== record.next_sequence || chunks.some((chunk, i) => chunk.sequence !== i)) { await this.store.deleteArtifact(artifactId); throw new BrokerError("storage_unknown", "Artifact chunk journal is incomplete"); }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(totalBytes); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk.bytes, offset); offset += chunk.bytes.byteLength; }
      } catch { await this.store.deleteArtifact(artifactId); throw new BrokerError("capacity", "Insufficient browser memory to verify artifact"); }
      const actual = await sha256(bytes);
      if (actual !== expectedSha256) { await this.store.deleteArtifact(artifactId); throw new BrokerError("invalid_input", "Artifact digest does not match its staged bytes"); }
      await this.store.putArtifact({ ...record, state: "sealed", sha256: actual });
      this.verified.add(artifactId);
      return { artifact_id: artifactId, media_type: record.media_type, filename: record.filename, scope: record.scope, snapshot: record.snapshot, total_bytes: totalBytes, sha256: actual };
    });
  }
  discard(pluginId: string, artifactId: string): Promise<{ discarded: boolean }> {
    return this.serial(async () => {
      const record = await this.store.getArtifact(artifactId);
      if (!record || record.plugin_id !== pluginId) return { discarded: false };
      if (record.proposal_id) return { discarded: false };
      await this.store.deleteArtifact(artifactId); return { discarded: true };
    });
  }
  /** Reserve bytes before a receipt may reference them; uncertain admission keeps them recoverable. */
  retainForProposal(pluginId: string, artifactId: string, proposalId: string): Promise<void> {
    return this.serial(async () => {
      const record = await this.requireOwned(pluginId, artifactId);
      if (record.state !== "sealed" || !proposalId) throw new BrokerError("invalid_input", "Only sealed artifacts can be retained by a proposal");
      await this.verifySealed(record);
      await this.store.putArtifact({ ...record, proposal_id: proposalId });
    });
  }
  /** Host-only metadata lookup for a scoped artifact result; it never exposes bytes to the guest. */
  hostMetadata(pluginId: string, artifactId: string, scope: Scope, snapshot: Snapshot): Promise<ArtifactMetadata> {
    return this.serial(async () => {
      const record = await this.requireOwned(pluginId, artifactId);
      if (record.state !== "sealed" || !record.sha256) throw new BrokerError("file_not_found", "Sealed artifact is unavailable");
      if (!validScopeSnapshot(scope, snapshot) || canonicalJson(record.scope) !== canonicalJson(scope) ||
          canonicalJson(record.snapshot) !== canonicalJson(snapshot)) {
        throw new BrokerError("capability_denied", "Artifact is outside the requested scope or snapshot");
      }
      // Host result admission must verify persisted bytes even when this broker
      // sealed them earlier; IndexedDB contents may have changed since then.
      await this.verifySealed(record, true);
      return {
        artifact_id: record.artifact_id, media_type: record.media_type, filename: record.filename,
        scope: structuredClone(record.scope), snapshot: structuredClone(record.snapshot),
        total_bytes: record.received_bytes, sha256: record.sha256,
      };
    });
  }
  async readSealedChunk(pluginId: string, artifactId: string, offset: number, length: number): Promise<{ bytes: Uint8Array; total_bytes: number; sha256: string; next_offset: number | null }> {
    const record = await this.requireOwned(pluginId, artifactId);
    if (record.state !== "sealed" || !record.sha256) throw new BrokerError("file_not_found", "Sealed artifact is unavailable");
    await this.verifySealed(record);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > CHUNK_LIMIT || offset > record.received_bytes) throw new BrokerError("invalid_input", "Artifact byte range is invalid");
    const parts = await this.store.listChunks(artifactId); const result = new Uint8Array(Math.min(length, record.received_bytes - offset));
    let cursor = offset; let written = 0;
    for (const part of parts) {
      const end = cursor + (result.byteLength - written); const partEnd = part.sequence === parts.length - 1 ? record.received_bytes : parts.slice(0, part.sequence + 1).reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
      const partStart = partEnd - part.bytes.byteLength;
      const start = Math.max(cursor, partStart); const stop = Math.min(end, partEnd);
      if (stop > start) { const slice = part.bytes.subarray(start - partStart, stop - partStart); result.set(slice, written); written += slice.byteLength; cursor += slice.byteLength; }
      if (written === result.byteLength) break;
    }
    if (written !== result.byteLength) throw new BrokerError("storage_unknown", "Sealed artifact bytes are incomplete");
    return { bytes: result, total_bytes: record.received_bytes, sha256: record.sha256, next_offset: offset + written < record.received_bytes ? offset + written : null };
  }
  releaseTemporary(pluginId: string): Promise<void> {
    return this.serial(async () => { for (const item of await this.store.listArtifacts(pluginId)) if (!item.proposal_id) await this.store.deleteArtifact(item.artifact_id); });
  }
  private async requireOwned(plugin: string, id: string) {
    const item = await this.store.getArtifact(id);
    if (!item || item.plugin_id !== plugin) throw new BrokerError("file_not_found", "Artifact is unavailable in this plugin scope");
    return item;
  }
  private async verifySealed(record: ArtifactRecord, force = false): Promise<void> {
    if (force) this.verified.delete(record.artifact_id);
    if (!force && this.verified.has(record.artifact_id)) return;
    if (!record.sha256) throw new BrokerError("storage_unknown", "Sealed artifact digest is missing");
    const chunks = await this.store.listChunks(record.artifact_id);
    if (chunks.length !== record.next_sequence || chunks.some((chunk, index) => chunk.sequence !== index)) throw new BrokerError("storage_unknown", "Sealed artifact chunk journal is incomplete");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(record.received_bytes); let position = 0;
      for (const chunk of chunks) {
        if (await sha256(chunk.bytes) !== chunk.sha256 || position + chunk.bytes.byteLength > bytes.byteLength) throw new BrokerError("storage_unknown", "Sealed artifact chunk digest is invalid");
        bytes.set(chunk.bytes, position); position += chunk.bytes.byteLength;
      }
      if (position !== record.received_bytes || await sha256(bytes) !== record.sha256) throw new BrokerError("storage_unknown", "Sealed artifact bytes do not match their receipt digest");
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError("storage_unknown", "Sealed artifact could not be verified");
    }
    this.verified.add(record.artifact_id);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next;
  }
}

export function cacheKey(key: CacheKey): string { return `cache:${encodeURIComponent(key.plugin_id)}:${encodeURIComponent(canonicalJson(key))}`; }
function preferenceKey(plugin: string, user: string, key: string) { return `preference:${encodeURIComponent(plugin)}:${encodeURIComponent(user)}:${encodeURIComponent(key)}`; }
function chunkKey(id: string, sequence: number) { return `${id}:${sequence.toString().padStart(8, "0")}`; }
function validateIdentifier(value: string, name: string) { if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\0\r\n]/u.test(value)) throw new BrokerError("invalid_input", `Invalid ${name} identity`); }
function validScopeSnapshot(scope: Scope, snapshot: Snapshot) {
  return !!scope && typeof scope.workspace_id === "string" && scope.workspace_id.length > 0 &&
    (scope.repository_id === null || Number.isSafeInteger(scope.repository_id) && scope.repository_id > 0) &&
    typeof scope.branch === "string" && !!scope.branch && typeof scope.generation === "string" && !!scope.generation &&
    !!snapshot && typeof snapshot.id === "string" && !!snapshot.id && typeof snapshot.worktree_generation === "string" && !!snapshot.worktree_generation &&
    (snapshot.local_commit === null || typeof snapshot.local_commit === "string") &&
    (snapshot.draft_generation === null || typeof snapshot.draft_generation === "string");
}
function canonicalJson(value: unknown): string {
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new BrokerError("invalid_input", "JSON value is too deeply nested");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => walk(child, depth + 1));
    if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) throw new BrokerError("invalid_input", "Value must be plain JSON data");
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(item as object).sort()) {
      if (name === "__proto__" || name === "constructor" || name === "prototype") throw new BrokerError("invalid_input", "Unsafe JSON object key");
      result[name] = walk((item as Record<string, unknown>)[name], depth + 1);
    }
    return result;
  };
  try { return JSON.stringify(walk(value, 0)); }
  catch (error) { if (error instanceof BrokerError) throw error; throw new BrokerError("invalid_input", "Value is not serializable JSON"); }
}
function jsonSize(value: unknown) { return new TextEncoder().encode(canonicalJson(value)).byteLength; }
async function sha256(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) throw new BrokerError("storage_unknown", "Web Crypto is unavailable for artifact verification");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}
function equalBytes(left: Uint8Array, right: Uint8Array) { return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]); }
function randomArtifactId() {
  if (!globalThis.crypto?.getRandomValues) throw new BrokerError("storage_unknown", "Secure random IDs are unavailable");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
