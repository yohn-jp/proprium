import type { AssetGroupRef } from "../plugin-artifact.js";
import type { Caller, Scope } from "./types.js";

const ASSET_SCHEMA = "proprium.assets/v1";
const MAX_ASSET_MANIFEST_BYTES = 512 * 1024;
const MAX_CACHED_ASSET_MANIFESTS = 32;
const MAX_CACHED_ASSET_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_VERIFIED_CHUNK_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_JSON_WIRE_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u;
const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/u;
const ASSET_DB_NAME = "proprium-authoring-assets-v1";

export type AssetGroupRole = AssetGroupRef["role"];

export interface AssetManifestChunk {
  readonly path: string;
  readonly offset: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface AssetManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly chunks: readonly AssetManifestChunk[];
}

export interface AssetManifest {
  readonly schema: typeof ASSET_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly license: string;
  readonly files: readonly AssetManifestFile[];
}

export interface AssetReadRequest {
  group_id: string;
  file_path: string;
  offset?: number;
  length?: number;
}

export interface AssetReadResult {
  group_id: string;
  file_path: string;
  offset: number;
  total_bytes: number;
  bytes: number[];
  sha256: string;
  next_offset: number | null;
}

export type AssetBrokerErrorCode = "invalid_input" | "capability_denied" | "capacity" | "storage_unknown" |
  "provider_unavailable" | "file_not_found" | "cancelled";

export class AssetBrokerError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: AssetBrokerErrorCode, message: string, readonly details?: Record<string, unknown>, retryable = false) {
    super(message);
    this.name = "AssetBrokerError";
    this.retryable = retryable;
  }
}

/** Resolves only references from the currently admitted, signed plugin manifest. */
export interface AdmittedAssetGroupResolver {
  resolve(plugin_id: string, group_id: string): Promise<AssetGroupRef | undefined>;
}

/** Paths are relative names, never URLs. Implementations use only Host-configured artifact origins. */
export interface AssetArtifactSource {
  readObject(path: string, max_bytes: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface AssetChunkRecord {
  readonly key: string;
  readonly group_key: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface AssetManifestCacheRecord {
  readonly key: string;
  /** Stable plugin/group owner key; unlike chunk group keys this excludes the manifest digest. */
  readonly group_key: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly cached_at: number;
}

/** Immutable verified chunks live in their own store, separate from plugin derived data. */
export interface AssetGroupStore {
  hasChunk(group_key: string, path: string): Promise<boolean>;
  getChunk(group_key: string, path: string): Promise<AssetChunkRecord | undefined>;
  putChunk(record: AssetChunkRecord): Promise<void>;
  deleteChunk(group_key: string, path: string): Promise<void>;
  getManifest(key: string): Promise<AssetManifestCacheRecord | undefined>;
  putManifest(record: AssetManifestCacheRecord): Promise<void>;
  deleteManifest(key: string): Promise<void>;
  deleteGroup(group_identity: string): Promise<number>;
}

export interface AssetCapacityInput {
  readonly plugin_id: string;
  readonly group_id: string;
  readonly role: AssetGroupRole;
  readonly group_bytes: number;
  readonly storage_required_bytes: number;
  readonly transfer_required_bytes: number;
  readonly scope: Scope;
}

export interface AssetCapacityMeasurement {
  /** True only after Host device policy has measured support for this group and role. */
  readonly device_supported: boolean;
  /** Current free storage, or null when the browser cannot measure it. */
  readonly available_storage_bytes: number | null;
  /** Host-renderable requirement details; no model support is inferred by the broker. */
  readonly device_requirements: readonly string[];
  readonly memory_required_bytes: number | null;
  readonly reason?: string;
}

export interface AssetCapacityPolicy {
  measure(input: AssetCapacityInput): Promise<AssetCapacityMeasurement>;
}

export interface AssetGestureAuthority {
  consume(token: object): boolean;
}

export interface AssetGroupPreview {
  readonly plugin_id: string;
  readonly group_id: string;
  readonly role: AssetGroupRole;
  readonly manifest_sha256: string;
  readonly manifest_bytes: number;
  readonly version: string;
  readonly license: string;
  readonly file_count: number;
  readonly group_bytes: number;
  readonly storage_required_bytes: number;
  readonly transfer_required_bytes: number;
  readonly capacity: AssetCapacityMeasurement;
}

export interface AssetCapacityConsent {
  readonly accepted: true;
  readonly manifest_sha256: string;
  readonly storage_bytes: number;
  readonly transfer_bytes: number;
}

export interface AssetTransferProgress {
  readonly phase: "verify" | "transfer";
  readonly group_id: string;
  readonly verified_bytes: number;
  readonly total_bytes: number;
}

export interface AssetAdmissionResult {
  readonly group_id: string;
  readonly role: AssetGroupRole;
  readonly manifest_sha256: string;
  readonly license: string;
  readonly version: string;
  readonly group_bytes: number;
  readonly storage_bytes: number;
  readonly transferred_bytes: number;
  readonly ready: true;
}

export interface AssetGroupBrokerOptions {
  readonly resolver: AdmittedAssetGroupResolver;
  readonly source: AssetArtifactSource;
  readonly store: AssetGroupStore;
  readonly capacity: AssetCapacityPolicy;
  readonly gestures: AssetGestureAuthority;
  readonly max_read_bytes?: number;
  readonly now?: () => number;
}

export interface AssetAdmissionOptions {
  readonly scope: Scope;
  readonly manifest_sha256: string;
  readonly capacity_consent: AssetCapacityConsent;
  readonly gesture: object;
  readonly signal?: AbortSignal;
  readonly on_progress?: (progress: AssetTransferProgress) => void;
}

interface ParsedManifest {
  readonly plugin_id: string;
  readonly ref: AssetGroupRef;
  readonly manifest: AssetManifest;
  readonly group_key: string;
  readonly group_bytes: number;
  readonly storage_bytes: number;
  readonly unique_chunks: readonly AssetManifestChunk[];
}

interface AssetGrant {
  readonly plugin_id: string;
  readonly group_id: string;
  readonly ref: AssetGroupRef;
  readonly scope: Scope;
  readonly parsed: ParsedManifest;
}

interface VerifiedChunkLease {
  readonly grant: AssetGrant;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** Fetches only relative immutable paths from a trusted Host-configured artifact base. */
export class FetchAssetArtifactSource implements AssetArtifactSource {
  private readonly base: URL;

  constructor(baseUrl: string | URL, private readonly fetcher: typeof fetch = fetch) {
    let base: URL;
    try { base = new URL(baseUrl); } catch { throw invalid("Configured artifact base is not a URL"); }
    if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password || base.search || base.hash) {
      throw invalid("Configured artifact base must be an HTTP(S) origin path without credentials or query data");
    }
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.base = base;
  }

  async readObject(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!safeRelativePath(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ASSET_CHUNK_BYTES) {
      throw invalid("Artifact object request is invalid");
    }
    const target = new URL(path, this.base);
    if (target.origin !== this.base.origin || !target.pathname.startsWith(this.base.pathname) || target.search || target.hash) {
      throw invalid("Artifact object escaped the configured Host base");
    }
    let response: Response;
    try {
      response = await this.fetcher(target, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw unavailable("Asset artifact could not be fetched", { reason: "fetch_failed" });
    }
    if (!response.ok || response.redirected) throw unavailable("Asset artifact is unavailable", { reason: "http_status", status: response.status });
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
      throw unavailable("Asset artifact exceeds its signed size limit", { reason: "object_too_large" });
    }
    if (!response.body) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await response.arrayBuffer()); }
      catch { throw unavailable("Asset artifact body could not be read", { reason: "body_unreadable" }); }
      if (bytes.byteLength > maxBytes) throw unavailable("Asset artifact exceeds its signed size limit", { reason: "object_too_large" });
      return bytes;
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal?.aborted) { await reader.cancel(); throw cancelled(); }
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw unavailable("Asset artifact exceeds its signed size limit", { reason: "object_too_large" }); }
        parts.push(item.value);
      }
    } catch (error) {
      if (error instanceof AssetBrokerError) throw error;
      if (signal?.aborted) throw cancelled();
      throw unavailable("Asset artifact body could not be read", { reason: "body_unreadable" });
    } finally { reader.releaseLock(); }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
    return output;
  }
}

/** IndexedDB store for immutable verified manifests and model/dictionary chunks. */
export class IndexedDbAssetGroupStore implements AssetGroupStore {
  private db?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(storageError("IndexedDB is unavailable")); return; }
      const request = indexedDB.open(ASSET_DB_NAME, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("chunks")) {
          const store = database.createObjectStore("chunks", { keyPath: "key" });
          store.createIndex("group_key", "group_key", { unique: false });
        }
        if (!database.objectStoreNames.contains("manifests")) {
          const store = database.createObjectStore("manifests", { keyPath: "key" });
          store.createIndex("group_key", "group_key", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError("Asset storage could not be opened"));
      request.onblocked = () => reject(storageError("Asset storage upgrade is blocked"));
    });
    return this.db;
  }

  async hasChunk(groupKey: string, path: string): Promise<boolean> {
    const db = await this.open();
    const key = chunkRecordKey(groupKey, path);
    return this.request(db.transaction("chunks", "readonly").objectStore("chunks").getKey(key)).then(value => value !== undefined);
  }

  async getChunk(groupKey: string, path: string): Promise<AssetChunkRecord | undefined> {
    const db = await this.open();
    return this.request(db.transaction("chunks", "readonly").objectStore("chunks").get(chunkRecordKey(groupKey, path)));
  }

  async putChunk(record: AssetChunkRecord): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("chunks", "readwrite");
    transaction.objectStore("chunks").put(cloneChunkRecord(record));
    await this.complete(transaction);
  }

  async deleteChunk(groupKey: string, path: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("chunks", "readwrite");
    transaction.objectStore("chunks").delete(chunkRecordKey(groupKey, path));
    await this.complete(transaction);
  }

  async getManifest(key: string): Promise<AssetManifestCacheRecord | undefined> {
    const db = await this.open();
    return this.request(db.transaction("manifests", "readonly").objectStore("manifests").get(key));
  }

  async putManifest(record: AssetManifestCacheRecord): Promise<void> {
    if (!(record.bytes instanceof Uint8Array) || record.bytes.byteLength > MAX_ASSET_MANIFEST_BYTES) {
      throw storageError("Verified asset manifest exceeds the bounded Host cache");
    }
    const db = await this.open();
    const transaction = db.transaction("manifests", "readwrite");
    const store = transaction.objectStore("manifests");
    const completion = this.complete(transaction);
    const request = store.getAll();
    request.onsuccess = () => {
      const existing = request.result as AssetManifestCacheRecord[];
      const retained = retainedManifestCacheKeys(existing, record);
      for (const item of existing) if (isRecord(item) && typeof item.key === "string" && !retained.has(item.key)) store.delete(item.key);
      store.put(cloneManifestCacheRecord(record));
    };
    request.onerror = () => { try { transaction.abort(); } catch { /* The transaction may already be inactive. */ } };
    await completion;
  }

  async deleteManifest(key: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("manifests", "readwrite");
    transaction.objectStore("manifests").delete(key);
    await this.complete(transaction);
  }

  async deleteGroup(groupIdentity: string): Promise<number> {
    const db = await this.open();
    const transaction = db.transaction(["chunks", "manifests"], "readwrite");
    const completion = this.complete(transaction);
    let deletedBytes = 0;
    const chunkGroupRange = IDBKeyRange.bound(`${groupIdentity}/`, `${groupIdentity}/\uffff`);
    const chunks = transaction.objectStore("chunks").index("group_key").openCursor(chunkGroupRange);
    chunks.onsuccess = () => {
      const cursor = chunks.result;
      if (!cursor) return;
      const record = cursor.value as AssetChunkRecord;
      deletedBytes += record.bytes?.byteLength ?? 0;
      cursor.delete();
      cursor.continue();
    };
    const manifests = transaction.objectStore("manifests").index("group_key").openCursor(IDBKeyRange.only(groupIdentity));
    manifests.onsuccess = () => {
      const cursor = manifests.result;
      if (!cursor) return;
      const record = cursor.value as AssetManifestCacheRecord;
      deletedBytes += record.bytes?.byteLength ?? 0;
      cursor.delete();
      cursor.continue();
    };
    await completion;
    return deletedBytes;
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError("Asset storage read failed"));
    });
  }

  private complete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(storageError("Asset storage transaction failed"));
      transaction.onabort = () => reject(storageError("Asset storage transaction was aborted"));
    });
  }
}

/** Deterministic storage adapter for broker unit tests; not a browser-storage proof. */
export class MemoryAssetGroupStore implements AssetGroupStore {
  private readonly records = new Map<string, AssetChunkRecord>();
  private readonly manifestRecords = new Map<string, AssetManifestCacheRecord>();
  async hasChunk(groupKey: string, path: string): Promise<boolean> { return this.records.has(chunkRecordKey(groupKey, path)); }
  async getChunk(groupKey: string, path: string): Promise<AssetChunkRecord | undefined> {
    const item = this.records.get(chunkRecordKey(groupKey, path));
    return item ? cloneChunkRecord(item) : undefined;
  }
  async putChunk(record: AssetChunkRecord): Promise<void> { this.records.set(record.key, cloneChunkRecord(record)); }
  async deleteChunk(groupKey: string, path: string): Promise<void> { this.records.delete(chunkRecordKey(groupKey, path)); }
  async getManifest(key: string): Promise<AssetManifestCacheRecord | undefined> {
    const item = this.manifestRecords.get(key);
    return item ? cloneManifestCacheRecord(item) : undefined;
  }
  async putManifest(record: AssetManifestCacheRecord): Promise<void> {
    if (!(record.bytes instanceof Uint8Array) || record.bytes.byteLength > MAX_ASSET_MANIFEST_BYTES) {
      throw storageError("Verified asset manifest exceeds the bounded Host cache");
    }
    const retained = retainedManifestCacheKeys([...this.manifestRecords.values()], record);
    for (const key of this.manifestRecords.keys()) if (!retained.has(key)) this.manifestRecords.delete(key);
    this.manifestRecords.set(record.key, cloneManifestCacheRecord(record));
  }
  async deleteManifest(key: string): Promise<void> { this.manifestRecords.delete(key); }
  async deleteGroup(groupIdentity: string): Promise<number> {
    let bytes = 0;
    for (const [key, item] of this.records) {
      if (item.group_key.startsWith(`${groupIdentity}/`)) { bytes += item.bytes.byteLength; this.records.delete(key); }
    }
    for (const [key, item] of this.manifestRecords) {
      if (item.group_key === groupIdentity) { bytes += item.bytes.byteLength; this.manifestRecords.delete(key); }
    }
    return bytes;
  }
}

/** Consent-gated transfer and scoped reads for signed optional asset groups. */
export class AssetGroupBroker {
  private readonly grants = new Map<string, AssetGrant>();
  /** LRU leases are scoped to one exact grant and hold broker-owned verified bytes only. */
  private readonly verifiedChunks = new Map<string, VerifiedChunkLease>();
  private verifiedChunkCacheBytes = 0;
  private readonly transfers = new Map<string, AbortController>();
  private readonly clearingGroups = new Set<string>();
  private readonly groupCacheEpochs = new Map<string, number>();
  private readonly pluginEpochs = new Map<string, number>();
  private readonly maxReadBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: AssetGroupBrokerOptions) {
    const maxRead = options.max_read_bytes ?? MAX_READ_BYTES;
    if (!Number.isSafeInteger(maxRead) || maxRead < 1 || maxRead > MAX_READ_BYTES) throw invalid("Negotiated asset read limit is invalid");
    this.maxReadBytes = maxRead;
    this.now = options.now ?? (() => Date.now());
  }

  /** Fetches and verifies only the small signed asset manifest; it never fetches model chunks. */
  async inspect(plugin_id: string, group_id: string, scope: Scope, signal?: AbortSignal): Promise<AssetGroupPreview> {
    assertPluginId(plugin_id);
    assertGroupId(group_id);
    assertScope(scope);
    const parsed = await this.loadCurrentManifest(plugin_id, group_id, signal);
    const transferBytes = await this.estimateMissingBytes(parsed);
    const capacity = await this.measureCapacity(parsed, scope, transferBytes);
    return {
      plugin_id, group_id, role: parsed.ref.role, manifest_sha256: parsed.ref.sha256,
      manifest_bytes: parsed.ref.bytes, version: parsed.manifest.version, license: parsed.manifest.license,
      file_count: parsed.manifest.files.length, group_bytes: parsed.group_bytes,
      storage_required_bytes: parsed.storage_bytes, transfer_required_bytes: transferBytes,
      capacity,
    };
  }

  /** Called only by Host UI after the user has reviewed the exact preview and pressed Start. */
  async admit(plugin_id: string, group_id: string, input: AssetAdmissionOptions): Promise<AssetAdmissionResult> {
    assertPluginId(plugin_id);
    assertGroupId(group_id);
    assertScope(input?.scope);
    if (!input || typeof input.gesture !== "object" || input.gesture === null || !isRecord(input.capacity_consent) ||
        !hasExactKeys(input.capacity_consent, ["accepted", "manifest_sha256", "storage_bytes", "transfer_bytes"]) ||
        input.capacity_consent.accepted !== true || !SHA256.test(input.manifest_sha256) ||
        input.capacity_consent.manifest_sha256 !== input.manifest_sha256 ||
        !Number.isSafeInteger(input.capacity_consent.storage_bytes) || input.capacity_consent.storage_bytes < 0 ||
        !Number.isSafeInteger(input.capacity_consent.transfer_bytes) || input.capacity_consent.transfer_bytes < 0) {
      throw invalid("Explicit asset capacity consent is required");
    }
    const transferKey = groupIdentity(plugin_id, group_id);
    if (this.clearingGroups.has(transferKey)) throw new AssetBrokerError("capacity", "Asset cache is being cleared", { reason: "cache_clear_active" }, true);
    if (!this.options.gestures.consume(input.gesture)) throw denied("A fresh trusted Host gesture is required to transfer assets");

    if (this.transfers.has(transferKey)) throw new AssetBrokerError("capacity", "This asset group already has an active transfer", { reason: "transfer_active" }, true);
    const controller = new AbortController();
    const linked = linkAbortSignals(controller, input.signal);
    const signal = linked.signal;
    this.transfers.set(transferKey, controller);
    const epoch = this.pluginEpochs.get(plugin_id) ?? 0;
    try {
      const parsed = await this.loadCurrentManifest(plugin_id, group_id, signal);
      if (parsed.ref.sha256 !== input.manifest_sha256 || input.capacity_consent.storage_bytes !== parsed.storage_bytes) {
        throw unavailable("The admitted asset changed after its capacity preview", { reason: "preview_changed" });
      }

      const missing = await this.findMissingVerifiedChunks(parsed, signal);
      const transferBytes = sumChunkBytes(missing);
      if (input.capacity_consent.transfer_bytes !== transferBytes) {
        throw new AssetBrokerError("capacity", "Cached asset bytes changed after the capacity preview; review the updated transfer amount", {
          reason: "preview_transfer_changed", preview_transfer_bytes: input.capacity_consent.transfer_bytes,
          transfer_required_bytes: transferBytes,
        }, true);
      }
      const measurement = await this.measureCapacity(parsed, input.scope, transferBytes);
      this.assertCapacity(measurement, transferBytes);
      checkCancelled(signal);
      await this.assertStillCurrent(parsed, signal);

      let verifiedBytes = 0;
      let transferredBytes = 0;
      let lastProgressAt = -Infinity;
      const progress = (phase: AssetTransferProgress["phase"], force = false) => {
        const now = this.now();
        if (!force && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        try { input.on_progress?.({ phase, group_id, verified_bytes: verifiedBytes, total_bytes: parsed.group_bytes }); }
        catch { /* UI progress observers cannot interrupt verification. */ }
      };
      const missingPaths = new Set(missing.map(chunk => chunk.path));

      for (const file of parsed.manifest.files) {
        const fileHash = new StreamingSha256();
        for (const chunk of file.chunks) {
          checkCancelled(signal);
          let bytes: Uint8Array;
          if (missingPaths.has(chunk.path)) {
            bytes = await this.readAndVerifyChunk(parsed, chunk, signal);
            await this.putChunk(parsed, chunk, bytes);
            missingPaths.delete(chunk.path);
            transferredBytes += bytes.byteLength;
          } else {
            const stored = await this.getChunk(parsed, chunk.path);
            if (!stored || !await validStoredChunk(stored, parsed, chunk)) {
              await this.options.store.deleteChunk(parsed.group_key, chunk.path).catch(() => undefined);
              throw unavailable("A previously verified asset chunk changed during transfer", { reason: "asset_cache_changed", path: chunk.path });
            }
            bytes = stored.bytes;
          }
          fileHash.update(bytes);
          verifiedBytes += bytes.byteLength;
          progress(missingPaths.size ? "transfer" : "verify");
        }
        if (fileHash.hex() !== file.sha256) {
          throw unavailable("Signed asset chunks do not match the declared whole-file digest", { reason: "full_file_digest_mismatch", file_path: file.path });
        }
      }
      if (missingPaths.size !== 0 || verifiedBytes !== parsed.group_bytes) {
        throw unavailable("Asset group verification did not cover its declared files", { reason: "incomplete_group" });
      }
      checkCancelled(signal);
      if ((this.pluginEpochs.get(plugin_id) ?? 0) !== epoch) throw cancelled("Plugin was disabled during asset transfer");
      await this.assertStillCurrent(parsed, signal);
      const grant: AssetGrant = { plugin_id, group_id, ref: parsed.ref, scope: structuredClone(input.scope), parsed };
      const grantKey = grantIdentity(plugin_id, group_id, input.scope);
      const priorGrant = this.grants.get(grantKey);
      if (priorGrant) this.clearVerifiedChunksForGrant(priorGrant);
      this.grants.set(grantKey, grant);
      progress("verify", true);
      return {
        group_id, role: parsed.ref.role, manifest_sha256: parsed.ref.sha256,
        license: parsed.manifest.license, version: parsed.manifest.version,
        group_bytes: parsed.group_bytes, storage_bytes: parsed.storage_bytes,
        transferred_bytes: transferredBytes, ready: true,
      };
    } catch (error) {
      if (error instanceof AssetBrokerError) throw error;
      if (signal.aborted) throw cancelled();
      throw storageError("Asset group transfer could not be completed");
    } finally {
      this.transfers.delete(transferKey);
      linked.detach();
    }
  }

  /** Plugin reads are served only from verified cache after a full group admission. */
  async read(plugin_id: string, caller: Caller, scope: Scope, rawRequest: AssetReadRequest): Promise<AssetReadResult> {
    assertPluginId(plugin_id);
    assertScope(scope);
    if (caller !== "plugin") throw denied("Asset bytes are available only to the active plugin caller");
    const request = validateReadRequest(rawRequest, this.maxReadBytes);
    const key = grantIdentity(plugin_id, request.group_id, scope);
    const grant = this.grants.get(key);
    if (!grant) throw denied("Asset group has not been explicitly admitted for this plugin scope");
    if (!sameScope(grant.scope, scope)) { this.grants.delete(key); throw denied("Asset group grant belongs to another workspace generation"); }
    const pluginEpoch = this.pluginEpochs.get(plugin_id) ?? 0;
    try { await this.assertStillCurrent(grant.parsed); }
    catch (error) {
      if (this.grants.get(key) === grant) {
        this.grants.delete(key);
        this.clearVerifiedChunksForGrant(grant);
      }
      throw error;
    }
    this.assertReadLease(key, grant, pluginEpoch);
    const file = grant.parsed.manifest.files.find(item => item.path === request.file_path);
    if (!file) throw new AssetBrokerError("file_not_found", "Asset file is not declared in the admitted group");
    if (request.offset > file.bytes) throw invalid("Asset range starts beyond end of file");

    const requestedBytes = Math.min(request.length, file.bytes - request.offset);
    const range = new Uint8Array(requestedBytes);
    const rangeEnd = request.offset + requestedBytes;
    for (const chunk of file.chunks) {
      const start = Math.max(request.offset, chunk.offset);
      const end = Math.min(rangeEnd, chunk.offset + chunk.bytes);
      if (end <= start) continue;
      this.assertReadLease(key, grant, pluginEpoch);
      let verifiedBytes = this.getVerifiedChunk(grant, chunk);
      if (!verifiedBytes) {
        const stored = await this.getChunk(grant.parsed, chunk.path);
        this.assertReadLease(key, grant, pluginEpoch);
        const snapshot = stored?.bytes instanceof Uint8Array ? Uint8Array.from(stored.bytes) : undefined;
        const record = stored && snapshot ? { ...stored, bytes: snapshot } : stored;
        const valid = Boolean(record && await validStoredChunk(record, grant.parsed, chunk));
        this.assertReadLease(key, grant, pluginEpoch);
        if (!valid || !record || !snapshot) {
          await this.options.store.deleteChunk(grant.parsed.group_key, chunk.path).catch(() => undefined);
          this.assertReadLease(key, grant, pluginEpoch);
          if (this.grants.get(key) === grant) {
            this.grants.delete(key);
            this.clearVerifiedChunksForGrant(grant);
          }
          throw unavailable("Verified asset bytes are no longer available in Host storage", { reason: "asset_cache_missing_or_corrupt", path: chunk.path });
        }
        verifiedBytes = this.rememberVerifiedChunk(grant, chunk, snapshot);
      }
      this.assertReadLease(key, grant, pluginEpoch);
      range.set(verifiedBytes.subarray(start - chunk.offset, end - chunk.offset), start - request.offset);
    }
    this.assertReadLease(key, grant, pluginEpoch);
    const result = fitAssetReadWire({
      group_id: request.group_id,
      file_path: request.file_path,
      offset: request.offset,
      total_bytes: file.bytes,
      bytes: range,
      sha256: file.sha256,
      next_offset: request.offset + range.byteLength < file.bytes ? request.offset + range.byteLength : null,
    });
    return result;
  }

  /** Called by the Host lifecycle when a plugin is disabled or removed. */
  revokePlugin(plugin_id: string): void {
    this.pluginEpochs.set(plugin_id, (this.pluginEpochs.get(plugin_id) ?? 0) + 1);
    for (const [key, grant] of this.grants) if (grant.plugin_id === plugin_id) this.grants.delete(key);
    this.clearVerifiedChunks(lease => lease.grant.plugin_id === plugin_id);
    for (const [key, controller] of this.transfers) if (key.startsWith(`${encodeURIComponent(plugin_id)}/`)) controller.abort();
  }

  /** Call with the prior scope when it stops being the active workspace generation. */
  revokeScope(scope: Scope): void {
    assertScope(scope);
    for (const [key, grant] of this.grants) if (sameScope(grant.scope, scope)) this.grants.delete(key);
    this.clearVerifiedChunks(lease => sameScope(lease.grant.scope, scope));
  }

  /** Explicit Host UI cache clearing; plugin callers cannot purge shared immutable assets. */
  async clearGroupCache(plugin_id: string, group_id: string, gesture: object): Promise<{ deleted_bytes: number }> {
    assertPluginId(plugin_id);
    assertGroupId(group_id);
    if (!this.options.gestures.consume(gesture)) throw denied("A fresh trusted Host gesture is required to clear asset cache");
    const transferKey = groupIdentity(plugin_id, group_id);
    if (this.transfers.has(transferKey)) throw new AssetBrokerError("capacity", "Asset cache cannot be cleared during a transfer", { reason: "transfer_active" }, true);
    if (this.clearingGroups.has(transferKey)) throw new AssetBrokerError("capacity", "Asset cache is already being cleared", { reason: "cache_clear_active" }, true);
    this.groupCacheEpochs.set(transferKey, (this.groupCacheEpochs.get(transferKey) ?? 0) + 1);
    this.clearingGroups.add(transferKey);
    this.revokeGroup(plugin_id, group_id);
    try {
      try { return { deleted_bytes: await this.options.store.deleteGroup(transferKey) }; }
      catch { throw storageError("Asset cache could not be cleared"); }
    } finally {
      this.clearingGroups.delete(transferKey);
    }
  }

  private assertReadLease(key: string, grant: AssetGrant, pluginEpoch: number): void {
    if (this.grants.get(key) !== grant || (this.pluginEpochs.get(grant.plugin_id) ?? 0) !== pluginEpoch) {
      throw denied("Asset group read lease was revoked during the request");
    }
  }

  private getVerifiedChunk(grant: AssetGrant, chunk: AssetManifestChunk): Uint8Array | undefined {
    const key = verifiedChunkIdentity(grant, chunk.path);
    const lease = this.verifiedChunks.get(key);
    if (!lease) return undefined;
    if (lease.grant !== grant || lease.sha256 !== chunk.sha256 || lease.bytes.byteLength !== chunk.bytes) {
      this.deleteVerifiedChunk(key);
      return undefined;
    }
    this.verifiedChunks.delete(key);
    this.verifiedChunks.set(key, lease);
    return lease.bytes;
  }

  private rememberVerifiedChunk(grant: AssetGrant, chunk: AssetManifestChunk, bytes: Uint8Array): Uint8Array {
    if (bytes.byteLength > MAX_VERIFIED_CHUNK_CACHE_BYTES) return bytes;
    const key = verifiedChunkIdentity(grant, chunk.path);
    this.deleteVerifiedChunk(key);
    const lease: VerifiedChunkLease = { grant, sha256: chunk.sha256, bytes };
    this.verifiedChunks.set(key, lease);
    this.verifiedChunkCacheBytes += bytes.byteLength;
    while (this.verifiedChunkCacheBytes > MAX_VERIFIED_CHUNK_CACHE_BYTES) {
      const oldest = this.verifiedChunks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deleteVerifiedChunk(oldest);
    }
    return bytes;
  }

  private clearVerifiedChunksForGrant(grant: AssetGrant): void {
    this.clearVerifiedChunks(lease => lease.grant === grant);
  }

  private clearVerifiedChunks(matches: (lease: VerifiedChunkLease) => boolean): void {
    for (const [key, lease] of this.verifiedChunks) if (matches(lease)) this.deleteVerifiedChunk(key);
  }

  private deleteVerifiedChunk(key: string): void {
    const lease = this.verifiedChunks.get(key);
    if (!lease) return;
    this.verifiedChunks.delete(key);
    this.verifiedChunkCacheBytes -= lease.bytes.byteLength;
  }

  private revokeGroup(plugin_id: string, group_id: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.plugin_id === plugin_id && grant.group_id === group_id) this.grants.delete(key);
    }
    this.clearVerifiedChunks(lease => lease.grant.plugin_id === plugin_id && lease.grant.group_id === group_id);
  }

  private async loadCurrentManifest(plugin_id: string, group_id: string, signal?: AbortSignal): Promise<ParsedManifest> {
    checkCancelled(signal);
    const groupKey = groupIdentity(plugin_id, group_id);
    const cacheEpoch = this.groupCacheEpochs.get(groupKey) ?? 0;
    this.assertManifestCacheEpoch(groupKey, cacheEpoch);
    const ref = await this.resolveRef(plugin_id, group_id);
    this.assertManifestCacheEpoch(groupKey, cacheEpoch);
    const manifestKey = manifestCacheKey(plugin_id, group_id, ref.sha256);
    let cached: AssetManifestCacheRecord | undefined;
    try { cached = await this.options.store.getManifest(manifestKey); }
    catch { throw storageError("Cached signed asset manifest could not be read from Host storage"); }
    this.assertManifestCacheEpoch(groupKey, cacheEpoch);

    let bytes: Uint8Array;
    if (cached) {
      const matchesRef = cached.key === manifestKey && cached.group_key === groupKey && cached.sha256 === ref.sha256 &&
        cached.bytes instanceof Uint8Array && cached.bytes.byteLength === ref.bytes && cached.bytes.byteLength <= MAX_ASSET_MANIFEST_BYTES;
      bytes = cached.bytes instanceof Uint8Array ? Uint8Array.from(cached.bytes) : new Uint8Array();
      const digestMatches = matchesRef && await sha256(bytes) === ref.sha256;
      this.assertManifestCacheEpoch(groupKey, cacheEpoch);
      if (!digestMatches) {
        try { await this.options.store.deleteManifest(manifestKey); }
        catch { throw storageError("Corrupt cached signed asset manifest could not be removed"); }
        this.assertManifestCacheEpoch(groupKey, cacheEpoch);
        throw unavailable("Cached signed asset manifest bytes do not match the current signed reference", { reason: "asset_manifest_cache_corrupt" });
      }
    } else {
      bytes = await this.readObject(ref.manifest_path, ref.bytes, signal);
      this.assertManifestCacheEpoch(groupKey, cacheEpoch);
      if (bytes.byteLength !== ref.bytes || await sha256(bytes) !== ref.sha256) {
        throw unavailable("Signed asset manifest bytes do not match the admitted plugin reference", { reason: "manifest_digest_mismatch" });
      }
    }
    const manifest = parseAssetManifest(bytes, ref, plugin_id);
    const parsed = summarizeManifest(plugin_id, ref, manifest);
    await this.assertStillCurrent(parsed, signal);
    this.assertManifestCacheEpoch(groupKey, cacheEpoch);
    if (!cached) {
      try {
        await this.options.store.putManifest({
          key: manifestKey, group_key: groupKey, sha256: ref.sha256,
          bytes: Uint8Array.from(bytes), cached_at: this.now(),
        });
      } catch { throw storageError("Verified signed asset manifest could not be cached by the Host"); }
      try { this.assertManifestCacheEpoch(groupKey, cacheEpoch); }
      catch (error) {
        await this.options.store.deleteManifest(manifestKey).catch(() => undefined);
        throw error;
      }
    }
    return parsed;
  }

  private assertManifestCacheEpoch(groupKey: string, epoch: number): void {
    if (this.clearingGroups.has(groupKey) || (this.groupCacheEpochs.get(groupKey) ?? 0) !== epoch) {
      throw unavailable("Host cache clearing invalidated this signed asset manifest operation", { reason: "asset_cache_cleared" });
    }
  }

  private async resolveRef(plugin_id: string, group_id: string): Promise<AssetGroupRef> {
    let ref: AssetGroupRef | undefined;
    try { ref = await this.options.resolver.resolve(plugin_id, group_id); }
    catch { throw unavailable("Signed asset group is not available from the admitted plugin", { reason: "group_resolution_failed" }); }
    if (!ref) throw unavailable("Signed asset group is not present in the admitted plugin", { reason: "group_not_admitted" });
    validateAssetGroupRef(plugin_id, group_id, ref);
    return structuredClone(ref);
  }

  private async assertStillCurrent(parsed: ParsedManifest, signal?: AbortSignal): Promise<void> {
    checkCancelled(signal);
    const current = await this.resolveRef(parsed.plugin_id, parsed.ref.id);
    if (!sameAssetRef(current, parsed.ref)) throw unavailable("Signed asset group reference is no longer current", { reason: "group_reference_changed" });
  }

  private async readObject(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      const bytes = await this.options.source.readObject(path, maxBytes, signal);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) throw unavailable("Asset artifact exceeded its signed size limit", { reason: "object_too_large" });
      return bytes;
    } catch (error) {
      if (error instanceof AssetBrokerError) throw error;
      if (signal?.aborted) throw cancelled();
      throw unavailable("Asset artifact is unavailable", { reason: "fetch_failed" });
    }
  }

  private async estimateMissingBytes(parsed: ParsedManifest): Promise<number> {
    let missing = 0;
    try {
      for (const chunk of parsed.unique_chunks) if (!await this.options.store.hasChunk(parsed.group_key, chunk.path)) missing += chunk.bytes;
    } catch { throw storageError("Asset storage could not be inspected"); }
    if (!Number.isSafeInteger(missing)) throw storageError("Asset transfer size exceeds safe storage accounting");
    return missing;
  }

  private async findMissingVerifiedChunks(parsed: ParsedManifest, signal?: AbortSignal): Promise<AssetManifestChunk[]> {
    const missing: AssetManifestChunk[] = [];
    for (const chunk of parsed.unique_chunks) {
      checkCancelled(signal);
      let record: AssetChunkRecord | undefined;
      try { record = await this.options.store.getChunk(parsed.group_key, chunk.path); }
      catch { throw storageError("Asset cache could not be checked before transfer"); }
      if (!record || !await validStoredChunk(record, parsed, chunk)) {
        if (record) {
          try { await this.options.store.deleteChunk(parsed.group_key, chunk.path); }
          catch { throw storageError("Invalid cached asset chunk could not be removed"); }
        }
        missing.push(chunk);
      }
    }
    return missing;
  }

  private async measureCapacity(parsed: ParsedManifest, scope: Scope, transferBytes: number): Promise<AssetCapacityMeasurement> {
    let measurement: AssetCapacityMeasurement;
    try {
      measurement = await this.options.capacity.measure({
        plugin_id: parsed.plugin_id, group_id: parsed.ref.id, role: parsed.ref.role,
        group_bytes: parsed.group_bytes, storage_required_bytes: parsed.storage_bytes,
        transfer_required_bytes: transferBytes, scope: structuredClone(scope),
      });
    } catch { throw storageError("Host device capacity could not be measured"); }
    validateCapacityMeasurement(measurement);
    return structuredClone(measurement);
  }

  private assertCapacity(measurement: AssetCapacityMeasurement, transferBytes: number): void {
    if (!measurement.device_supported || (transferBytes > 0 &&
        (measurement.available_storage_bytes === null || measurement.available_storage_bytes < transferBytes))) {
      throw new AssetBrokerError("capacity", "Host device or storage capacity is insufficient for this asset group", {
        device_supported: measurement.device_supported,
        available_storage_bytes: measurement.available_storage_bytes,
        transfer_required_bytes: transferBytes,
        reason: measurement.reason ?? (measurement.device_supported ? "storage_insufficient" : "device_unsupported_or_unmeasured"),
      }, true);
    }
  }

  private async readAndVerifyChunk(parsed: ParsedManifest, chunk: AssetManifestChunk, signal?: AbortSignal): Promise<Uint8Array> {
    checkCancelled(signal);
    const bytes = await this.readObject(chunk.path, chunk.bytes, signal);
    checkCancelled(signal);
    if (bytes.byteLength !== chunk.bytes || await sha256(bytes) !== chunk.sha256) {
      throw unavailable("Asset chunk does not match its signed digest and size", { reason: "chunk_digest_mismatch", path: chunk.path });
    }
    return bytes;
  }

  private async putChunk(parsed: ParsedManifest, chunk: AssetManifestChunk, bytes: Uint8Array): Promise<void> {
    try {
      await this.options.store.putChunk({
        key: chunkRecordKey(parsed.group_key, chunk.path), group_key: parsed.group_key,
        path: chunk.path, sha256: chunk.sha256, bytes: Uint8Array.from(bytes),
      });
    } catch (error) {
      if (error instanceof AssetBrokerError) throw error;
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        throw new AssetBrokerError("capacity", "Browser asset storage quota is exhausted", { reason: "storage_quota" }, true);
      }
      throw storageError("Verified asset chunk could not be cached");
    }
  }

  private async getChunk(parsed: ParsedManifest, path: string): Promise<AssetChunkRecord | undefined> {
    try { return await this.options.store.getChunk(parsed.group_key, path); }
    catch { throw storageError("Verified asset chunk could not be read from Host storage"); }
  }
}

export const ASSET_READ_DEFAULT_BYTES = DEFAULT_READ_BYTES;
export const ASSET_READ_MAX_BYTES = MAX_READ_BYTES;
export const ASSET_READ_JSON_LIMIT = MAX_JSON_WIRE_BYTES;

function parseAssetManifest(bytes: Uint8Array, ref: AssetGroupRef, plugin_id: string): AssetManifest {
  if (bytes.byteLength > MAX_ASSET_MANIFEST_BYTES) throw unavailable("Asset manifest exceeds its signed metadata ceiling", { reason: "manifest_too_large" });
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw unavailable("Asset manifest is not valid UTF-8 JSON", { reason: "invalid_asset_manifest" }); }
  if (!isRecord(raw) || !hasExactKeys(raw, ["schema", "id", "version", "license", "files"]) ||
      raw.schema !== ASSET_SCHEMA || raw.id !== ref.id || !validText(raw.version, 128) ||
      !validText(raw.license, 4096) || !Array.isArray(raw.files) || raw.files.length === 0) {
    throw unavailable("Asset manifest has invalid schema or identity", { reason: "invalid_asset_manifest" });
  }
  const seenFiles = new Set<string>();
  const files: AssetManifestFile[] = [];
  let groupBytes = 0;
  for (const item of raw.files) {
    if (!isRecord(item) || !hasExactKeys(item, ["path", "bytes", "sha256", "chunks"]) ||
        !safeRelativePath(item.path) || seenFiles.has(item.path) || !validByteCount(item.bytes) ||
        typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || !Array.isArray(item.chunks)) {
      throw unavailable("Asset manifest contains an invalid file declaration", { reason: "invalid_asset_manifest" });
    }
    seenFiles.add(item.path);
    let nextOffset = 0;
    const chunks: AssetManifestChunk[] = [];
    for (const rawChunk of item.chunks) {
      if (!isRecord(rawChunk) || !hasExactKeys(rawChunk, ["path", "offset", "bytes", "sha256"]) ||
          !safeRelativePath(rawChunk.path) || !validByteCount(rawChunk.offset) || !validByteCount(rawChunk.bytes) || rawChunk.bytes === 0 ||
          rawChunk.bytes > MAX_ASSET_CHUNK_BYTES || typeof rawChunk.sha256 !== "string" || !SHA256.test(rawChunk.sha256) ||
          !pathIsContentAddressed(rawChunk.path, plugin_id, rawChunk.sha256)) {
        throw unavailable("Asset manifest contains an invalid chunk declaration", { reason: "invalid_asset_manifest" });
      }
      if (rawChunk.offset !== nextOffset || nextOffset + rawChunk.bytes > item.bytes) {
        throw unavailable("Asset chunks are not contiguous or exceed the declared file size", { reason: "invalid_asset_manifest" });
      }
      nextOffset += rawChunk.bytes;
      chunks.push({ path: rawChunk.path, offset: rawChunk.offset, bytes: rawChunk.bytes, sha256: rawChunk.sha256 });
    }
    if (nextOffset !== item.bytes || (item.bytes === 0 && chunks.length !== 0)) {
      throw unavailable("Asset chunks do not cover the declared file size", { reason: "invalid_asset_manifest" });
    }
    groupBytes += item.bytes;
    if (!Number.isSafeInteger(groupBytes)) throw unavailable("Asset group byte total exceeds safe accounting", { reason: "invalid_asset_manifest" });
    files.push({ path: item.path, bytes: item.bytes, sha256: item.sha256, chunks });
  }
  if (groupBytes === 0) throw unavailable("Asset group contains no bytes", { reason: "empty_asset_group" });
  return { schema: ASSET_SCHEMA, id: ref.id, version: raw.version, license: raw.license, files };
}

function summarizeManifest(plugin_id: string, ref: AssetGroupRef, manifest: AssetManifest): ParsedManifest {
  const group_key = makeGroupKey(plugin_id, ref);
  const unique = new Map<string, AssetManifestChunk>();
  let group_bytes = 0;
  for (const file of manifest.files) {
    group_bytes += file.bytes;
    if (!Number.isSafeInteger(group_bytes)) throw unavailable("Asset group byte total exceeds safe accounting", { reason: "invalid_asset_manifest" });
    for (const chunk of file.chunks) {
      const prior = unique.get(chunk.path);
      if (prior && (prior.sha256 !== chunk.sha256 || prior.bytes !== chunk.bytes)) {
        throw unavailable("One immutable chunk path has conflicting metadata", { reason: "invalid_asset_manifest", path: chunk.path });
      }
      unique.set(chunk.path, chunk);
    }
  }
  const storage_bytes = sumChunkBytes([...unique.values()]);
  return { plugin_id, ref, manifest, group_key, group_bytes, storage_bytes, unique_chunks: [...unique.values()] };
}

function validateAssetGroupRef(plugin_id: string, group_id: string, ref: AssetGroupRef): void {
  if (!isRecord(ref) || !hasExactKeys(ref, ["id", "manifest_path", "sha256", "bytes", "role"]) ||
      ref.id !== group_id || typeof ref.id !== "string" || !GROUP_ID.test(ref.id) ||
      typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256) || !validByteCount(ref.bytes) || ref.bytes < 1 ||
      ref.bytes > MAX_ASSET_MANIFEST_BYTES || !["dictionary", "embedding", "reranker"].includes(ref.role as string) ||
      !safeRelativePath(ref.manifest_path) || !pathIsContentAddressed(ref.manifest_path, plugin_id, ref.sha256)) {
    throw unavailable("Signed asset reference is invalid or not content-addressed", { reason: "invalid_group_reference" });
  }
}

function validateCapacityMeasurement(measurement: AssetCapacityMeasurement): void {
  if (!isRecord(measurement) || typeof measurement.device_supported !== "boolean" ||
      !(measurement.available_storage_bytes === null || validByteCount(measurement.available_storage_bytes)) ||
      !(measurement.memory_required_bytes === null || validByteCount(measurement.memory_required_bytes)) ||
      !Array.isArray(measurement.device_requirements) ||
      measurement.device_requirements.some(item => typeof item !== "string" || item.length > 512) ||
      (measurement.reason !== undefined && (typeof measurement.reason !== "string" || measurement.reason.length > 512))) {
    throw storageError("Host capacity policy returned invalid measurements");
  }
}

function validateReadRequest(value: AssetReadRequest, maxBytes: number): Required<AssetReadRequest> {
  if (!isRecord(value) || !hasAllowedKeys(value, ["group_id", "file_path", "offset", "length"]) ||
      typeof value.group_id !== "string" || !GROUP_ID.test(value.group_id) || !safeRelativePath(value.file_path) ||
      (value.offset !== undefined && (!validByteCount(value.offset))) ||
      (value.length !== undefined && (!validByteCount(value.length) || value.length < 1 || value.length > maxBytes))) {
    throw invalid("Asset read request is malformed or exceeds its negotiated range limit");
  }
  return { group_id: value.group_id, file_path: value.file_path, offset: value.offset ?? 0, length: value.length ?? Math.min(DEFAULT_READ_BYTES, maxBytes) };
}

function fitAssetReadWire(result: Omit<AssetReadResult, "bytes"> & { bytes: Uint8Array }): AssetReadResult {
  const available = result.bytes.byteLength;
  let low = 0;
  let high = available;
  const fits = (count: number) => {
    const nextOffset = result.offset + count < result.total_bytes ? result.offset + count : null;
    const header = new TextEncoder().encode(JSON.stringify({ ...result, bytes: [], next_offset: nextOffset })).byteLength;
    let digits = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = result.bytes[index]!;
      digits += byte < 10 ? 1 : byte < 100 ? 2 : 3;
    }
    return header + digits + Math.max(0, count - 1) <= MAX_JSON_WIRE_BYTES;
  };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  const count = low;
  if (count < 1 && available > 0) throw unavailable("Asset metadata exceeds the JSON response ceiling", { reason: "wire_limit" });
  return {
    group_id: result.group_id, file_path: result.file_path, offset: result.offset,
    total_bytes: result.total_bytes, bytes: Array.from(result.bytes.subarray(0, count)), sha256: result.sha256,
    next_offset: result.offset + count < result.total_bytes ? result.offset + count : null,
  };
}

async function validStoredChunk(record: AssetChunkRecord, parsed: ParsedManifest, expected: AssetManifestChunk): Promise<boolean> {
  if (!record || record.key !== chunkRecordKey(parsed.group_key, expected.path) || record.group_key !== parsed.group_key ||
      record.path !== expected.path || record.sha256 !== expected.sha256 || !(record.bytes instanceof Uint8Array) ||
      record.bytes.byteLength !== expected.bytes || record.bytes.byteLength > MAX_ASSET_CHUNK_BYTES) return false;
  return await sha256(record.bytes) === expected.sha256;
}

function pathIsContentAddressed(path: string, plugin_id: string, digest: string): boolean {
  const pluginSlug = plugin_id.split(".").at(-1);
  const parts = path.split("/");
  return Boolean(pluginSlug && parts[0] === "proprium" && parts[1] === pluginSlug && parts.includes(digest));
}

function safeRelativePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 256 && SAFE_PATH.test(path) &&
    !path.startsWith("/") && path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function assertPluginId(pluginId: string): void {
  if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId)) throw invalid("Plugin ID is invalid");
}

function assertGroupId(groupId: string): void {
  if (typeof groupId !== "string" || !GROUP_ID.test(groupId)) throw invalid("Asset group ID is invalid");
}

function assertScope(scope: Scope): void {
  if (!isRecord(scope) || !hasExactKeys(scope, ["workspace_id", "repository_id", "branch", "generation"]) ||
      typeof scope.workspace_id !== "string" || !scope.workspace_id || scope.workspace_id.length > 256 ||
      !(scope.repository_id === null || (Number.isSafeInteger(scope.repository_id) && scope.repository_id > 0)) ||
      typeof scope.branch !== "string" || !scope.branch || scope.branch.length > 1024 ||
      typeof scope.generation !== "string" || !scope.generation || scope.generation.length > 256) {
    throw invalid("Asset grant scope must include workspace, repository, branch and current generation");
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.workspace_id === right.workspace_id && left.repository_id === right.repository_id &&
    left.branch === right.branch && left.generation === right.generation;
}

function scopeKey(scope: Scope): string { return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch, scope.generation]); }
function groupIdentity(pluginId: string, groupId: string): string { return `${encodeURIComponent(pluginId)}/${encodeURIComponent(groupId)}`; }
function makeGroupKey(pluginId: string, ref: AssetGroupRef): string { return `${groupIdentity(pluginId, ref.id)}/${ref.sha256}`; }
function manifestCacheKey(pluginId: string, groupId: string, manifestSha256: string): string {
  return `${groupIdentity(pluginId, groupId)}/${manifestSha256}`;
}
function grantIdentity(pluginId: string, groupId: string, scope: Scope): string { return `${groupIdentity(pluginId, groupId)}/${encodeURIComponent(scopeKey(scope))}`; }
function verifiedChunkIdentity(grant: AssetGrant, path: string): string {
  return `${grantIdentity(grant.plugin_id, grant.group_id, grant.scope)}/${encodeURIComponent(path)}`;
}
function chunkRecordKey(groupKey: string, path: string): string { return `${groupKey}/${encodeURIComponent(path)}`; }
function sameAssetRef(left: AssetGroupRef, right: AssetGroupRef): boolean {
  return left.id === right.id && left.manifest_path === right.manifest_path && left.sha256 === right.sha256 &&
    left.bytes === right.bytes && left.role === right.role;
}

function validByteCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function hasAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }

function sumChunkBytes(chunks: readonly AssetManifestChunk[]): number {
  let sum = 0;
  for (const chunk of chunks) {
    sum += chunk.bytes;
    if (!Number.isSafeInteger(sum)) throw unavailable("Asset storage total exceeds safe accounting", { reason: "invalid_asset_manifest" });
  }
  return sum;
}

function cloneChunkRecord(record: AssetChunkRecord): AssetChunkRecord {
  return { key: record.key, group_key: record.group_key, path: record.path, sha256: record.sha256, bytes: Uint8Array.from(record.bytes) };
}

function cloneManifestCacheRecord(record: AssetManifestCacheRecord): AssetManifestCacheRecord {
  return {
    key: record.key, group_key: record.group_key, sha256: record.sha256,
    bytes: Uint8Array.from(record.bytes), cached_at: record.cached_at,
  };
}

function retainedManifestCacheKeys(
  existing: readonly AssetManifestCacheRecord[], incoming: AssetManifestCacheRecord,
): Set<string> {
  const retained = existing.filter((item): item is AssetManifestCacheRecord => isRecord(item) &&
    typeof item.key === "string" && typeof item.group_key === "string" && item.bytes instanceof Uint8Array &&
    item.key !== incoming.key && item.group_key !== incoming.group_key)
    .slice()
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.cached_at) ? left.cached_at : 0;
      const rightTime = Number.isFinite(right.cached_at) ? right.cached_at : 0;
      return leftTime - rightTime || left.key.localeCompare(right.key);
    });
  let totalBytes = incoming.bytes.byteLength + retained.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  while (retained.length + 1 > MAX_CACHED_ASSET_MANIFESTS || totalBytes > MAX_CACHED_ASSET_MANIFEST_BYTES) {
    const evicted = retained.shift();
    if (!evicted) throw storageError("Verified asset manifest exceeds the bounded Host cache");
    totalBytes -= evicted.bytes.byteLength;
  }
  return new Set(retained.map(item => item.key));
}

function linkAbortSignals(controller: AbortController, external?: AbortSignal): { signal: AbortSignal; detach: () => void } {
  if (!external) return { signal: controller.signal, detach: () => undefined };
  const forward = () => controller.abort(external.reason);
  if (external.aborted) forward();
  else external.addEventListener("abort", forward, { once: true });
  return { signal: controller.signal, detach: () => external.removeEventListener("abort", forward) };
}

function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }
function invalid(message: string): AssetBrokerError { return new AssetBrokerError("invalid_input", message); }
function denied(message: string): AssetBrokerError { return new AssetBrokerError("capability_denied", message); }
function unavailable(message: string, details?: Record<string, unknown>): AssetBrokerError { return new AssetBrokerError("provider_unavailable", message, details, true); }
function storageError(message: string): AssetBrokerError { return new AssetBrokerError("storage_unknown", message, undefined, true); }
function cancelled(message = "Asset transfer was cancelled"): AssetBrokerError { return new AssetBrokerError("cancelled", message, undefined, true); }

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Incremental SHA-256 keeps multi-gigabyte groups bounded to one signed chunk. */
class StreamingSha256 {
  private static readonly K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  private readonly state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private buffered = 0;
  private byteCount = 0;
  private finished?: string;

  update(data: Uint8Array): void {
    if (this.finished) throw new Error("SHA-256 digest is already finalized");
    this.byteCount += data.byteLength;
    if (!Number.isSafeInteger(this.byteCount)) throw new Error("SHA-256 input length exceeds safe accounting");
    let offset = 0;
    if (this.buffered) {
      const count = Math.min(64 - this.buffered, data.byteLength);
      this.block.set(data.subarray(0, count), this.buffered);
      this.buffered += count;
      offset = count;
      if (this.buffered === 64) { this.transform(this.block); this.buffered = 0; }
    }
    while (offset + 64 <= data.byteLength) { this.transform(data.subarray(offset, offset + 64)); offset += 64; }
    if (offset < data.byteLength) {
      this.block.set(data.subarray(offset), 0);
      this.buffered = data.byteLength - offset;
    }
  }

  hex(): string {
    if (this.finished) return this.finished;
    const bitLength = this.byteCount * 8;
    this.block[this.buffered++] = 0x80;
    if (this.buffered > 56) { this.block.fill(0, this.buffered); this.transform(this.block); this.buffered = 0; }
    this.block.fill(0, this.buffered, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.transform(this.block);
    this.finished = [...this.state].map(word => word.toString(16).padStart(8, "0")).join("");
    return this.finished;
  }

  private transform(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!; const y = words[index - 2]!;
      words[index] = (words[index - 16]! + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[index - 7]! +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + sum1 + choice + StreamingSha256.K[index]! + words[index]!) >>> 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const result = [a!,b!,c!,d!,e!,f!,g!,h!];
    for (let index = 0; index < 8; index += 1) this.state[index] = (this.state[index]! + result[index]!) >>> 0;
  }
}

function rotate(value: number, bits: number): number { return (value >>> bits) | (value << (32 - bits)); }
