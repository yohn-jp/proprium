import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArtifactBroker, BrokerError, DerivedCacheBroker, FreshGestureAuthority, MemoryBrokerStore, PluginPreferencesBroker } from "./brokers.js";
import type { Scope, Snapshot } from "./types.js";

const scope: Scope = { workspace_id: "ws-a", repository_id: 1, branch: "main", generation: "g1" };
const snapshot: Snapshot = { id: "snap-a", local_commit: null, worktree_generation: "g1", draft_generation: null };
const cacheKey = { plugin_id: "proprium.research", snapshot, schema_version: 1, config_digest: "cfg", key: "terms" };

test("derived cache is namespaced, snapshot-keyed, and supports eviction", async () => {
  const store = new MemoryBrokerStore(); const broker = new DerivedCacheBroker(store);
  assert.deepEqual(await broker.get("proprium.research", cacheKey), { found: false });
  assert.deepEqual(await broker.put("proprium.research", cacheKey, { terms: ["章", "scene"] }), { stored: true });
  assert.deepEqual(await broker.get("proprium.research", cacheKey), { found: true, value: { terms: ["章", "scene"] } });
  await assert.rejects(() => broker.get("proprium.speaker", cacheKey), (error: unknown) => error instanceof BrokerError && error.code === "invalid_input");
  assert.deepEqual(await broker.evict("proprium.research", cacheKey), { evicted: true });
  assert.deepEqual(await broker.get("proprium.research", cacheKey), { found: false });
});

test("preference writes require a fresh consumed gesture and manifest schema validation", async () => {
  const store = new MemoryBrokerStore(); const authority = new FreshGestureAuthority();
  const broker = new PluginPreferencesBroker(store, authority, (plugin, key, version, value) =>
    plugin === "proprium.semantic" && key === "reranker.enabled" && version === 1 && typeof value === "boolean");
  await assert.rejects(() => broker.write("proprium.semantic", "local", "reranker.enabled", 1, true, {}),
    (error: unknown) => error instanceof BrokerError && error.code === "capability_denied");
  const event = new Event("click"); Object.defineProperty(event, "isTrusted", { value: true });
  const token = authority.issue(event);
  await broker.write("proprium.semantic", "author@example.test", "reranker.enabled", 1, true, token);
  assert.deepEqual(await broker.read("proprium.semantic", "author@example.test", "reranker.enabled", 1), { found: true, value: true });
  await assert.rejects(() => broker.write("proprium.semantic", "author@example.test", "reranker.enabled", 1, false, token),
    (error: unknown) => error instanceof BrokerError && error.code === "capability_denied");
  assert.deepEqual(await broker.read("proprium.semantic", "other@example.test", "reranker.enabled", 1), { found: false });
  const quotaBroker = new PluginPreferencesBroker(store, authority, () => true);
  const fresh = authority.issue(event);
  await assert.rejects(() => quotaBroker.write("proprium.semantic", "author@example.test", "oversized", 1, "x".repeat(65536), fresh),
    (error: unknown) => error instanceof BrokerError && error.code === "capacity");
});

test("artifact chunks are ordered, duplicate-safe, digest-sealed, scoped and retained by receipts", async () => {
  const store = new MemoryBrokerStore(); const broker = new ArtifactBroker(store);
  const created = await broker.create("proprium.publishing", { media_type: "text/plain", filename: "novel.txt", scope, snapshot });
  await assert.rejects(() => broker.create("proprium.publishing", { media_type: "text/plain", filename: "second.txt", scope, snapshot }),
    (error: unknown) => error instanceof BrokerError && error.code === "capacity");
  const first = new TextEncoder().encode("第一章\r\n"); const second = new TextEncoder().encode("終わり\n");
  const joined = new Uint8Array(first.length + second.length); joined.set(first); joined.set(second, first.length);
  const digest = createHash("sha256").update(joined).digest("hex");
  await broker.append("proprium.publishing", created.artifact_id, 0, [...first]);
  assert.deepEqual(await broker.append("proprium.publishing", created.artifact_id, 0, [...first]),
    { artifact_id: created.artifact_id, next_sequence: 1, received_bytes: first.length });
  await assert.rejects(() => broker.append("proprium.publishing", created.artifact_id, 0, [...second]),
    (error: unknown) => error instanceof BrokerError && error.code === "invalid_input");
  await assert.rejects(() => broker.append("proprium.publishing", created.artifact_id, 3, [...second]),
    (error: unknown) => error instanceof BrokerError && error.code === "invalid_input");
  await broker.append("proprium.publishing", created.artifact_id, 1, [...second]);
  const metadata = await broker.seal("proprium.publishing", created.artifact_id, digest, joined.length);
  assert.equal(metadata.sha256, digest); assert.equal(metadata.total_bytes, joined.length);
  const range = await broker.readSealedChunk("proprium.publishing", created.artifact_id, 8, 8);
  assert.deepEqual(range.bytes, joined.subarray(8, 16)); assert.equal(range.sha256, digest);
  await assert.rejects(() => broker.readSealedChunk("proprium.semantic", created.artifact_id, 0, 1),
    (error: unknown) => error instanceof BrokerError && error.code === "file_not_found");
  await broker.retainForProposal("proprium.publishing", created.artifact_id, "proposal-1");
  assert.deepEqual(await broker.discard("proprium.publishing", created.artifact_id), { discarded: false });
  await broker.releaseTemporary("proprium.publishing");
  assert.equal((await broker.readSealedChunk("proprium.publishing", created.artifact_id, 0, joined.length)).bytes.length, joined.length);
});

test("artifact seal mismatch removes the incomplete output", async () => {
  const store = new MemoryBrokerStore(); const broker = new ArtifactBroker(store);
  const created = await broker.create("proprium.publishing", { media_type: "text/plain", filename: "bad.txt", scope, snapshot });
  const bytes = new TextEncoder().encode("kept exact");
  await broker.append("proprium.publishing", created.artifact_id, 0, [...bytes]);
  await assert.rejects(() => broker.seal("proprium.publishing", created.artifact_id, "0".repeat(64), bytes.length),
    (error: unknown) => error instanceof BrokerError && error.code === "invalid_input");
  await assert.rejects(() => broker.readSealedChunk("proprium.publishing", created.artifact_id, 0, 1),
    (error: unknown) => error instanceof BrokerError && error.code === "file_not_found");
});
