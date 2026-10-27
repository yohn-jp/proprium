import assert from "node:assert/strict";
import test from "node:test";
import type { AppliedWorkspaceChange, FileRevisionExpectation, WorkspaceChange } from "../git/index.js";
import {
  ChangeWriter,
  ChangeWriterError,
  type ChangeSet,
  type WriterJournalStore,
  type WriterScope,
  type WriterSnapshot,
  type WriterState,
  type WriterWorkspacePort,
} from "./writer.js";

const scope: WriterScope = Object.freeze({ workspace_id: "workspace-123", repository_id: 17, branch: "main", generation: "generation-1" });
const snapshot: WriterSnapshot = Object.freeze({ id: "snapshot-1", local_commit: null, worktree_generation: "tree-1", draft_generation: null });
const empty: WriterState = Object.freeze({ sequence: 0, proposals: Object.freeze({}), idempotency: Object.freeze({}), timestamps: Object.freeze({}), write_ahead: null, events: Object.freeze([]) });

class MemoryJournal implements WriterJournalStore {
  private state: WriterState = empty;
  async transact<T>(_scope: WriterScope, update: (current: WriterState) => { next: WriterState; value: T }): Promise<T> {
    const result = update(this.state);
    this.state = result.next;
    return result.value;
  }
  async read(_scope: WriterScope): Promise<WriterState> { return this.state; }
}

class MemoryWriterWorkspace implements WriterWorkspacePort {
  private readonly files = new Map<string, Uint8Array>();
  private latest = snapshot;
  private nextSnapshot = 1;
  private locked: Promise<void> = Promise.resolve();
  private dirty = false;
  private failAfterMutation: number | null = null;
  foreignStale = false;
  blocked = false;

  async with_exclusive_writer<T>(_scope: WriterScope, operation: () => Promise<T>): Promise<T> {
    const prior = this.locked;
    let release!: () => void;
    this.locked = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }
  async assert_current(_scope: WriterScope, current: WriterSnapshot): Promise<void> {
    if (this.dirty) throw Object.assign(new Error("An editor draft is dirty."), { code: "dirty_draft" });
    if (current.id !== this.latest.id || current.worktree_generation !== this.latest.worktree_generation) throw Object.assign(new Error("Workspace snapshot changed."), { code: "snapshot_stale" });
  }
  async assert_snapshot(_scope: WriterScope, current: WriterSnapshot): Promise<void> {
    if (current.id !== this.latest.id || current.worktree_generation !== this.latest.worktree_generation) throw Object.assign(new Error("Workspace snapshot changed."), { code: "snapshot_stale" });
  }
  async assert_read_set(_scope: WriterScope, _snapshot: WriterSnapshot, reads: ChangeSet["read_set"]): Promise<void> {
    if (this.foreignStale && reads.some(read => read.scope !== undefined)) throw Object.assign(new Error("Foreign source lease changed."), { code: "snapshot_stale" });
    for (const read of reads) if (read.scope === undefined && (await this.read(scope, read.path)).revision !== read.revision) {
      throw Object.assign(new Error(`Read dependency changed: ${read.path}`), { code: "snapshot_stale" });
    }
  }
  async read(_scope: WriterScope, path: string): Promise<{ bytes: Uint8Array | null; revision: string | null; storage_revision: string | null }> {
    const bytes = this.files.get(path);
    const copy = bytes ? Uint8Array.from(bytes) : null;
    const revision = copy ? await sha(copy) : null;
    return { bytes: copy, revision, storage_revision: revision };
  }
  async apply_changes(_scope: WriterScope, changes: readonly WorkspaceChange[], readSet: readonly FileRevisionExpectation[], _expectedSnapshot: WriterSnapshot): Promise<readonly AppliedWorkspaceChange[]> {
    for (const expected of readSet) {
      const current = await this.read(scope, expected.path);
      if (current.storage_revision !== expected.revision.oid) throw Object.assign(new Error(`Revision conflict for ${expected.path}.`), { code: "revision_conflict" });
    }
    for (const change of changes) {
      const current = await this.read(scope, change.path);
      if (current.storage_revision !== change.expectedRevision.oid) throw Object.assign(new Error(`Revision conflict for ${change.path}.`), { code: "revision_conflict" });
    }
    const results: AppliedWorkspaceChange[] = [];
    let mutationCount = 0;
    for (const change of changes) {
      if (change.content === null) this.files.delete(change.path);
      else this.files.set(change.path, Uint8Array.from(change.content));
      mutationCount += 1;
      const after = await this.read(scope, change.path);
      results.push({ path: change.path, revision: { oid: after.storage_revision } });
      if (this.failAfterMutation === mutationCount) {
        this.failAfterMutation = null;
        this.bump();
        throw Object.assign(new Error("The write result was lost."), { code: "storage_unknown" });
      }
    }
    if (changes.length) this.bump();
    return results;
  }
  async current_snapshot(_scope: WriterScope): Promise<WriterSnapshot> { return this.latest; }
  async block_writes(_scope: WriterScope): Promise<void> { this.blocked = true; }
  async unblock_writes(_scope: WriterScope): Promise<void> { this.blocked = false; }
  async verify_storage(_scope: WriterScope): Promise<void> { /* Test adapter retains exact bytes and verifies hashes on read. */ }
  seed(path: string, value: string): void { this.files.set(path, new TextEncoder().encode(value)); this.bump(); }
  text(path: string): string | null { const bytes = this.files.get(path); return bytes ? new TextDecoder().decode(bytes) : null; }
  makeDirty(): void { this.dirty = true; }
  failAfter(count: number): void { this.failAfterMutation = count; }
  private bump(): void {
    this.nextSnapshot += 1;
    this.latest = Object.freeze({ ...this.latest, id: `snapshot-${this.nextSnapshot}`, worktree_generation: `tree-${this.nextSnapshot}` });
  }
}

function changeSet(input: { readonly units?: ChangeSet["units"]; readonly paths?: readonly string[]; readonly key?: string } = {}): ChangeSet {
  const key = input.key ?? "request-1";
  const paths = input.paths ?? ["chapters/one.md"];
  const operations = paths.map((path, index) => ({
    id: `operation-${index + 1}`,
    kind: "create" as const,
    path,
    expected_revision: null,
    content: new TextEncoder().encode(`content ${index + 1}`),
  }));
  const units = input.units ?? [{ id: "unit-1", label: "Create scene files", depends_on: [], operations }];
  return {
    id: "guest-chosen-id",
    idempotency_key: key,
    scope,
    snapshot,
    title: "Create scenes",
    reason: "The author requested these files.",
    read_set: paths.map(path => ({ path, revision: null })),
    units,
    evidence: [],
  };
}

function caller(key = "request-1", digest = "a".repeat(64)) {
  return { caller: "plugin" as const, producer_plugin_id: "proprium.narrative", action_id: "proprium.narrative.structure.create", scope, idempotency_key: key, source_payload: new TextEncoder().encode(JSON.stringify({ idempotency_key: key })), request_digest: digest };
}

const allowedActions = new Set([
  "proprium.narrative:proprium.narrative.structure.create",
  "proprium.research:proprium.research.terms.propose",
  "proprium.knowledge:proprium.knowledge.state.append-event",
  "proprium.knowledge:knowledge.entities.update",
]);
async function allowTestAction(pluginId: string, actionId: string): Promise<void> {
  if (!allowedActions.has(`${pluginId}:${actionId}`)) throw new ChangeWriterError("capability_denied", "The verified manifest does not own this action.");
}

async function makeWriter(workspace = new MemoryWriterWorkspace(), journal = new MemoryJournal()) {
  let proposal = 0;
  const writer = new ChangeWriter({ journal, workspace, new_proposal_id: () => `host-proposal-${++proposal}`, assert_action: allowTestAction });
  return { writer, workspace, journal };
}

async function sha(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

test("verified signed action ownership accepts non-prefixed IDs and rejects cross-plugin IDs", async () => {
  const { writer } = await makeWriter();
  const set = changeSet({ key: "knowledge-action" });
  const accepted = { ...caller("knowledge-action"), producer_plugin_id: "proprium.knowledge", action_id: "knowledge.entities.update" };
  assert.equal((await writer.propose(set, accepted, set.read_set)).status, "proposed");
  const rejected = changeSet({ key: "cross-plugin-action" });
  const spoof = { ...caller("cross-plugin-action"), producer_plugin_id: "proprium.knowledge", action_id: "research.terms.propose" };
  await assert.rejects(writer.propose(rejected, spoof, rejected.read_set),
    (error: unknown) => error instanceof ChangeWriterError && error.code === "capability_denied");
  await assert.rejects(writer.timestamp(scope, "proprium.knowledge", "research.terms.propose", "unknown-action"),
    (error: unknown) => error instanceof ChangeWriterError && error.code === "capability_denied");
});

test("proposal admission persists a Host ID and returns the same receipt for an idempotent retry", async () => {
  const { writer } = await makeWriter();
  const set = changeSet();
  const first = await writer.propose(set, caller(), set.read_set);
  const retry = await writer.propose(set, caller(), set.read_set);
  assert.equal(first.proposal_id, "host-proposal-1");
  assert.equal(retry.proposal_id, first.proposal_id);
  assert.equal((await writer.list(scope)).items.length, 1);
  assert.equal((await writer.events(scope, first.proposal_id))[0]?.kind, "submitted");
});

test("lost proposal response is recovered from the journal even after its temporary artifact is gone", async () => {
  const workspace = new MemoryWriterWorkspace();
  const journal = new MemoryJournal();
  let artifactAvailable = true;
  const writer = new ChangeWriter({
    workspace,
    journal,
    new_proposal_id: () => "host-artifact-proposal",
    assert_action: allowTestAction,
    resolve_artifact: async () => {
      if (!artifactAvailable) throw new ChangeWriterError("dependency_unavailable", "Temporary artifact lease expired.");
      return new TextEncoder().encode("sealed bytes");
    },
  });
  const set = changeSet();
  const unit = set.units[0]!;
  const operation = unit.operations[0]!;
  const artifactSet: ChangeSet = { ...set, idempotency_key: "artifact", units: [{ ...unit, operations: [{
    id: operation.id,
    kind: operation.kind,
    path: operation.path,
    expected_revision: operation.expected_revision,
    content_artifact: "sealed-artifact-1",
  }] }] };
  const first = await writer.propose(artifactSet, caller("artifact"), artifactSet.read_set);
  artifactAvailable = false;
  const retry = await writer.propose(artifactSet, caller("artifact"), artifactSet.read_set);
  assert.equal(retry.proposal_id, first.proposal_id);
  const content = await writer.read_content(scope, first.proposal_id, "content:unit-1:operation-1");
  assert.equal(new TextDecoder().decode(content.bytes), "sealed bytes");
});

test("proposal receipt takes exact sealed bytes before the ArtifactBroker marks them receipt-owned", async t => {
  let brokerModule: {
    readonly ArtifactBroker: new (store: unknown) => {
      create(pluginId: string, input: { media_type: string; filename: string; scope: WriterScope; snapshot: WriterSnapshot }): Promise<{ artifact_id: string }>;
      append(pluginId: string, artifactId: string, sequence: number, bytes: readonly number[]): Promise<unknown>;
      seal(pluginId: string, artifactId: string, digest: string, totalBytes: number): Promise<{ total_bytes: number; sha256: string }>;
      hostMetadata(pluginId: string, artifactId: string, scope: WriterScope, snapshot: WriterSnapshot): Promise<{ total_bytes: number; sha256: string }>;
      readSealedChunk(pluginId: string, artifactId: string, offset: number, length: number): Promise<{ bytes: Uint8Array; total_bytes: number; sha256: string }>;
      retainForProposal(pluginId: string, artifactId: string, proposalId: string): Promise<void>;
      releaseTemporary(pluginId: string): Promise<void>;
      discard(pluginId: string, artifactId: string): Promise<{ discarded: boolean }>;
    };
    readonly MemoryBrokerStore: new () => unknown;
  };
  try {
    const moduleName: string = "./brokers.js";
    brokerModule = await import(moduleName) as typeof brokerModule;
  } catch { t.skip("The canonical ArtifactBroker is supplied by the Host broker lane."); return; }

  const pluginId = "proprium.research";
  const broker = new brokerModule.ArtifactBroker(new brokerModule.MemoryBrokerStore());
  const raw = new Uint8Array(300 * 1024);
  for (let index = 0; index < raw.byteLength; index += 1) raw[index] = index % 251;
  const metadata = await broker.create(pluginId, { media_type: "application/json", filename: "terms.json", scope, snapshot });
  const firstChunk = raw.subarray(0, 256 * 1024);
  const secondChunk = raw.subarray(firstChunk.byteLength);
  await broker.append(pluginId, metadata.artifact_id, 0, [...firstChunk]);
  await broker.append(pluginId, metadata.artifact_id, 1, [...secondChunk]);
  const digest = await sha(raw);
  const sealed = await broker.seal(pluginId, metadata.artifact_id, digest, raw.byteLength);
  assert.equal(sealed.sha256, digest);

  const workspace = new MemoryWriterWorkspace();
  const journal = new MemoryJournal();
  const writer = new ChangeWriter({
    workspace,
    journal,
    new_proposal_id: () => "host-broker-proposal",
    assert_action: allowTestAction,
    resolve_artifact: async (requestedScope, requestedSnapshot, artifactId, ownerPluginId) => {
      assert.equal(ownerPluginId, pluginId);
      const artifact = await broker.hostMetadata(ownerPluginId, artifactId, requestedScope, requestedSnapshot);
      const bytes = new Uint8Array(artifact.total_bytes);
      for (let offset = 0; offset < bytes.byteLength;) {
        const chunk = await broker.readSealedChunk(ownerPluginId, artifactId, offset, Math.min(256 * 1024, bytes.byteLength - offset));
        assert.equal(chunk.total_bytes, bytes.byteLength);
        assert.equal(chunk.sha256, artifact.sha256);
        bytes.set(chunk.bytes, offset);
        offset += chunk.bytes.byteLength;
      }
      assert.equal(await sha(bytes), artifact.sha256);
      return bytes;
    },
  });
  const set = changeSet({ key: "broker-transfer" });
  const unit = set.units[0]!;
  const operation = unit.operations[0]!;
  const artifactSet: ChangeSet = {
    ...set,
    units: [{ ...unit, operations: [{
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      expected_revision: operation.expected_revision,
      content_artifact: metadata.artifact_id,
    }] }],
  };
  const producer = {
    ...caller("broker-transfer"),
    producer_plugin_id: pluginId,
    action_id: "proprium.research.terms.propose",
  };
  const admission = await writer.propose(artifactSet, producer, artifactSet.read_set);
  // This is the Host service's post-admission ownership handoff. The proposal journal already has all exact bytes.
  await broker.retainForProposal(pluginId, metadata.artifact_id, admission.proposal_id);
  await broker.releaseTemporary(pluginId);
  assert.deepEqual(await broker.discard(pluginId, metadata.artifact_id), { discarded: false });

  const persisted = await writer.read_content(scope, admission.proposal_id, "content:unit-1:operation-1", 0, 256 * 1024);
  const persistedTail = await writer.read_content(scope, admission.proposal_id, "content:unit-1:operation-1", persisted.next_offset!, 256 * 1024);
  const joined = new Uint8Array(persisted.bytes.byteLength + persistedTail.bytes.byteLength);
  joined.set(persisted.bytes); joined.set(persistedTail.bytes, persisted.bytes.byteLength);
  assert.deepEqual(joined, raw);
  assert.equal(persisted.sha256, digest);
  assert.equal((await writer.apply(scope, admission.proposal_id, ["unit-1"], "ui", true)).status, "applied");
  assert.deepEqual((await workspace.read(scope, "chapters/one.md")).bytes, raw);
});

test("proposal preview and receipt retain the exact source payload and domain evidence", async () => {
  const { writer } = await makeWriter();
  const payload = { z: 1, a: "source" };
  const payloadDigest = await sha(new TextEncoder().encode('{"a":"source","z":1}'));
  const set: ChangeSet = {
    ...changeSet(),
    source_payload: payload,
    source_payload_digest: payloadDigest,
    domain_evidence: [{ provider: "paired-writing", source_id: "source-7", quotation: "exact" }],
  };
  const proposal = await writer.propose(set, caller(), set.read_set);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.preview.source_payload_digest, payloadDigest);
  assert.deepEqual(proposal.preview.domain_evidence, set.domain_evidence);
  assert.ok(proposal.preview.units[0]!.operations[0]!.content_ref);
});

test("Host timestamp persists before return and stays stable for the action idempotency key", async () => {
  const workspace = new MemoryWriterWorkspace();
  const journal = new MemoryJournal();
  let call = 0;
  const writer = new ChangeWriter({ workspace, journal, new_proposal_id: () => "unused", assert_action: allowTestAction, now: () => `2026-01-01T00:00:0${++call}.000Z` });
  const first = await writer.timestamp(scope, "proprium.knowledge", "proprium.knowledge.state.append-event", "stable-request");
  const retry = await writer.timestamp(scope, "proprium.knowledge", "proprium.knowledge.state.append-event", "stable-request");
  const next = await writer.timestamp(scope, "proprium.knowledge", "proprium.knowledge.state.append-event", "next-request");
  assert.equal(retry.timestamp, first.timestamp);
  assert.notEqual(next.timestamp, first.timestamp);
});

test("idempotency rejects a changed request and read transcript must exactly match", async () => {
  const { writer } = await makeWriter();
  const set = changeSet();
  await writer.propose(set, caller(), set.read_set);
  await assert.rejects(writer.propose(changeSet(), caller("request-1", "b".repeat(64)), set.read_set), (error: unknown) => error instanceof ChangeWriterError && error.code === "idempotency_conflict");
  await assert.rejects(writer.propose(set, caller("request-2"), []), (error: unknown) => error instanceof ChangeWriterError && error.code === "invalid_input");
});

test("foreign read preconditions are scope and snapshot bound and revalidated before apply", async () => {
  const { writer, workspace } = await makeWriter();
  const foreignScope: WriterScope = { workspace_id: "source-workspace", repository_id: 29, branch: "main", generation: "source-generation" };
  const foreignSnapshot: WriterSnapshot = { id: "source-snapshot", local_commit: null, worktree_generation: "source-tree", draft_generation: null };
  const set: ChangeSet = {
    ...changeSet({ key: "foreign-read" }),
    read_set: [
      { path: "chapters/one.md", revision: null },
      { path: "meta/people.yaml", revision: null, scope: foreignScope, snapshot: foreignSnapshot },
    ],
  };
  const observed = [
    { path: "chapters/one.md", revision: null },
    { path: "meta/people.yaml", revision: null, scope: foreignScope, snapshot: foreignSnapshot },
  ];
  const admitted = await writer.propose(set, caller("foreign-read"), observed);
  workspace.foreignStale = true;
  await assert.rejects(writer.apply(scope, admitted.proposal_id, ["unit-1"], "ui", true), (error: unknown) => (error as { code?: string }).code === "snapshot_stale");
  assert.equal((await writer.status(scope, admitted.proposal_id)).status, "stale");
  assert.equal(workspace.text("chapters/one.md"), null);
});

test("wire ChangeSet normalization converts bounded number arrays to exact bytes", async () => {
  const { writer } = await makeWriter();
  const original = changeSet();
  const wire = {
    ...original,
    units: original.units.map(unit => ({ ...unit, operations: unit.operations.map(operation => ({ ...operation, content: [...operation.content!] })) })),
  };
  const { normalizeChangeSet } = await import("./writer.js");
  const normalized = normalizeChangeSet(wire);
  assert.ok(normalized.units[0]!.operations[0]!.content instanceof Uint8Array);
  const admitted = await writer.propose(normalized, caller(), normalized.read_set);
  assert.equal(admitted.preview.units[0]?.operations[0]?.after_hash, await sha(normalized.units[0]!.operations[0]!.content!));
});

test("approval applies a dependency-closed selection through the single writer", async () => {
  const { writer, workspace } = await makeWriter();
  const set = changeSet({
    paths: ["chapters/one.md", "chapters/two.md"],
    units: [
      { id: "unit-1", label: "Create first scene", depends_on: [], operations: [{ id: "op-1", kind: "create", path: "chapters/one.md", expected_revision: null, content: new TextEncoder().encode("one") }] },
      { id: "unit-2", label: "Create second scene", depends_on: ["unit-1"], operations: [{ id: "op-2", kind: "create", path: "chapters/two.md", expected_revision: null, content: new TextEncoder().encode("two") }] },
    ],
  });
  const proposal = await writer.propose(set, caller(), set.read_set);
  await assert.rejects(writer.apply(scope, proposal.proposal_id, ["unit-2"], "mcp", true), (error: unknown) => error instanceof ChangeWriterError && error.code === "capability_denied");
  const applied = await writer.apply(scope, proposal.proposal_id, ["unit-2"], "ui", true);
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.units.map(unit => unit.status), ["applied", "applied"]);
  assert.equal(workspace.text("chapters/one.md"), "one");
  assert.equal(workspace.text("chapters/two.md"), "two");
  assert.equal(applied.checkpoint.remote_confirmed, false);
});

test("stale workspace and dirty draft are rejected before worktree changes", async () => {
  const { writer, workspace } = await makeWriter();
  const set = changeSet();
  const stale = await writer.propose(set, caller(), set.read_set);
  workspace.seed("elsewhere.md", "author edit");
  await assert.rejects(writer.apply(scope, stale.proposal_id, ["unit-1"], "ui", true), (error: unknown) => error instanceof ChangeWriterError && error.code === "snapshot_stale");
  assert.equal(workspace.text("chapters/one.md"), null);

  const cleanWorkspace = new MemoryWriterWorkspace();
  const clean = await makeWriter(cleanWorkspace);
  const nextSet = changeSet({ key: "request-2" });
  const next = await clean.writer.propose(nextSet, caller("request-2"), nextSet.read_set);
  cleanWorkspace.makeDirty();
  await assert.rejects(clean.writer.apply(scope, next.proposal_id, ["unit-1"], "ui", true), (error: unknown) => error instanceof ChangeWriterError && error.code === "dirty_draft");
  assert.equal(cleanWorkspace.text("chapters/one.md"), null);
});

test("reopening a workspace retains review and safely recovers old-generation write-ahead", async () => {
  const { writer, workspace, journal } = await makeWriter();
  const next: WriterScope = { ...scope, generation: "generation-2" };
  const set = changeSet({ paths: ["chapters/one.md", "chapters/two.md"] });
  const proposal = await writer.propose(set, caller(), set.read_set);
  assert.equal((await writer.list(next)).items[0]?.proposal_id, proposal.proposal_id);
  workspace.failAfter(1);
  await assert.rejects(writer.apply(scope, proposal.proposal_id, ["unit-1"], "ui", true),
    (error: unknown) => error instanceof ChangeWriterError && error.code === "storage_unknown");
  assert.ok((await journal.read(next)).write_ahead);
  assert.equal(workspace.blocked, true);
  const recovered = await writer.recover(next);
  assert.equal(recovered?.proposal_id, proposal.proposal_id);
  assert.equal(recovered?.status, "proposed");
  assert.equal(workspace.text("chapters/one.md"), null);
  assert.equal(workspace.text("chapters/two.md"), null);
  assert.equal(workspace.blocked, false);
  const another: WriterScope = { ...scope, workspace_id: "other-workspace" };
  await assert.rejects(writer.status(another, proposal.proposal_id),
    (error: unknown) => error instanceof ChangeWriterError && error.code === "file_not_found");
  assert.equal((await writer.list(next)).items[0]?.proposal_id, proposal.proposal_id);
});

test("write-ahead recovery restores a partially persisted unit before another writer runs", async () => {
  const { writer, workspace, journal } = await makeWriter();
  const set = changeSet({ paths: ["chapters/one.md", "chapters/two.md"] });
  const proposal = await writer.propose(set, caller(), set.read_set);
  workspace.failAfter(1);
  await assert.rejects(writer.apply(scope, proposal.proposal_id, ["unit-1"], "ui", true), (error: unknown) => error instanceof ChangeWriterError && error.code === "storage_unknown");
  assert.equal(workspace.blocked, true);
  assert.notEqual(journal ? (await journal.read(scope)).write_ahead : null, null);
  const recovered = await writer.recover(scope);
  assert.equal(recovered?.status, "proposed");
  assert.equal(workspace.text("chapters/one.md"), null);
  assert.equal(workspace.text("chapters/two.md"), null);
  assert.equal(workspace.blocked, false);
  assert.equal((await journal.read(scope)).write_ahead, null);
});

test("lost response after all bytes persist is recovered as applied, without replay", async () => {
  const { writer, workspace } = await makeWriter();
  const set = changeSet();
  const proposal = await writer.propose(set, caller(), set.read_set);
  workspace.failAfter(1);
  await assert.rejects(writer.apply(scope, proposal.proposal_id, ["unit-1"], "ui", true), (error: unknown) => error instanceof ChangeWriterError && error.code === "storage_unknown");
  const recovered = await writer.recover(scope);
  assert.equal(recovered?.status, "applied");
  assert.equal(workspace.text("chapters/one.md"), "content 1");
  assert.equal((await writer.events(scope, proposal.proposal_id)).filter(item => item.kind === "recovered").length, 1);
});

test("malformed paths, duplicate writes, and cyclic unit dependencies are rejected", async () => {
  const { writer } = await makeWriter();
  const traversal = changeSet({ paths: ["../secret"] });
  await assert.rejects(writer.propose(traversal, caller(), traversal.read_set), (error: unknown) => error instanceof ChangeWriterError && error.code === "invalid_path");
  const cycle = changeSet({ paths: ["a.md", "b.md"], units: [
    { id: "unit-1", label: "A", depends_on: ["unit-2"], operations: [{ id: "op-1", kind: "create", path: "a.md", expected_revision: null, content: new Uint8Array([1]) }] },
    { id: "unit-2", label: "B", depends_on: ["unit-1"], operations: [{ id: "op-2", kind: "create", path: "b.md", expected_revision: null, content: new Uint8Array([2]) }] },
  ] });
  await assert.rejects(writer.propose(cycle, caller("cycle"), cycle.read_set), (error: unknown) => error instanceof ChangeWriterError && error.code === "invalid_input");
});

test("evidence quotes use exact UTF-16 offsets and preserve BOM and CRLF", async () => {
  const workspace = new MemoryWriterWorkspace();
  workspace.seed("manuscript/source.md", "\uFEFFA😀\r\nB");
  const source = await workspace.read(scope, "manuscript/source.md");
  const pinnedSnapshot = await workspace.current_snapshot(scope);
  const valid: ChangeSet = {
    ...changeSet(),
    snapshot: pinnedSnapshot,
    read_set: [...changeSet().read_set, { path: "manuscript/source.md", revision: source.revision }],
    evidence: [{ path: "manuscript/source.md", revision: source.revision!, start: 2, end: 4, quote: "😀" }],
  };
  const { writer } = await makeWriter(workspace);
  await writer.propose(valid, caller(), valid.read_set);
  const invalid = { ...valid, id: "bad-evidence", idempotency_key: "request-2", evidence: [{ ...valid.evidence[0]!, quote: "A" }] };
  await assert.rejects(writer.propose(invalid, caller("request-2"), invalid.read_set), (error: unknown) => error instanceof ChangeWriterError && error.code === "invalid_input");
});

test("proposal inspection returns metadata and bounded content chunks with scoped cursors", async () => {
  const { writer } = await makeWriter();
  const set = changeSet({ paths: ["chapters/one.md", "chapters/two.md"], units: [
    { id: "unit-1", label: "First change", depends_on: [], operations: [{ id: "op-1", kind: "create", path: "chapters/one.md", expected_revision: null, content: new TextEncoder().encode("content 1") }] },
    { id: "unit-2", label: "Second change", depends_on: [], operations: [{ id: "op-2", kind: "create", path: "chapters/two.md", expected_revision: null, content: new TextEncoder().encode("content 2") }] },
  ] });
  const proposal = await writer.propose(set, caller(), set.read_set);
  const inspection = await writer.inspect(scope, proposal.proposal_id, undefined, 1, true);
  assert.equal(inspection.units.length, 1);
  assert.equal("content" in inspection.units[0]!.operations[0]!, false);
  const ref = inspection.units[0]!.operations[0]!.content_ref;
  assert.ok(ref);
  const first = await writer.read_content(scope, proposal.proposal_id, ref, 0, 3);
  assert.equal(new TextDecoder().decode(first.bytes), "con");
  assert.equal(first.next_offset, 3);
  const rest = await writer.read_content(scope, proposal.proposal_id, ref, first.next_offset!, 64);
  assert.equal(new TextDecoder().decode(rest.bytes), "tent 1");
  assert.equal(rest.next_offset, null);
  assert.ok(inspection.next_cursor);
  assert.equal(new TextDecoder().decode(inspection.source_payload), JSON.stringify({ idempotency_key: "request-1" }));
  await assert.rejects(writer.inspect({ ...scope, branch: "other" }, proposal.proposal_id, inspection.next_cursor!), (error: unknown) => error instanceof ChangeWriterError && error.code === "file_not_found");
});
