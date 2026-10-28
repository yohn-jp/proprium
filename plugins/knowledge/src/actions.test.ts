import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { guest } from "../guest.js";
import type { ActionRequest, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import { seriesBindingPreferenceKey } from "./seriesBindingFingerprint.js";

const encode = new TextEncoder();
const inputFiles: Record<string, string> = {
  "bible/characters/char-a.yaml": "id: char-a\nname: 灯\naliases: [あかり]\ntags: [lead]\nnotes:\n  lead:\n    - type: paragraph\n      text: keeper of the harbor\n  sections: []\n",
  "bible/locations/loc-a.yaml": "id: loc-a\nname: Harbor\n",
  "plot/volumes/v1/volume.yaml": "id: vol-1\ntype: volume\norder: 1\n",
  "plot/volumes/v1/chapters/c1/chapter.yaml": "id: ch-1\ntype: chapter\nvolume: vol-1\norder: 1\n",
  "plot/volumes/v1/chapters/c1/scenes/s1.yaml": "id: scene-1\ntype: scene\nchapter: ch-1\norder: 1\npov: char-a\nlocation: loc-a\nappears: [char-a]\n",
};

class HostFixture {
  readonly snapshot: Snapshot = { id: "snapshot-guest-test", local_commit: null, worktree_generation: "generation-1", draft_generation: null };
  readonly linkedSnapshot: Snapshot = { id: "snapshot-bible-test", local_commit: "b".repeat(40), worktree_generation: "bible-generation-2", draft_generation: null };
  readonly linkedScope = { workspace_id: "bible-workspace", repository_id: null, branch: "main", generation: "bible-generation-2" };
  leaseSnapshot = this.linkedSnapshot;
  leaseScope = this.linkedScope;
  readonly files: Map<string, { content: string; bytes: Uint8Array<ArrayBufferLike>; revision: string }> = new Map(Object.entries(inputFiles).map(([path, content]) => {
    const bytes = encode.encode(content);
    return [path, { content, bytes, revision: createHash("sha256").update(bytes).digest("hex") }];
  }));
  readonly linkedFiles = new Map<string, { content: string; bytes: Uint8Array<ArrayBufferLike>; revision: string }>();
  readonly operations: string[] = [];
  readonly fileSnapshots: string[] = [];
  readonly proposals: Array<Record<string, unknown>> = [];
  readonly stagedFiles = new Map<string, { content: string; bytes: Uint8Array<ArrayBufferLike>; revision: string }>();
  preferenceKey: string | undefined;
  preferenceValue: unknown;
  staleReads = false;

  respond(operation: string, payload: Record<string, unknown>): unknown {
    this.operations.push(operation);
    if (operation === "workspace.file.list") {
      const selectedSnapshot = payload.snapshot as Snapshot;
      this.fileSnapshots.push(selectedSnapshot.id);
      const sourceFiles = selectedSnapshot?.id === this.snapshot.id ? this.files
        : selectedSnapshot?.id === this.linkedSnapshot.id ? this.linkedFiles : undefined;
      if (!sourceFiles) throw Object.assign(new Error("Unknown registered snapshot"), { code: "repository_not_active" });
      const prefix = String(payload.prefix);
      const selected = new Map(sourceFiles);
      if (payload.staging_snapshot === "stage-1") for (const [path, file] of this.stagedFiles) selected.set(path, file);
      const all = [...selected.entries()].filter(([path]) => path === prefix || path.startsWith(`${prefix.replace(/\/$/u, "")}/`))
        .map(([path, file]) => ({ path, revision: file.revision, byte_length: file.bytes.length, media_type: path.endsWith(".yaml") ? "application/yaml" : "text/plain" }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const offset = payload.cursor === undefined ? 0 : Number(payload.cursor);
      const entries = all.slice(offset, offset + 2);
      const end = offset + entries.length;
      return { entries, next_cursor: end < all.length ? String(end) : null };
    }
    if (operation === "workspace.file.read") {
      const selectedSnapshot = payload.snapshot as Snapshot;
      this.fileSnapshots.push(selectedSnapshot.id);
      const sourceFiles = selectedSnapshot?.id === this.snapshot.id ? this.files
        : selectedSnapshot?.id === this.linkedSnapshot.id ? this.linkedFiles : undefined;
      if (!sourceFiles) throw Object.assign(new Error("Unknown registered snapshot"), { code: "repository_not_active" });
      const path = String(payload.path);
      const file = (payload.staging_snapshot === "stage-1" ? this.stagedFiles.get(path) : undefined) ?? sourceFiles.get(path);
      if (!file) throw Object.assign(new Error(`Missing ${path}`), { code: "file_not_found" });
      const offset = Number(payload.offset);
      const end = Math.min(file.bytes.length, offset + Math.min(Number(payload.length), 1024));
      const bytes = Array.from(file.bytes.slice(offset, end));
      return { revision: this.staleReads ? "f".repeat(64) : file.revision, total_bytes: file.bytes.length, offset, bytes, next_offset: end < file.bytes.length ? end : null };
    }
    if (operation === "plugin.preferences.read") {
      assert.equal(payload.schema_version, 1);
      if (this.preferenceKey !== undefined) assert.equal(payload.key, this.preferenceKey);
      return this.preferenceValue === undefined ? { found: false } : { found: true, value: this.preferenceValue };
    }
    if (operation === "workspace.repository.snapshot.read") {
      assert.deepEqual(payload, this.preferenceValue);
      return { scope: this.leaseScope, snapshot: this.leaseSnapshot };
    }
    if (operation === "workspace.change.propose") {
      const changeset = payload.changeset as Record<string, unknown>;
      this.proposals.push(changeset);
      return { proposal_id: "proposal-1", status: "proposed", preview: { title: changeset.title, units: changeset.units } };
    }
    if (operation === "workspace.change.timestamp") {
      assert.deepEqual(payload, {});
      return { timestamp: "2026-10-26T00:00:00.000Z" };
    }
    throw new Error(`unexpected Host operation: ${operation}`);
  }
}

function request(host: HostFixture, input: Record<string, unknown>, action_id = "knowledge.entities.list", idempotency_key?: string): Record<string, unknown> {
  const envelope: ActionRequest = {
    schema_version: 1, request_id: "request-1", plugin_id: "proprium.knowledge", action_id,
    scope: { workspace_id: "workspace-1", repository_id: 7, branch: "main", generation: "generation-1" },
    snapshot: host.snapshot, input, deadline_ms: 30_000,
    ...(idempotency_key ? { idempotency_key } : {}),
  };
  let raw = guest.invoke(JSON.stringify(envelope));
  for (let turns = 0; turns < 2000; turns++) {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if ("ok" in message) return message;
    assert.equal(message.kind, "host_call");
    const result = host.respond(String(message.operation), message.payload as Record<string, unknown>);
    raw = guest.invoke(JSON.stringify({ kind: "host_response", call_id: message.call_id, ok: true, value: result }));
  }
  throw new Error("guest did not finish within the test continuation limit");
}

test("official guest dispatches a typed paged entity action against exact Host scope and snapshot", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const result = request(host, { type: "character", limit: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.scope, { workspace_id: "workspace-1", repository_id: 7, branch: "main", generation: "generation-1" });
  assert.deepEqual(result.snapshot, host.snapshot);
  const value = result.value as { items: Array<Record<string, unknown>>; nextCursor: string | null; collectionRevision: string };
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0]?.id, "char-a");
  assert.equal(value.items[0]?.name, "灯");
  assert.equal(value.items[0]?.entityRevision, host.files.get("bible/characters/char-a.yaml")?.revision);
  assert.match(value.collectionRevision, /^[a-f0-9]{64}$/u);
  assert.equal(value.nextCursor, null);
  assert.ok(host.operations.filter((operation) => operation === "workspace.file.list").length > 3);
  guest.dispose();
});

test("shared scene cursor composes source-backed Knowledge projections at one Host snapshot", () => {
  const host = new HostFixture();
  const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
  const sceneContent = [
    "id: scene-1", "type: scene", "chapter: ch-1", "order: 1", "pov: char-a", "location: loc-a", "appears: [char-a]",
    "threads:", "  plants: [thread-lantern]", "state_events:", "  - sceneId: scene-1", "    kind: knowledge",
    "    subject: char-a", "    object: loc-a", "    payload: { knows: harbor-secret }", "    eventId: event-1",
    "    status: confirmed", "    evidence:", "      - sceneId: scene-1", "        excerpt: 灯台で待った", "manuscript: manuscript/scene.md", "",
  ].join("\n");
  const sceneBytes = encode.encode(sceneContent);
  host.files.set(scenePath, { content: sceneContent, bytes: sceneBytes, revision: createHash("sha256").update(sceneBytes).digest("hex") });
  const threadPath = "plot/threads/thread-lantern.yaml";
  const threadContent = "id: thread-lantern\ntype: thread\nname: 灯台の約束\n";
  const threadBytes = encode.encode(threadContent);
  host.files.set(threadPath, { content: threadContent, bytes: threadBytes, revision: createHash("sha256").update(threadBytes).digest("hex") });
  const manuscriptPath = "manuscript/scene.md";
  const manuscriptContent = "あかりは青い灯台で待った。翌朝、約束を思い出した。\n";
  const manuscriptBytes = encode.encode(manuscriptContent);
  host.files.set(manuscriptPath, { content: manuscriptContent, bytes: manuscriptBytes, revision: createHash("sha256").update(manuscriptBytes).digest("hex") });

  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  try {
  const listed = request(host, {}, "knowledge.lenses.scenes");
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  const items = (listed.value as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items.map(({ id }) => id), ["scene-1"]);
  const result = request(host, { sceneId: "scene-1" }, "knowledge.lenses.at-scene");
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.snapshot, host.snapshot);
  const value = result.value as {
    cursor: { sceneId: string; sourceRevision: string }; location: { id: string };
    appearances: Array<{ id: string }>; confirmedEvents: Array<{ eventId?: string }>;
    threadStates: Array<{ threadId: string; status: string }>; readerDisclosures: Array<{ entityId: string }>;
    timeline: { sceneId: string } | null; facts: Array<{ aspect: string }>;
    sourceFiles: Array<{ path: string; revision: string }>;
  };
  assert.equal(value.cursor.sceneId, "scene-1");
  assert.equal(value.cursor.sourceRevision, host.files.get(scenePath)?.revision);
  assert.equal(value.location.id, "loc-a");
  assert.deepEqual(value.appearances.map(({ id }) => id), ["char-a"]);
  assert.ok(value.confirmedEvents.some(({ eventId }) => eventId === "event-1"));
  assert.ok(value.threadStates.some(({ threadId, status }) => threadId === "thread-lantern" && status === "planted"));
  assert.ok(value.readerDisclosures.some(({ entityId }) => entityId === "char-a"));
  assert.equal(value.timeline?.sceneId, "scene-1");
  assert.ok(value.facts.some(({ aspect }) => aspect === "Location"));
  assert.ok(value.sourceFiles.some(({ path }) => path === "manuscript/scene.md"));
  assert.ok(host.fileSnapshots.length > 0 && host.fileSnapshots.every((id) => id === host.snapshot.id));
  } finally { guest.dispose(); }
});

test("guest rejects unknown input fields before reading workspace bytes", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const result = request(host, { id: "char-a", include_hidden_files: true }, "knowledge.entities.get");
  assert.equal(result.ok, false);
  assert.equal((result.error as Record<string, unknown>).code, "invalid_input");
  assert.deepEqual(host.operations, []);
  guest.dispose();
});

test("entity create emits a deterministic Host-reviewed file proposal with an absent-path precondition", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const collection = request(host, {}, "knowledge.entities.collection-revision");
  assert.equal(collection.ok, true);
  const expectedCollectionRevision = (collection.value as { collectionRevision: string }).collectionRevision;
  const result = request(host, { type: "location", expectedCollectionRevision, values: { name: "New Place", custom: { untouched: true } } }, "knowledge.entities.create", "idem-create-1");
  assert.equal(result.ok, true);
  assert.equal((result.value as Record<string, unknown>).entityId, "loc-new-place");
  assert.equal((result.value as Record<string, unknown>).proposalId, "proposal-1");
  const change = host.proposals[0]!;
  assert.equal(change.idempotency_key, "idem-create-1");
  const unit = (change.units as Array<Record<string, unknown>>)[0]!;
  const operation = (unit.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(operation.kind, "create");
  assert.equal(operation.path, "bible/locations/loc-new-place.yaml");
  assert.equal(operation.expected_revision, null);
  const read = (change.read_set as Array<Record<string, unknown>>).find((item) => item.path === operation.path);
  assert.equal(read?.revision, null);
  assert.ok(Array.isArray(operation.content));
  guest.dispose();
});

test("entity update preserves unknown YAML fields and pins both target and referenced entity revisions", () => {
  const bytes = encode.encode("id: char-a\ntype: character\nname: 灯\naliases: [あかり]\ntags: [lead]\nrelations:\n  - target: loc-a\n    kind: related\nunknownLegacyField: keep-me\nnotes:\n  lead: []\n  sections: []\n");
  const host = new HostFixture();
  host.files.set("bible/characters/char-a.yaml", { content: new TextDecoder().decode(bytes), bytes, revision: createHash("sha256").update(bytes).digest("hex") });
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const revision = host.files.get("bible/characters/char-a.yaml")!.revision;
  const result = request(host, { id: "char-a", patch: { name: "Lantern" }, expectedEntityRevision: revision }, "knowledge.entities.update", "idem-update-1");
  assert.equal(result.ok, true);
  const change = host.proposals[0]!;
  const unit = (change.units as Array<Record<string, unknown>>)[0]!;
  const operation = (unit.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(operation.kind, "replace");
  assert.equal(operation.path, "bible/characters/char-a.yaml");
  assert.equal(operation.expected_revision, revision);
  const content = new TextDecoder().decode(Uint8Array.from(operation.content as number[]));
  assert.match(content, /unknownLegacyField: keep-me/u);
  assert.match(content, /name: Lantern/u);
  assert.ok((change.read_set as Array<Record<string, unknown>>).some((item) => item.path === "bible/locations/loc-a.yaml"));
  guest.dispose();
});

test("nested character voice.yaml is a read projection and is never copied into profile writes", () => {
  const host = new HostFixture();
  host.files.delete("bible/characters/char-a.yaml");
  const profilePath = "bible/characters/char-a/profile.yaml";
  const profileContent = "id: char-a\ntype: character\nname: 灯\naliases: [あかり]\nnotes:\n  lead: []\n  sections: []\nlegacyProfileField: keep\n";
  const profileBytes = encode.encode(profileContent);
  host.files.set(profilePath, { content: profileContent, bytes: profileBytes, revision: createHash("sha256").update(profileBytes).digest("hex") });
  const voicePath = "bible/characters/char-a/voice.yaml";
  const voiceContent = "firstPerson: [わたし]\nsentenceEndings: [です]\nfutureVoiceField: keep\n";
  const voiceBytes = encode.encode(voiceContent);
  host.files.set(voicePath, { content: voiceContent, bytes: voiceBytes, revision: createHash("sha256").update(voiceBytes).digest("hex") });
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const detail = request(host, { id: "char-a" }, "knowledge.entities.get");
  assert.equal(detail.ok, true, JSON.stringify(detail.error));
  assert.deepEqual((detail.value as { entity: { raw: Record<string, unknown> } }).entity.raw.voice, { firstPerson: ["わたし"], sentenceEndings: ["です"], futureVoiceField: "keep" });
  const revision = host.files.get(profilePath)!.revision;
  const updated = request(host, { id: "char-a", patch: { name: "Lantern" }, expectedEntityRevision: revision }, "knowledge.entities.update", "idem-nested-character");
  assert.equal(updated.ok, true, JSON.stringify(updated.error));
  const change = host.proposals[0]!;
  const operations = ((change.units as Array<Record<string, unknown>>)[0]!.operations as Array<Record<string, unknown>>);
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.path, profilePath);
  const written = new TextDecoder().decode(Uint8Array.from(operations[0]!.content as number[]));
  assert.match(written, /legacyProfileField: keep/u);
  assert.match(written, /name: Lantern/u);
  assert.doesNotMatch(written, /voice:/u);
  guest.dispose();
});

test("Git-backed proposal lists distinguish an absent metadata file from malformed rows", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const state = request(host, {}, "knowledge.state-proposals.list");
  assert.equal(state.ok, true);
  assert.deepEqual((state.value as Record<string, unknown>).items, []);
  assert.equal((state.value as Record<string, unknown>).proposalFileRevision, null);
  const suggestions = request(host, {}, "knowledge.suggestions.list");
  assert.equal(suggestions.ok, true);
  assert.deepEqual((suggestions.value as Record<string, unknown>).items, []);
  assert.equal((suggestions.value as Record<string, unknown>).pendingCount, 0);
  guest.dispose();
});

test("state proposal reads retain the active legacy Git path and its source revision", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const row = {
    id: "state-a", event: { sceneId: "scene-1", order: 1, kind: "location", subject: "char-a", object: "loc-a", payload: {}, source: "manual-draft", eventId: "event-a", evidence: [], status: "proposed" },
    manuscriptHash: "a".repeat(64), status: "proposed", conflictEventIds: [], duplicateOfProposalId: null, history: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", legacyExtra: { keep: true },
  };
  const content = `${JSON.stringify(row)}\n`;
  const bytes = encode.encode(content);
  const path = "meta/scriptorium/modules/story/state-proposals.jsonl";
  const revision = createHash("sha256").update(bytes).digest("hex");
  host.files.set(path, { content, bytes, revision });
  const result = request(host, {}, "knowledge.state-proposals.list");
  assert.equal(result.ok, true);
  const value = result.value as { items: Array<Record<string, unknown>>; proposalFileRevision: string };
  assert.equal(value.proposalFileRevision, revision);
  assert.equal(value.items[0]?.legacyExtra && (value.items[0].legacyExtra as Record<string, unknown>).keep, true);
  guest.dispose();
});

test("series creation requires the active verified repository identity and proposes canonical YAML", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const result = request(host, { patch: { name: "北の物語", bibleRepositoryId: 7 }, expectedRegistryRevision: null }, "knowledge.series.propose", "idem-series-create");
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const value = result.value as Record<string, unknown>;
  assert.equal(value.seriesId, "series-1");
  const change = host.proposals[0]!;
  const operation = ((change.units as Array<Record<string, unknown>>)[0]!.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(operation.path, "meta/proprium/plugins/proprium.knowledge/v1/series.yaml");
  assert.equal(operation.expected_revision, null);
  const output = new TextDecoder().decode(Uint8Array.from(operation.content as number[]));
  assert.match(output, /bibleRepositoryId: 7/u);
  assert.match(output, /name: 北の物語/u);
  guest.dispose();
});

test("series proposals edit the active legacy registry without discarding unknown fields", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const path = "meta/scriptorium/modules/story/v1/series.json";
  const content = JSON.stringify({ version: 1, series: [{ id: "series-old", name: "Old", bibleRepositoryId: 7, futureField: { keep: true } }], bindings: [{ repositoryId: 9, seriesId: "series-old", futureBindingField: 2 }], futureRootField: "keep" });
  const bytes = encode.encode(content);
  const revision = createHash("sha256").update(bytes).digest("hex");
  host.files.set(path, { content, bytes, revision });
  const result = request(host, { seriesId: "series-old", patch: { name: "Updated" }, expectedRegistryRevision: revision }, "knowledge.series.propose", "idem-series-update");
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const change = host.proposals[0]!;
  const operation = ((change.units as Array<Record<string, unknown>>)[0]!.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(operation.path, path);
  const next = JSON.parse(new TextDecoder().decode(Uint8Array.from(operation.content as number[]))) as Record<string, unknown>;
  assert.equal(next.futureRootField, "keep");
  const series = (next.series as Array<Record<string, unknown>>)[0]!;
  assert.equal(series.name, "Updated");
  assert.equal(series.updatedAt, "2026-10-26T00:00:00.000Z");
  assert.deepEqual(series.futureField, { keep: true });
  assert.deepEqual((next.bindings as Array<Record<string, unknown>>)[0], { repositoryId: 9, seriesId: "series-old", futureBindingField: 2 });
  guest.dispose();
});

test("series binding get returns the work binding source revision, including an absent binding", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const registry = "version: 1\nseries:\n  - id: north\n    name: North\n    bibleRepositoryId: 42\n";
  const bytes = encode.encode(registry);
  host.files.set("meta/proprium/plugins/proprium.knowledge/v1/series.yaml", {
    content: registry, bytes, revision: createHash("sha256").update(bytes).digest("hex"),
  });
  const result = request(host, {}, "knowledge.series.binding.get");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    binding: null, registryRevision: null, workSnapshot: host.snapshot, requiresAuthorReview: false,
  });
  guest.dispose();
});

test("series binding proposal pins registry and absent binding and preserves unknown binding fields", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const registry = "version: 1\nseries:\n  - id: north\n    name: North\n    bibleRepositoryId: 42\n";
  const registryBytes = encode.encode(registry);
  const registryPath = "meta/proprium/plugins/proprium.knowledge/v1/series.yaml";
  const registryRevision = createHash("sha256").update(registryBytes).digest("hex");
  host.files.set(registryPath, { content: registry, bytes: registryBytes, revision: registryRevision });
  const result = request(host, { seriesId: "north", expectedWorkRevision: null }, "knowledge.series.binding.propose", "idem-series-binding");
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const change = host.proposals[0]!;
  assert.ok((change.read_set as Array<Record<string, unknown>>).some((read) => read.path === registryPath && read.revision === registryRevision));
  const operation = ((change.units as Array<Record<string, unknown>>)[0]!.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(operation.path, "meta/proprium/plugins/proprium.knowledge/v1/series-binding.yaml");
  assert.equal(operation.expected_revision, null);
  assert.match(new TextDecoder().decode(Uint8Array.from(operation.content as number[])), /bibleRepositoryId: 42/u);
  guest.dispose();

  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const updateHost = new HostFixture();
  const oldBinding = "seriesId: north\nbibleRepositoryId: 42\nfutureBindingField:\n  keep: true\n";
  const bindingBytes = encode.encode(oldBinding);
  const bindingPath = "meta/proprium/plugins/proprium.knowledge/v1/series-binding.yaml";
  const bindingRevision = createHash("sha256").update(bindingBytes).digest("hex");
  updateHost.files.set(registryPath, { content: registry, bytes: registryBytes, revision: registryRevision });
  updateHost.files.set(bindingPath, { content: oldBinding, bytes: bindingBytes, revision: bindingRevision });
  const update = request(updateHost, { seriesId: "north", expectedWorkRevision: bindingRevision }, "knowledge.series.binding.propose", "idem-series-binding-update");
  assert.equal(update.ok, true, JSON.stringify(update.error));
  const updateChange = updateHost.proposals[0]!;
  const updateOperation = ((updateChange.units as Array<Record<string, unknown>>)[0]!.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(updateOperation.expected_revision, bindingRevision);
  assert.match(new TextDecoder().decode(Uint8Array.from(updateOperation.content as number[])), /futureBindingField:\n  keep: true/u);
  guest.dispose();
});

test("series binding proposal requires review for unresolved legacy project identity", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const path = "meta/scriptorium/modules/story/v1/series.json";
  const content = JSON.stringify({ version: 1, series: [{ id: "north", name: "North", bibleProjectId: "old-project" }], bindings: [] });
  const bytes = encode.encode(content);
  const revision = createHash("sha256").update(bytes).digest("hex");
  host.files.set(path, { content, bytes, revision });
  const result = request(host, { seriesId: "north", expectedWorkRevision: revision }, "knowledge.series.binding.propose");
  assert.equal(result.ok, false);
  assert.equal((result.error as Record<string, unknown>).code, "author_review_required");
  assert.deepEqual(host.proposals, []);
  guest.dispose();
});

test("series overlay reads the exact Host-selected local-only lease and preserves source provenance", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const binding = { seriesId: "north", futureBindingField: { keep: true } };
  const bindingPath = "meta/proprium/plugins/proprium.knowledge/v1/series-binding.yaml";
  const bindingContent = "seriesId: north\nfutureBindingField:\n  keep: true\n";
  const workSeries = "version: 1\nseries:\n  - id: north\n    name: North\n";
  const bibleSeries = "version: 1\nseries:\n  - id: north\n    name: North Bible\n";
  const put = (files: Map<string, { content: string; bytes: Uint8Array<ArrayBufferLike>; revision: string }>, path: string, content: string) => {
    const bytes = encode.encode(content);
    files.set(path, { content, bytes, revision: createHash("sha256").update(bytes).digest("hex") });
  };
  put(host.files, bindingPath, bindingContent);
  put(host.files, "meta/proprium/plugins/proprium.knowledge/v1/series.yaml", workSeries);
  put(host.files, "bible/characters/char-a.yaml", "id: char-a\ntype: character\nname: Work A\nrelations:\n  - target: char-b\n    kind: related\n    note: work\n");
  put(host.linkedFiles, "meta/proprium/plugins/proprium.knowledge/v1/series.yaml", bibleSeries);
  put(host.linkedFiles, "bible/characters/char-a.yaml", "id: char-a\ntype: character\nname: Bible A\nrelations:\n  - target: char-b\n    kind: related\n    note: bible\n");
  put(host.linkedFiles, "bible/characters/char-b.yaml", "id: char-b\ntype: character\nname: Bible B\nrelations:\n  - target: char-missing\n    kind: related\n");
  put(host.linkedFiles, "bible/locations/duplicate-a.yaml", "id: loc-duplicate\ntype: location\nname: Duplicate A\n");
  put(host.linkedFiles, "bible/locations/duplicate-b.yaml", "id: loc-duplicate\ntype: location\nname: Duplicate B\n");
  host.preferenceKey = seriesBindingPreferenceKey(binding);
  host.preferenceValue = { workspace_id: "bible-workspace", repository_id: null, branch: "main", snapshot_id: host.linkedSnapshot.id };

  const result = request(host, {}, "knowledge.series.overlay");
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const value = result.value as Record<string, unknown>;
  assert.deepEqual(value.workSnapshot, host.snapshot);
  assert.deepEqual(value.bibleSnapshot, host.linkedSnapshot);
  assert.deepEqual(value.binding, binding);
  const entities = value.entities as Array<Record<string, unknown>>;
  const charA = entities.find((item) => item.id === "char-a")!;
  assert.equal((charA.display as Record<string, unknown>).name, "Work A");
  assert.equal(charA.preferredSource, "work");
  assert.deepEqual((charA.sourceRecords as Array<Record<string, unknown>>).map((record) => record.source), ["bible", "work"]);
  assert.ok(entities.some((item) => item.id === "char-b"));
  const links = value.links as Array<Record<string, unknown>>;
  const shared = links.find((link) => link.from === "char-a" && link.to === "char-b")!;
  assert.equal((shared.sourceRecords as Array<Record<string, unknown>>).length, 2);
  const broken = value.brokenReferences as Array<Record<string, unknown>>;
  assert.equal(broken.length, 1);
  assert.equal(broken[0]?.targetId, "char-missing");
  const conflicts = value.conflicts as Array<Record<string, unknown>>;
  assert.ok(conflicts.some((item) => item.kind === "duplicate_id" && item.source === "bible" && item.entityId === "loc-duplicate"));
  assert.ok(host.operations.includes("workspace.repository.snapshot.read"));
  guest.dispose();
});

test("series overlay returns a typed unavailable error instead of a fake empty view when unselected", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const bindingContent = "seriesId: north\n";
  const bytes = encode.encode(bindingContent);
  host.files.set("meta/proprium/plugins/proprium.knowledge/v1/series-binding.yaml", {
    content: bindingContent, bytes, revision: createHash("sha256").update(bytes).digest("hex"),
  });
  const result = request(host, {}, "knowledge.series.overlay");
  assert.equal(result.ok, false);
  assert.equal((result.error as Record<string, unknown>).code, "repository_not_active");
  assert.equal(host.operations.includes("workspace.repository.snapshot.read"), false);
  guest.dispose();
});

test("series overlay refuses a stale Host lease before reading foreign repository files", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const binding = { seriesId: "north" };
  const content = "seriesId: north\n";
  const bytes = encode.encode(content);
  host.files.set("meta/proprium/plugins/proprium.knowledge/v1/series-binding.yaml", {
    content, bytes, revision: createHash("sha256").update(bytes).digest("hex"),
  });
  host.preferenceKey = seriesBindingPreferenceKey(binding);
  host.preferenceValue = { workspace_id: "bible-workspace", repository_id: null, branch: "main", snapshot_id: "snapshot-bible-stale" };
  const result = request(host, {}, "knowledge.series.overlay");
  assert.equal(result.ok, false);
  assert.equal((result.error as Record<string, unknown>).code, "snapshot_stale");
  assert.ok(host.operations.includes("workspace.repository.snapshot.read"));
  assert.equal(host.fileSnapshots.includes("snapshot-bible-stale"), false);
  guest.dispose();
});

test("series overlay will not use a Host source whose stable repository ID differs from the Git binding", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const binding = { seriesId: "north", bibleRepositoryId: 42 };
  const content = "seriesId: north\nbibleRepositoryId: 42\n";
  const bytes = encode.encode(content);
  host.files.set("meta/proprium/plugins/proprium.knowledge/v1/series-binding.yaml", {
    content, bytes, revision: createHash("sha256").update(bytes).digest("hex"),
  });
  host.preferenceKey = seriesBindingPreferenceKey(binding);
  host.preferenceValue = { workspace_id: "wrong-bible", repository_id: 99, branch: "main", snapshot_id: host.linkedSnapshot.id };
  const result = request(host, {}, "knowledge.series.overlay");
  assert.equal(result.ok, false);
  assert.equal((result.error as Record<string, unknown>).code, "conflict");
  assert.equal(host.operations.includes("workspace.repository.snapshot.read"), false);
  guest.dispose();
});

test("state proposal creation verifies exact manuscript evidence and proposes an unconfirmed Git row", () => {
  const host = new HostFixture();
  const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
  const sceneContent = "id: scene-1\ntype: scene\nchapter: ch-1\norder: 1\npov: char-a\nlocation: loc-a\nappears: [char-a]\nmanuscript: manuscript/s1.md\n";
  const sceneBytes = encode.encode(sceneContent);
  host.files.set(scenePath, { content: sceneContent, bytes: sceneBytes, revision: createHash("sha256").update(sceneBytes).digest("hex") });
  const manuscriptContent = "---\ntitle: Scene one\n---\nLantern saw the Harbor.\n";
  const manuscriptBytes = encode.encode(manuscriptContent);
  host.files.set("manuscript/s1.md", { content: manuscriptContent, bytes: manuscriptBytes, revision: createHash("sha256").update(manuscriptBytes).digest("hex") });
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const sceneRevision = host.files.get(scenePath)!.revision;
  const body = "Lantern saw the Harbor.\n";
  const result = request(host, {
    sceneId: "scene-1", expectedSceneRevision: sceneRevision, manuscriptHash: createHash("sha256").update(body).digest("hex"),
    event: { kind: "location", subject: "char-a", object: "loc-a", payload: { confidence: "author-confirmation" }, evidence: [{ sceneId: "scene-1", excerpt: "Lantern saw the Harbor." }] },
  }, "knowledge.state-proposals.create", "idem-state-1");
  assert.equal(result.ok, true);
  assert.equal((result.value as Record<string, unknown>).proposalId, "proposal-1");
  const change = host.proposals[0]!;
  const unit = (change.units as Array<Record<string, unknown>>)[0]!;
  const operation = (unit.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(operation.path, "meta/proprium/plugins/proprium.knowledge/v1/state-proposals.jsonl");
  assert.equal(operation.kind, "create");
  const proposal = JSON.parse(new TextDecoder().decode(Uint8Array.from(operation.content as number[]))) as Record<string, unknown>;
  const event = proposal.event as Record<string, unknown>;
  assert.equal(event.status, "proposed");
  assert.equal(event.source, "manual-draft");
  assert.equal(event.eventId && typeof event.eventId, "string");
  assert.ok((change.read_set as Array<Record<string, unknown>>).some((item) => item.path === "manuscript/s1.md"));
  guest.dispose();
});

test("suggestion acceptance proposes notes and Git review status together under exact source revisions", () => {
  const host = new HostFixture();
  const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
  const sceneContent = "id: scene-1\ntype: scene\nchapter: ch-1\norder: 1\npov: char-a\nlocation: loc-a\nappears: [char-a]\nmanuscript: manuscript/s1.md\n";
  const sceneBytes = encode.encode(sceneContent);
  host.files.set(scenePath, { content: sceneContent, bytes: sceneBytes, revision: createHash("sha256").update(sceneBytes).digest("hex") });
  const manuscriptContent = "---\ntitle: Scene one\n---\nLantern protects the harbor.\n";
  const manuscriptBytes = encode.encode(manuscriptContent);
  host.files.set("manuscript/s1.md", { content: manuscriptContent, bytes: manuscriptBytes, revision: createHash("sha256").update(manuscriptBytes).digest("hex") });
  const entityRevision = host.files.get("bible/characters/char-a.yaml")!.revision;
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const created = request(host, {
    entityId: "char-a", blockPath: "lead.0", proposedText: "protects the harbor", evidence: [{ quote: "Lantern protects the harbor.", sceneId: "scene-1" }],
    source: "manuscript", sourceId: "scene-1", sourceRevision: host.files.get("manuscript/s1.md")!.revision, kind: "fact", confidence: "high", expectedEntityRevision: entityRevision,
  }, "knowledge.suggestions.create", "idem-suggestion-create");
  assert.equal(created.ok, true);
  const createOperation = ((host.proposals[0]!.units as Array<Record<string, unknown>>)[0]!.operations as Array<Record<string, unknown>>)[0]!;
  const suggestionPath = String(createOperation.path);
  const storedContent = new TextDecoder().decode(Uint8Array.from(createOperation.content as number[]));
  const storedBytes = encode.encode(storedContent);
  host.files.set(suggestionPath, { content: storedContent, bytes: storedBytes, revision: createHash("sha256").update(storedBytes).digest("hex") });
  guest.dispose();

  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const accepted = request(host, {
    id: (created.value as Record<string, unknown>).suggestionId,
    decision: "accept", expectedSuggestionRevision: host.files.get(suggestionPath)!.revision,
    expectedEntityRevision: entityRevision,
  }, "knowledge.suggestions.decide", "idem-suggestion-accept");
  assert.equal(accepted.ok, true);
  const acceptance = host.proposals[1]!;
  const writes = ((acceptance.units as Array<Record<string, unknown>>)[0]!.operations as Array<Record<string, unknown>>);
  assert.deepEqual(new Set(writes.map((operation) => operation.path)), new Set(["bible/characters/char-a.yaml", suggestionPath]));
  const notesWrite = writes.find((operation) => operation.path === "bible/characters/char-a.yaml")!;
  const notesContent = new TextDecoder().decode(Uint8Array.from(notesWrite.content as number[]));
  assert.match(notesContent, /protects the harbor/u);
  const statusWrite = writes.find((operation) => operation.path === suggestionPath)!;
  const row = JSON.parse(new TextDecoder().decode(Uint8Array.from(statusWrite.content as number[]))) as Record<string, unknown>;
  assert.equal(row.status, "approved");
  guest.dispose();
});

test("Knowledge change compiler emits pure revision-guarded generic units without proposing", () => {
  const host = new HostFixture();
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const revision = host.files.get("bible/characters/char-a.yaml")!.revision;
  const result = request(host, {
    operations: [{ id: "op-update-char-a", evidenceIds: [], assessment: { confidence: 0.9, risk: "low" }, kind: "entity.update",
      precondition: { kind: "revision", value: revision }, target: { entityId: "char-a" }, changes: { name: "Lantern Keeper" } }],
    evidence: [],
  }, "proprium.knowledge.changes.compile");
  assert.equal(result.ok, true);
  assert.equal(host.proposals.length, 0);
  const value = result.value as { read_set: Array<Record<string, unknown>>; units: Array<Record<string, unknown>>; operation_map: Array<Record<string, unknown>>; diagnostics: unknown[] };
  assert.deepEqual(value.diagnostics, []);
  assert.ok(value.read_set.some((item) => item.path === "bible/characters/char-a.yaml" && item.revision === revision));
  assert.equal(value.units.length, 1);
  const unit = value.units[0]!;
  assert.deepEqual(unit.source_operation_ids, ["op-update-char-a"]);
  const operation = (unit.operations as Array<Record<string, unknown>>)[0]!;
  assert.equal(operation.kind, "replace");
  assert.equal(operation.expected_revision, revision);
  assert.equal((value.operation_map[0] as Record<string, unknown>).source_operation_id, "op-update-char-a");
  assert.match(new TextDecoder().decode(Uint8Array.from(operation.content as number[])), /name: Lantern Keeper/u);
  guest.dispose();
});

test("Knowledge compiler validates a Host staged view but binds the emitted write to the original base revision", () => {
  const host = new HostFixture();
  const path = "bible/characters/char-a.yaml";
  const baseFile = host.files.get(path)!;
  const stagedContent = `${baseFile.content}stagedUnknownKey: retained\n`;
  const stagedBytes = encode.encode(stagedContent);
  const stagedRevision = createHash("sha256").update(stagedBytes).digest("hex");
  host.stagedFiles.set(path, { content: stagedContent, bytes: stagedBytes, revision: stagedRevision });
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const result = request(host, {
    staging_snapshot: "stage-1",
    operations: [{ id: "op-staged-update", evidenceIds: [], assessment: { confidence: 0.7, risk: "medium" }, kind: "entity.update",
      precondition: { kind: "revision", value: stagedRevision }, target: { entityId: "char-a" }, changes: { name: "Staged Name" } }], evidence: [],
  }, "proprium.knowledge.changes.compile");
  assert.equal(result.ok, true);
  const value = result.value as { read_set: Array<Record<string, unknown>>; units: Array<Record<string, unknown>> };
  assert.ok(value.read_set.some((item) => item.path === path && item.revision === baseFile.revision));
  const operation = ((value.units[0]!.operations as Array<Record<string, unknown>>)[0]!);
  assert.equal(operation.expected_revision, baseFile.revision);
  const output = new TextDecoder().decode(Uint8Array.from(operation.content as number[]));
  assert.match(output, /stagedUnknownKey: retained/u);
  assert.match(output, /name: Staged Name/u);
  guest.dispose();
});

test("Knowledge compiler checks active legacy state proposals against manuscript body hashes and confirmed event identity", () => {
  const host = new HostFixture();
  const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
  const sceneContent = "id: scene-1\ntype: scene\nchapter: ch-1\norder: 1\npov: char-a\nlocation: loc-a\nappears: [char-a]\nmanuscript: manuscript/s1.md\n";
  const sceneBytes = encode.encode(sceneContent);
  host.files.set(scenePath, { content: sceneContent, bytes: sceneBytes, revision: createHash("sha256").update(sceneBytes).digest("hex") });
  const manuscriptContent = "---\ntitle: Scene one\n---\nLantern saw the Harbor.\n";
  const manuscriptBytes = encode.encode(manuscriptContent);
  host.files.set("manuscript/s1.md", { content: manuscriptContent, bytes: manuscriptBytes, revision: createHash("sha256").update(manuscriptBytes).digest("hex") });
  const bodyHash = createHash("sha256").update("Lantern saw the Harbor.\n").digest("hex");
  const proposed = {
    sceneId: "scene-1", order: 1, kind: "location", subject: "char-a", object: "loc-a", payload: { certainty: "observed" },
    source: "manual-draft", eventId: "event-proposal-a", status: "proposed", evidence: [{ sceneId: "scene-1", excerpt: "Lantern saw the Harbor." }],
    createdAt: "2026-10-25T00:00:00.000Z",
  };
  const metadataPath = "meta/scriptorium/modules/story/state-proposals.jsonl";
  const metadataContent = `${JSON.stringify({ id: "state-a", event: proposed, manuscriptHash: bodyHash, status: "proposed", conflictEventIds: [], duplicateOfProposalId: null, history: [] })}\n`;
  const metadataBytes = encode.encode(metadataContent);
  host.files.set(metadataPath, { content: metadataContent, bytes: metadataBytes, revision: createHash("sha256").update(metadataBytes).digest("hex") });
  const sceneRevision = host.files.get(scenePath)!.revision;
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const event = { ...proposed, source: "manual", status: "confirmed" };
  const result = request(host, {
    operations: [{ id: "confirm-state-a", evidenceIds: [], assessment: { confidence: 1, risk: "low" }, kind: "state.append-event",
      precondition: { kind: "revision", value: sceneRevision }, target: { sceneId: "scene-1", eventId: "event-proposal-a" },
      event, sourceProposal: { id: "state-a", manuscriptHash: bodyHash } }], evidence: [],
  }, "proprium.knowledge.changes.compile");
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const value = result.value as { read_set: Array<Record<string, unknown>>; units: Array<Record<string, unknown>> };
  assert.ok(value.read_set.some((item) => item.path === metadataPath));
  assert.ok(value.read_set.some((item) => item.path === "manuscript/s1.md"));
  const content = new TextDecoder().decode(Uint8Array.from((value.units[0]!.operations as Array<Record<string, unknown>>)[0]!.content as number[]));
  assert.match(content, /status: confirmed/u);
  guest.dispose();
});

test("Knowledge compiler rejects a state proposal with changed event meaning", () => {
  const host = new HostFixture();
  const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
  const sceneContent = "id: scene-1\ntype: scene\nchapter: ch-1\norder: 1\nlocation: loc-a\nmanuscript: manuscript/s1.md\n";
  const sceneBytes = encode.encode(sceneContent);
  host.files.set(scenePath, { content: sceneContent, bytes: sceneBytes, revision: createHash("sha256").update(sceneBytes).digest("hex") });
  const manuscriptContent = "---\ntitle: Scene one\n---\nBody.\n";
  const manuscriptBytes = encode.encode(manuscriptContent);
  host.files.set("manuscript/s1.md", { content: manuscriptContent, bytes: manuscriptBytes, revision: createHash("sha256").update(manuscriptBytes).digest("hex") });
  const bodyHash = createHash("sha256").update("Body.\n").digest("hex");
  const proposed = { sceneId: "scene-1", order: 1, kind: "location", subject: "char-a", object: "loc-a", payload: {}, source: "manual-draft", eventId: "event-a", status: "proposed" };
  const metadataPath = "meta/scriptorium/modules/story/state-proposals.jsonl";
  const metadataContent = `${JSON.stringify({ id: "state-a", event: proposed, manuscriptHash: bodyHash, status: "proposed", conflictEventIds: [], duplicateOfProposalId: null })}\n`;
  const metadataBytes = encode.encode(metadataContent);
  host.files.set(metadataPath, { content: metadataContent, bytes: metadataBytes, revision: createHash("sha256").update(metadataBytes).digest("hex") });
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const result = request(host, {
    operations: [{ id: "confirm-state-a", evidenceIds: [], assessment: { confidence: 1, risk: "low" }, kind: "state.append-event",
      precondition: { kind: "revision", value: host.files.get(scenePath)!.revision }, target: { sceneId: "scene-1", eventId: "event-a" },
      event: { ...proposed, payload: { changed: true }, source: "manual", status: "confirmed" }, sourceProposal: { id: "state-a", manuscriptHash: bodyHash } }], evidence: [],
  }, "proprium.knowledge.changes.compile");
  assert.equal(result.ok, false);
  assert.equal((result.error as Record<string, unknown>).code, "snapshot_stale");
  guest.dispose();
});

test("reader projections use only current approved scene summary state changes", () => {
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  const host = new HostFixture();
  const put = (path: string, content: string) => { const bytes = encode.encode(content); host.files.set(path, { content, bytes, revision: createHash("sha256").update(bytes).digest("hex") }); };
  const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml", manuscript = "manuscript/v1/c1/s1.md", summaryPath = "plot/volumes/v1/chapters/c1/scene-summaries/scene-1.yaml";
  put(scenePath, inputFiles[scenePath] + `manuscript: ${manuscript}\n`);
  put(manuscript, "---\ntitle: scene\n---\n静かな朝。\n");
  put("bible/items/item-crown.yaml", "id: item-crown\nname: 王冠\n");
  const summary = { sceneId: "scene-1", summaryLines: ["一", "二", "三"], characters: [], stateChanges: ["王冠を隠した。"], sourceHash: host.files.get(manuscript)!.revision, promptVersion: "scene-summary@3", model: "model", knowledge_available: false, source_files: [{ path: scenePath, revision: host.files.get(scenePath)!.revision }, { path: manuscript, revision: host.files.get(manuscript)!.revision }], context_files: [] };
  put(summaryPath, JSON.stringify(summary));
  for (const [action, input, property] of [["knowledge.world-state.at-scene", { sceneId: "scene-1" }, "readerDisclosures"], ["knowledge.reader-model.build", { chapterId: "ch-1" }, "disclosures"]] as const) {
    const result = request(host, input, action);
    assert.equal(result.ok, true, JSON.stringify(result));
    const value = result.value as Record<string, unknown>;
    assert.ok((value[property] as Array<Record<string, unknown>>).some((event) => event.entityId === "item-crown" && event.source === "scene_summary"));
    assert.ok((value.sourceFiles as Array<Record<string, unknown>>).some((source) => source.path === summaryPath && source.revision === host.files.get(summaryPath)!.revision));
    assert.deepEqual(value.summaryDiagnostics, []);
  }
  guest.dispose();
  guest.initialize({ pluginId: "proprium.knowledge", version: "0.1.0", workspaceId: "workspace-1" });
  put(summaryPath, JSON.stringify({ ...summary, sourceHash: "stale" }));
  const stale = request(host, { chapterId: "ch-1" }, "knowledge.reader-model.build");
  assert.equal(stale.ok, true, JSON.stringify(stale));
  const value = stale.value as Record<string, unknown>;
  assert.ok(!(value.disclosures as Array<Record<string, unknown>>).some((event) => event.entityId === "item-crown"));
  assert.deepEqual(value.summaryDiagnostics, [{ sceneId: "scene-1", path: summaryPath, code: "stale_summary" }]);
  guest.dispose();
});
