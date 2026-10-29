import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ASSET_READ_JSON_LIMIT, AssetBrokerError, AssetGroupBroker, FetchAssetArtifactSource, MemoryAssetGroupStore,
  type AssetArtifactSource, type AssetCapacityMeasurement, type AssetGroupRef,
} from "./assets.js";
import type { Scope } from "./types.js";

const plugin_id = "proprium.semantic";
const group_id = "semantic-e5";
const scope: Scope = { workspace_id: "workspace-a", repository_id: 42, branch: "main", generation: "worktree-7" };

interface Fixture {
  broker: AssetGroupBroker;
  ref: AssetGroupRef;
  scope: Scope;
  source: MemoryAssetSource;
  store: MemoryAssetGroupStore;
  createBroker(): AssetGroupBroker;
  mintGesture(): object;
  setCapacity(patch: Partial<AssetCapacityMeasurement>): void;
  setRef(ref: AssetGroupRef): void;
}

class MemoryAssetSource implements AssetArtifactSource {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  failReads = false;
  async readObject(path: string, max_bytes: number): Promise<Uint8Array> {
    this.reads.push(path);
    if (this.failReads) throw new Error("source is offline");
    const bytes = this.objects.get(path);
    if (!bytes || bytes.byteLength > max_bytes) throw new Error("missing source object");
    return Uint8Array.from(bytes);
  }
}

class CountingAssetGroupStore extends MemoryAssetGroupStore {
  loads = 0;
  beforeGetChunk?: () => Promise<void>;
  corruptReads = false;
  override async getChunk(groupKey: string, path: string) {
    this.loads += 1;
    await this.beforeGetChunk?.();
    const record = await super.getChunk(groupKey, path);
    if (!record || !this.corruptReads) return record;
    const bytes = Uint8Array.from(record.bytes);
    bytes[0] = bytes[0]! ^ 0xff;
    return { ...record, bytes };
  }
}

class CorruptibleManifestStore extends MemoryAssetGroupStore {
  corruptManifestReads = false;
  override async getManifest(key: string) {
    const record = await super.getManifest(key);
    if (!record || !this.corruptManifestReads) return record;
    const bytes = Uint8Array.from(record.bytes);
    bytes[0] = bytes[0]! ^ 0xff;
    return { ...record, bytes };
  }
}

class DelayedManifestStore extends MemoryAssetGroupStore {
  beforePutManifest?: () => Promise<void>;
  override async putManifest(record: Parameters<MemoryAssetGroupStore["putManifest"]>[0]) {
    await this.beforePutManifest?.();
    return super.putManifest(record);
  }
}

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function assetBundle(options: { bytes: Uint8Array; chunkBytes?: number; declaredFileSha?: string; id?: string }) {
  const id = options.id ?? group_id;
  const size = options.chunkBytes ?? 4;
  const chunks: Array<{ path: string; offset: number; bytes: number; sha256: string }> = [];
  const objects = new Map<string, Uint8Array>();
  for (let offset = 0, index = 0; offset < options.bytes.byteLength; index += 1) {
    const part = options.bytes.slice(offset, Math.min(offset + size, options.bytes.byteLength));
    const digest = hash(part);
    const path = `proprium/semantic/chunks/${digest}/chunk-${index}.bin`;
    chunks.push({ path, offset, bytes: part.byteLength, sha256: digest });
    objects.set(path, part);
    offset += part.byteLength;
  }
  const manifest = {
    schema: "proprium.assets/v1",
    id,
    version: "3.1.0",
    license: "Apache-2.0; model redistribution terms apply",
    files: [{ path: "onnx/tokenizer.json", bytes: options.bytes.byteLength, sha256: options.declaredFileSha ?? hash(options.bytes), chunks }],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestDigest = hash(manifestBytes);
  const ref: AssetGroupRef = {
    id,
    manifest_path: `proprium/semantic/manifests/${manifestDigest}/assets.json`,
    sha256: manifestDigest,
    bytes: manifestBytes.byteLength,
    role: "embedding",
  };
  objects.set(ref.manifest_path, manifestBytes);
  return { ref, objects, chunks, file_path: manifest.files[0]!.path };
}

function fixture(options: { bytes?: Uint8Array; chunkBytes?: number; declaredFileSha?: string; store?: MemoryAssetGroupStore } = {}): Fixture {
  const bundle = assetBundle({ bytes: options.bytes ?? new TextEncoder().encode("A😀B/漢字/café"), ...options });
  const source = new MemoryAssetSource();
  for (const [path, bytes] of bundle.objects) source.objects.set(path, bytes);
  let currentRef = bundle.ref;
  let capacity: AssetCapacityMeasurement = {
    device_supported: true, available_storage_bytes: 64 * 1024 * 1024,
    device_requirements: ["Host policy permits this group on the current device"], memory_required_bytes: 24 * 1024 * 1024,
  };
  const minted = new WeakSet<object>();
  const store = options.store ?? new MemoryAssetGroupStore();
  const createBroker = () => new AssetGroupBroker({
    resolver: { resolve: async (requestedPlugin, requestedGroup) => requestedPlugin === plugin_id && requestedGroup === idFor(currentRef) ? currentRef : undefined },
    source,
    store,
    capacity: { measure: async () => structuredClone(capacity) },
    gestures: { consume: token => { if (!minted.has(token)) return false; minted.delete(token); return true; } },
  });
  return {
    broker: createBroker(), createBroker, ref: bundle.ref, scope, source, store,
    mintGesture() { const token = {}; minted.add(token); return token; },
    setCapacity(patch) { capacity = { ...capacity, ...patch }; },
    setRef(ref) { currentRef = ref; },
  };
}

function idFor(ref: AssetGroupRef): string { return ref.id; }

async function inspectAndAdmit(instance: Fixture, id = group_id) {
  const preview = await instance.broker.inspect(plugin_id, id, instance.scope);
  const admitted = await instance.broker.admit(plugin_id, id, {
    scope: instance.scope,
    manifest_sha256: preview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview.manifest_sha256, storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes },
    gesture: instance.mintGesture(),
  });
  return { preview, admitted };
}

test("asset metadata inspection fetches no chunks; consented admission verifies chunks and serves pinned ranges", async () => {
  const instance = fixture({ chunkBytes: 3 });
  const preview = await instance.broker.inspect(plugin_id, group_id, instance.scope);
  assert.equal(preview.license, "Apache-2.0; model redistribution terms apply");
  assert.equal(preview.group_bytes, new TextEncoder().encode("A😀B/漢字/café").byteLength);
  assert.equal(preview.transfer_required_bytes, preview.storage_required_bytes);
  assert.equal(instance.source.reads.length, 1, "only the small asset manifest may be fetched before consent");
  assert.match(instance.source.reads[0]!, /manifests/u);

  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", instance.scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
  const admitted = await instance.broker.admit(plugin_id, group_id, {
    scope: instance.scope,
    manifest_sha256: preview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview.manifest_sha256, storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes },
    gesture: instance.mintGesture(),
  });
  assert.equal(admitted.ready, true);
  assert.equal(admitted.transferred_bytes, preview.storage_required_bytes);
  assert.ok(instance.source.reads.length > 1);

  const sourceBytes = new TextEncoder().encode("A😀B/漢字/café");
  const fetchedAfterAdmission = instance.source.reads.length;
  const result = await instance.broker.read(plugin_id, "plugin", instance.scope, {
    group_id, file_path: "onnx/tokenizer.json", offset: 2, length: 11,
  });
  assert.deepEqual(Uint8Array.from(result.bytes), sourceBytes.slice(2, 13));
  assert.equal(result.sha256, hash(sourceBytes));
  assert.equal(result.offset, 2);
  assert.equal(result.next_offset, 13);
  assert.ok(JSON.stringify(result).length < ASSET_READ_JSON_LIMIT);
  assert.equal(instance.source.reads.length, fetchedAfterAdmission, "plugin reads must never trigger a missing-asset download");
});

test("asset read denies non-plugin, cross-generation, undeclared-path and oversized callers", async () => {
  const instance = fixture();
  await inspectAndAdmit(instance);
  await assert.rejects(() => instance.broker.read(plugin_id, "mcp", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", { ...scope, generation: "worktree-8" }, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/other.bin" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "file_not_found");
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json", length: 256 * 1024 + 1 }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "invalid_input");
});

test("fresh trusted gesture, exact preview consent and measured capacity gate all chunk transfer", async () => {
  const instance = fixture();
  const preview = await instance.broker.inspect(plugin_id, group_id, instance.scope);
  const badGesture = await instance.broker.admit(plugin_id, group_id, {
    scope: instance.scope, manifest_sha256: preview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview.manifest_sha256, storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes },
    gesture: {},
  }).catch(error => error);
  assert.ok(badGesture instanceof AssetBrokerError && badGesture.code === "capability_denied");
  assert.equal(instance.source.reads.length, 1);

  instance.setCapacity({ available_storage_bytes: 0 });
  await assert.rejects(() => instance.broker.admit(plugin_id, group_id, {
    scope: instance.scope, manifest_sha256: preview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview.manifest_sha256, storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes },
    gesture: instance.mintGesture(),
  }), (error: unknown) => error instanceof AssetBrokerError && error.code === "capacity");
  assert.ok(instance.source.reads.every(path => path.includes("/manifests/")), "capacity denial happens before any model chunk fetch");
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
});

test("manifest and chunk digests plus whole-file digest are required before a ready grant", async () => {
  const badFileDigest = fixture({ declaredFileSha: "0".repeat(64) });
  const preview = await badFileDigest.broker.inspect(plugin_id, group_id, scope);
  await assert.rejects(() => badFileDigest.broker.admit(plugin_id, group_id, {
    scope, manifest_sha256: preview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview.manifest_sha256, storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes },
    gesture: badFileDigest.mintGesture(),
  }), (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" &&
    error.details?.reason === "full_file_digest_mismatch");
  await assert.rejects(() => badFileDigest.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");

  const badChunk = fixture();
  const preview2 = await badChunk.broker.inspect(plugin_id, group_id, scope);
  const manifestPath = badChunk.source.reads[0]!;
  assert.match(manifestPath, /manifests/u);
  const manifest = JSON.parse(new TextDecoder().decode(badChunk.source.objects.get(manifestPath)!)) as { files: Array<{ chunks: Array<{ path: string }> }> };
  const firstPath = manifest.files[0]!.chunks[0]!.path;
  const originalChunk = badChunk.source.objects.get(firstPath)!;
  badChunk.source.objects.set(firstPath, new Uint8Array(originalChunk.byteLength).fill(0));
  await assert.rejects(() => badChunk.broker.admit(plugin_id, group_id, {
    scope, manifest_sha256: preview2.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview2.manifest_sha256, storage_bytes: preview2.storage_required_bytes, transfer_bytes: preview2.transfer_required_bytes },
    gesture: badChunk.mintGesture(),
  }), (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" &&
    error.details?.reason === "chunk_digest_mismatch");
});

test("stale signed group reference and malformed content-addressed chunk paths are rejected", async () => {
  const instance = fixture();
  const preview = await instance.broker.inspect(plugin_id, group_id, scope);
  const changed = assetBundle({ bytes: new TextEncoder().encode("replacement"), id: group_id });
  instance.setRef(changed.ref);
  for (const [path, bytes] of changed.objects) instance.source.objects.set(path, bytes);
  await assert.rejects(() => instance.broker.admit(plugin_id, group_id, {
    scope, manifest_sha256: preview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview.manifest_sha256, storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes },
    gesture: instance.mintGesture(),
  }), (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "preview_changed");

  const invalidBundle = assetBundle({ bytes: new TextEncoder().encode("invalid path") });
  const raw = JSON.parse(new TextDecoder().decode(invalidBundle.objects.get(invalidBundle.ref.manifest_path)!)) as { files: Array<{ chunks: Array<{ path: string }> }> };
  raw.files[0]!.chunks[0]!.path = "proprium/semantic/chunks/not-the-digest/chunk.bin";
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const digest = hash(bytes);
  const invalidRef: AssetGroupRef = { ...invalidBundle.ref, manifest_path: `proprium/semantic/manifests/${digest}/assets.json`, sha256: digest, bytes: bytes.byteLength };
  const invalidInstance = fixture();
  invalidInstance.setRef(invalidRef);
  invalidInstance.source.objects.set(invalidRef.manifest_path, bytes);
  await assert.rejects(() => invalidInstance.broker.inspect(plugin_id, group_id, scope),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "invalid_asset_manifest");
  assert.equal(invalidInstance.source.reads.length, 1, "bad manifest paths are rejected before chunk fetch");
});

test("number-array JSON responses stay below 1 MiB even for high-valued 256 KiB ranges", async () => {
  const bytes = new Uint8Array(256 * 1024).fill(255);
  const instance = fixture({ bytes, chunkBytes: bytes.byteLength });
  await inspectAndAdmit(instance);
  const result = await instance.broker.read(plugin_id, "plugin", scope, {
    group_id, file_path: "onnx/tokenizer.json", length: 256 * 1024,
  });
  assert.ok(result.bytes.length < bytes.byteLength);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= ASSET_READ_JSON_LIMIT);
  assert.equal(result.next_offset, result.bytes.length);
  assert.equal(result.sha256, hash(bytes));
});

test("plugin revocation and explicit cache clearing remove read leases and cached bytes", async () => {
  const instance = fixture();
  const { admitted } = await inspectAndAdmit(instance);
  assert.equal(admitted.ready, true);
  instance.broker.revokePlugin(plugin_id);
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
  const token = instance.mintGesture();
  const cleared = await instance.broker.clearGroupCache(plugin_id, group_id, token);
  assert.ok(cleared.deleted_bytes > 0);
});

test("verified chunk lease reuses broker-owned bytes while checking current signed ref for every range", async () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 17 + 3) & 255);
  const store = new CountingAssetGroupStore();
  const instance = fixture({ bytes, chunkBytes: bytes.byteLength, store });
  await inspectAndAdmit(instance);
  store.loads = 0;

  const subtle = globalThis.crypto.subtle;
  const originalDigest = subtle.digest;
  const nativeDigest = originalDigest.bind(subtle);
  let digestCalls = 0;
  let digestBytes = 0;
  subtle.digest = (async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    digestCalls += 1;
    digestBytes += data.byteLength;
    return nativeDigest(algorithm, data);
  }) as SubtleCrypto["digest"];
  try {
    for (let index = 0; index < 12; index += 1) {
      const offset = index * 64 * 1024;
      const result = await instance.broker.read(plugin_id, "plugin", scope, {
        group_id, file_path: "onnx/tokenizer.json", offset, length: 32 * 1024,
      });
      assert.deepEqual(Uint8Array.from(result.bytes), bytes.subarray(offset, offset + result.bytes.length));
    }
  } finally {
    subtle.digest = originalDigest;
  }
  assert.equal(store.loads, 1, "the verified chunk should be fetched from Host storage once for the active grant");
  assert.equal(digestCalls, 1, "the full chunk should be hashed once, not once per engine range");
  assert.equal(digestBytes, bytes.byteLength);

  const changed = assetBundle({ bytes: new TextEncoder().encode("updated signed bytes"), id: group_id });
  instance.setRef(changed.ref);
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "group_reference_changed");
});

test("verified chunk cache is isolated by scoped grant and caller result mutation", async () => {
  const bytes = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index & 255);
  const store = new CountingAssetGroupStore();
  const instance = fixture({ bytes, chunkBytes: bytes.byteLength, store });
  await inspectAndAdmit(instance);
  store.loads = 0;
  const first = await instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json", length: 1024 });
  first.bytes[0] = (first.bytes[0]! + 1) & 255;
  const next = await instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json", length: 1024 });
  assert.equal(next.bytes[0], bytes[0], "plugin-owned response arrays cannot mutate the broker's verified bytes");
  assert.equal(store.loads, 1);

  const otherScope: Scope = { ...scope, workspace_id: "workspace-b" };
  const preview = await instance.broker.inspect(plugin_id, group_id, otherScope);
  await instance.broker.admit(plugin_id, group_id, {
    scope: otherScope, manifest_sha256: preview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: preview.manifest_sha256, storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes },
    gesture: instance.mintGesture(),
  });
  store.loads = 0;
  await instance.broker.read(plugin_id, "plugin", otherScope, { group_id, file_path: "onnx/tokenizer.json", length: 1024 });
  assert.equal(store.loads, 1, "a separate workspace grant must verify its own scoped lease");
  instance.broker.revokeScope(scope);
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
  await instance.broker.read(plugin_id, "plugin", otherScope, { group_id, file_path: "onnx/tokenizer.json", length: 1024 });
  assert.equal(store.loads, 1, "revoking one scope must preserve another active scope's cache lease");
});

test("corrupt stored chunk bytes are never leased and revoke that scoped grant", async () => {
  const store = new CountingAssetGroupStore();
  const instance = fixture({ store });
  await inspectAndAdmit(instance);
  store.corruptReads = true;
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "asset_cache_missing_or_corrupt");
  store.corruptReads = false;
  await assert.rejects(() => instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" }),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
});

test("verified chunk LRU stays within its 32 MiB cap", async () => {
  const chunkBytes = 9 * 1024 * 1024;
  const bytes = new Uint8Array(chunkBytes * 4);
  for (let chunk = 0; chunk < 4; chunk += 1) bytes.fill(chunk + 1, chunk * chunkBytes, (chunk + 1) * chunkBytes);
  const store = new CountingAssetGroupStore();
  const instance = fixture({ bytes, chunkBytes, store });
  await inspectAndAdmit(instance);
  store.loads = 0;

  for (let index = 0; index < 4; index += 1) {
    const result = await instance.broker.read(plugin_id, "plugin", scope, {
      group_id, file_path: "onnx/tokenizer.json", offset: index * chunkBytes, length: 1,
    });
    assert.equal(result.bytes[0], index + 1);
  }
  await instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json", length: 1 });
  assert.equal(store.loads, 5, "the oldest 9 MiB lease is evicted once four chunks exceed the 32 MiB bound");
});

test("plugin revocation denies a late chunk read that was waiting on storage", async () => {
  const store = new CountingAssetGroupStore();
  const instance = fixture({ store });
  await inspectAndAdmit(instance);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  store.beforeGetChunk = async () => { store.beforeGetChunk = undefined; entered(); await gate; };
  const pending = instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" });
  await started;
  instance.broker.revokePlugin(plugin_id);
  release();
  await assert.rejects(() => pending,
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
});

test("explicit cache clearing invalidates a pending chunk read before storage completes", async () => {
  const store = new CountingAssetGroupStore();
  const instance = fixture({ store });
  await inspectAndAdmit(instance);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  store.beforeGetChunk = async () => { store.beforeGetChunk = undefined; entered(); await gate; };
  const pending = instance.broker.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" });
  await started;
  const cleared = instance.broker.clearGroupCache(plugin_id, group_id, instance.mintGesture());
  await cleared;
  release();
  await assert.rejects(() => pending,
    (error: unknown) => error instanceof AssetBrokerError && error.code === "capability_denied");
});

test("verified manifest cache supports offline reload, zero-transfer admission and explicit removal", async () => {
  const store = new MemoryAssetGroupStore();
  const instance = fixture({ store });
  const { preview } = await inspectAndAdmit(instance);
  const sourceReadsAfterAdmission = [...instance.source.reads];
  instance.source.failReads = true;

  const reloaded = instance.createBroker();
  const offlinePreview = await reloaded.inspect(plugin_id, group_id, scope);
  assert.equal(offlinePreview.transfer_required_bytes, 0);
  assert.deepEqual(instance.source.reads, sourceReadsAfterAdmission, "cached signed manifest inspection must not contact the artifact source");
  const admitted = await reloaded.admit(plugin_id, group_id, {
    scope, manifest_sha256: offlinePreview.manifest_sha256,
    capacity_consent: { accepted: true, manifest_sha256: offlinePreview.manifest_sha256, storage_bytes: offlinePreview.storage_required_bytes, transfer_bytes: 0 },
    gesture: instance.mintGesture(),
  });
  assert.equal(admitted.transferred_bytes, 0);
  const read = await reloaded.read(plugin_id, "plugin", scope, { group_id, file_path: "onnx/tokenizer.json" });
  assert.deepEqual(Uint8Array.from(read.bytes), new TextEncoder().encode("A😀B/漢字/café"));
  assert.deepEqual(instance.source.reads, sourceReadsAfterAdmission, "offline activation and reads must not download model data");

  const cleared = await reloaded.clearGroupCache(plugin_id, group_id, instance.mintGesture());
  assert.ok(cleared.deleted_bytes > preview.storage_required_bytes, "clear removes both chunk data and the cached signed manifest");
  await assert.rejects(() => reloaded.inspect(plugin_id, group_id, scope),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "fetch_failed");
});

test("corrupt cached manifests fail closed without a network fallback", async () => {
  const store = new CorruptibleManifestStore();
  const instance = fixture({ store });
  await instance.broker.inspect(plugin_id, group_id, scope);
  const sourceReads = instance.source.reads.length;
  store.corruptManifestReads = true;
  instance.source.failReads = true;

  await assert.rejects(() => instance.createBroker().inspect(plugin_id, group_id, scope),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "asset_manifest_cache_corrupt");
  assert.equal(instance.source.reads.length, sourceReads, "a corrupt digest-keyed record must not fall back to fetching another manifest");
});

test("changed signed reference cannot fall back to a cached manifest for the prior digest", async () => {
  const instance = fixture();
  await instance.broker.inspect(plugin_id, group_id, scope);
  const priorReads = instance.source.reads.length;
  const changed = assetBundle({ bytes: new TextEncoder().encode("new signed manifest"), id: group_id });
  instance.setRef(changed.ref);
  instance.source.failReads = true;

  await assert.rejects(() => instance.createBroker().inspect(plugin_id, group_id, scope),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "fetch_failed");
  assert.equal(instance.source.reads.length, priorReads + 1);
  assert.equal(instance.source.reads.at(-1), changed.ref.manifest_path, "only the current digest path may be requested");
});

test("a late verified-manifest write cannot repopulate storage after explicit cache clear", async () => {
  const store = new DelayedManifestStore();
  const instance = fixture({ store });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  store.beforePutManifest = async () => { store.beforePutManifest = undefined; entered(); await gate; };
  const pendingInspect = instance.broker.inspect(plugin_id, group_id, scope);
  await started;
  await instance.broker.clearGroupCache(plugin_id, group_id, instance.mintGesture());
  release();
  await assert.rejects(() => pendingInspect,
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "asset_cache_cleared");
  const manifestKey = `${encodeURIComponent(plugin_id)}/${encodeURIComponent(group_id)}/${instance.ref.sha256}`;
  assert.equal(await store.getManifest(manifestKey), undefined);
});

test("persistent verified manifest cache enforces entry and byte bounds", async () => {
  const store = new MemoryAssetGroupStore();
  for (let index = 0; index < 40; index += 1) {
    const key = `proprium.semantic/group-${index}/${index.toString().padStart(64, "0")}`;
    await store.putManifest({ key, group_key: `proprium.semantic/group-${index}`, sha256: "0".repeat(64), bytes: new Uint8Array([index]), cached_at: index });
  }
  assert.equal(await store.getManifest("proprium.semantic/group-0/" + "0".repeat(64)), undefined);
  assert.ok(await store.getManifest("proprium.semantic/group-39/" + "0".repeat(62) + "39"));

  const largeStore = new MemoryAssetGroupStore();
  for (let index = 0; index < 17; index += 1) {
    const key = `proprium.semantic/large-${index}/${index.toString().padStart(64, "0")}`;
    await largeStore.putManifest({
      key, group_key: `proprium.semantic/large-${index}`, sha256: "0".repeat(64),
      bytes: new Uint8Array(512 * 1024), cached_at: index,
    });
  }
  assert.equal(await largeStore.getManifest(`proprium.semantic/large-0/${"0".repeat(64)}`), undefined);
  assert.ok(await largeStore.getManifest(`proprium.semantic/large-16/${"0".repeat(62)}16`));
});

test("a missing signed model group stays unavailable and never reports a synthetic ready result", async () => {
  const source = new MemoryAssetSource();
  const broker = new AssetGroupBroker({
    resolver: { resolve: async () => undefined },
    source,
    store: new MemoryAssetGroupStore(),
    capacity: { measure: async () => ({ device_supported: true, available_storage_bytes: 1, device_requirements: [], memory_required_bytes: 1 }) },
    gestures: { consume: () => true },
  });
  await assert.rejects(() => broker.inspect(plugin_id, group_id, scope),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "group_not_admitted");
  assert.equal(source.reads.length, 0);
});

test("fetch source accepts only safe relative artifact paths under the configured Host base", async () => {
  const calls: Array<{ url: string; credentials: string | undefined; redirect: string | undefined }> = [];
  const source = new FetchAssetArtifactSource("https://assets.example.test/base", async (input, init) => {
    calls.push({ url: String(input), credentials: init?.credentials, redirect: init?.redirect });
    return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
  });
  assert.deepEqual(await source.readObject("proprium/semantic/sha/file.bin", 3), new Uint8Array([4, 5, 6]));
  assert.deepEqual(calls[0], {
    url: "https://assets.example.test/base/proprium/semantic/sha/file.bin",
    credentials: "omit", redirect: "error",
  });
  await assert.rejects(() => source.readObject("../outside.bin", 3),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "invalid_input");
  assert.equal(calls.length, 1);
});

test("manifest rejects chunks larger than 16 MiB before any chunk fetch", async () => {
  const source = new MemoryAssetSource();
  const chunkSha = "a".repeat(64);
  const rawManifest = {
    schema: "proprium.assets/v1", id: group_id, version: "1.0.0", license: "MIT",
    files: [{
      path: "model.bin", bytes: 16 * 1024 * 1024 + 1, sha256: "b".repeat(64),
      chunks: [{ path: `proprium/semantic/chunks/${chunkSha}/too-large.bin`, offset: 0, bytes: 16 * 1024 * 1024 + 1, sha256: chunkSha }],
    }],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(rawManifest));
  const manifestSha = hash(manifestBytes);
  const ref: AssetGroupRef = {
    id: group_id, manifest_path: `proprium/semantic/manifests/${manifestSha}/assets.json`,
    sha256: manifestSha, bytes: manifestBytes.byteLength, role: "embedding",
  };
  source.objects.set(ref.manifest_path, manifestBytes);
  const broker = new AssetGroupBroker({
    resolver: { resolve: async () => ref }, source, store: new MemoryAssetGroupStore(),
    capacity: { measure: async () => ({ device_supported: true, available_storage_bytes: 64 * 1024 * 1024, device_requirements: [], memory_required_bytes: null }) },
    gestures: { consume: () => true },
  });
  await assert.rejects(() => broker.inspect(plugin_id, group_id, scope),
    (error: unknown) => error instanceof AssetBrokerError && error.code === "provider_unavailable" && error.details?.reason === "invalid_asset_manifest");
  assert.equal(source.reads.length, 1);
});
