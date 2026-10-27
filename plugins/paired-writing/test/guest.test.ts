import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRequest, ActionResult, ChangeSet, Scope, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import { guest } from "../guest.js";

const scope: Scope = { workspace_id: "workspace-1", repository_id: 41, branch: "main", generation: "generation-1" };
const snapshot: Snapshot = { id: "snapshot-1", local_commit: "commit-1", worktree_generation: "worktree-1", draft_generation: null };
const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
const manuscriptPath = "manuscript/v1/c1/s1.md";
const manuscript = "---\r\ntitle: Scene\r\nunknown: keep-me\r\n---\r\n🌙彼女は悲しかった。\r\n終わり。\r\n";
const manuscriptBytes = new TextEncoder().encode(manuscript);
const draftText = "---\r\ntitle: Scene\r\nunknown: keep-me\r\n---\r\n🌙彼女は本当に悲しかった。\r\n終わり。\r\n";
const draftBytes = new TextEncoder().encode(draftText);
const scene = {
  scene_id: "s1",
  title: "Scene",
  volume: { id: "v1", title: "Volume" },
  chapter: { id: "c1", title: "Chapter" },
  metadata_path: scenePath,
  metadata_revision: "scene-rev-1",
  manuscript_path: manuscriptPath,
  manuscript_revision: "manuscript-rev-1",
  diagnostics: [],
};

class HostHarness {
  readonly cache = new Map<string, unknown>();
  readonly calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  proposal?: ChangeSet;
  activeSnapshot: Snapshot = snapshot;

  async respond(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ operation, payload });
    if (operation === "workspace.plugin.invoke") {
      assert.equal(payload.plugin_id, "proprium.narrative");
      assert.equal(payload.action_id, "proprium.narrative.scene.context");
      const result: ActionResult<typeof scene> = { ok: true, request_id: "nested-request", scope, snapshot: this.activeSnapshot, value: scene, warnings: [] };
      return result;
    }
    if (operation === "workspace.file.read") {
      assert.equal(payload.path, manuscriptPath);
      const fileSnapshot = payload.snapshot as Snapshot;
      const selectedBytes = fileSnapshot.id === "draft-snapshot-1" ? draftBytes : manuscriptBytes;
      const offset = Number(payload.offset);
      const bytes = Array.from(selectedBytes.slice(offset, offset + Number(payload.length)));
      const next = offset + bytes.length;
      return {
        revision: fileSnapshot.id === "draft-snapshot-1" ? "draft-rev-1" : scene.manuscript_revision,
        total_bytes: selectedBytes.length,
        offset,
        bytes,
        next_offset: next < selectedBytes.length ? next : null,
      };
    }
    if (operation === "workspace.derived.cache.put") {
      this.cache.set(String(payload.key), payload.value);
      return null;
    }
    if (operation === "workspace.derived.cache.get") return this.cache.get(String(payload.key));
    if (operation === "workspace.change.propose") {
      this.proposal = payload.changeset as ChangeSet;
      return { proposal_id: "proposal-1", preview: { title: this.proposal.title, read_paths: this.proposal.read_set.map((item) => item.path) } };
    }
    if (operation === "workspace.change.list") return { items: [], next_cursor: null };
    if (operation === "workspace.change.status") return { proposal_id: payload.proposal_id, status: "proposed" };
    if (operation === "workspace.change.observations") return { items: [], next_cursor: null };
    if (operation === "workspace.change.inspect") return { proposal_id: payload.proposal_id, source_payload_available: false };
    if (operation === "workspace.change.content.read") return { offset: payload.offset, total_bytes: 0, bytes: [], next_offset: null, sha256: "empty" };
    throw new Error(`Unexpected Host operation ${operation}`);
  }
}

async function invokeAction(harness: HostHarness, request: ActionRequest): Promise<ActionResult> {
  harness.activeSnapshot = request.snapshot;
  let message = JSON.parse(guest.invoke(JSON.stringify(request))) as Record<string, unknown>;
  while (message.kind === "host_call") {
    const operation = String(message.operation);
    const payload = message.payload as Record<string, unknown>;
    const value = await harness.respond(operation, payload);
    message = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: message.call_id, ok: true, value }))) as Record<string, unknown>;
  }
  return message as unknown as ActionResult;
}

function request(actionId: string, input: Record<string, unknown>, id: string, idempotencyKey?: string, requestSnapshot: Snapshot = snapshot): ActionRequest {
  return {
    schema_version: 1,
    request_id: id,
    plugin_id: "proprium.paired-writing",
    action_id: actionId,
    scope,
    snapshot: requestSnapshot,
    input,
    deadline_ms: 30_000,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
}

guest.initialize({ pluginId: "proprium.paired-writing", version: "0.1.0", workspaceId: scope.workspace_id });

test("context capture reads the linked manuscript at the requested snapshot and labels explicit selection", async () => {
  const harness = new HostHarness();
  const selected = "彼女は悲しかった。";
  const start = manuscript.indexOf(selected);
  const result = await invokeAction(harness, request("paired.context.capture", {
    target: { sceneId: scene.scene_id },
    include: ["scene", "saved_manuscript", "selection"],
    range: { start, end: start + selected.length, text: selected },
  }, "capture-1"));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { context_id: string; target: { manuscript_path: string }; parts: Array<Record<string, unknown>> };
  assert.equal(value.target.manuscript_path, manuscriptPath);
  assert.equal(value.context_id, "capture-1");
  const selection = value.parts.find((part) => part.id === "selection");
  assert.equal(selection?.content, selected);
  assert.equal(selection?.origin, "explicitly_shared_selection");
  assert.equal(selection?.revision, scene.manuscript_revision);
  assert.equal(harness.calls.filter((call) => call.operation === "workspace.file.read").length, 1);
});

test("context manifest keeps scope and revision metadata but excludes prose bytes", async () => {
  const harness = new HostHarness();
  const captured = await invokeAction(harness, request("paired.context.capture", { target: { sceneId: scene.scene_id } }, "capture-2"));
  assert.equal(captured.ok, true);
  const manifest = await invokeAction(harness, request("paired.context.manifest", { contextId: "capture-2" }, "manifest-1"));
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  const value = manifest.value as { external_host_final_prompt_observed: boolean; parts: Array<Record<string, unknown>> };
  assert.equal(value.external_host_final_prompt_observed, false);
  assert.equal("content" in value.parts[1]!, false);
  assert.equal(value.parts[1]?.revision, scene.manuscript_revision);
});

test("explicit draft capture reads the Host-issued saved and draft snapshots with no draft-only operation", async () => {
  const harness = new HostHarness();
  const draftSnapshot = { ...snapshot, id: "draft-snapshot-1", draft_generation: "draft-generation-1" };
  const result = await invokeAction(harness, request("paired.context.capture", {
    target: { sceneId: scene.scene_id },
    include: ["draft"],
    shareDraft: {
      document_path: manuscriptPath,
      revision: "draft-rev-1",
      base_snapshot: snapshot.id,
      base_scene_revision: scene.metadata_revision,
      draft_generation: "draft-generation-1",
      confirmed: true,
    },
  }, "capture-draft-1", undefined, draftSnapshot));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { draft: { status: string; revision?: string }; parts: Array<Record<string, unknown>> };
  assert.equal(value.draft.status, "explicitly_shared");
  assert.equal(value.draft.revision, "draft-rev-1");
  const saved = value.parts.find((part) => part.id === "saved-manuscript");
  const sharedDraft = value.parts.find((part) => part.id === "draft");
  assert.equal(saved?.included, false);
  assert.equal(saved?.content, "");
  assert.equal(sharedDraft?.content, draftText);
  assert.deepEqual(harness.calls.filter((call) => call.operation === "workspace.file.read").map((call) => (call.payload.snapshot as Snapshot).id), [snapshot.id, draftSnapshot.id]);
  assert.equal(harness.calls.some((call) => call.operation === "workspace.draft.read"), false);
});

test("local rewrite returns three distinct source-grounded candidates without provider access", async () => {
  const harness = new HostHarness();
  const selected = "彼女は悲しかった。";
  const start = manuscript.indexOf(selected);
  const result = await invokeAction(harness, request("paired.rewrite.suggest", {
    sceneId: scene.scene_id,
    manuscriptRevision: scene.manuscript_revision,
    selection: { start, end: start + selected.length, text: selected },
  }, "rewrite-1"));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { suggestions: Array<{ text: string }>; citations: Array<{ path: string; revision: string; quote: string }>; provenance: { provider: string } };
  assert.equal(value.suggestions.length, 3);
  assert.equal(new Set(value.suggestions.map((candidate) => candidate.text)).size, 3);
  assert.deepEqual(value.citations[0], { path: manuscriptPath, revision: scene.manuscript_revision, start, end: start + selected.length, quote: selected });
  assert.equal(value.provenance.provider, "local");
  assert.equal(harness.calls.some((call) => call.operation.includes("provider")), false);
});

test("stale rewrite selection fails before proposal registration", async () => {
  const harness = new HostHarness();
  const selected = "月彼女は悲しかった。";
  const start = manuscript.indexOf("彼女");
  const result = await invokeAction(harness, request("paired.rewrite.suggest", {
    sceneId: scene.scene_id,
    manuscriptRevision: scene.manuscript_revision,
    selection: { start, end: start + selected.length, text: selected },
  }, "rewrite-stale"));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "snapshot_stale");
  assert.equal(harness.calls.some((call) => call.operation === "workspace.change.propose"), false);
});

test("rewrite proposal preserves all bytes outside the chosen UTF-16 range and goes through Host review", async () => {
  const harness = new HostHarness();
  const selected = "彼女は悲しかった。";
  const start = manuscript.indexOf(selected);
  const replacement = "喉の奥が詰まり、視線が足元へ落ちた。";
  const result = await invokeAction(harness, request("paired.rewrite.propose", {
    sceneId: scene.scene_id,
    manuscriptPath,
    manuscriptRevision: scene.manuscript_revision,
    selection: { start, end: start + selected.length, text: selected },
    replacement,
    rationale: "A selected rewrite candidate",
    evidence: [{ path: manuscriptPath, revision: scene.manuscript_revision, start, end: start + selected.length, quote: selected }],
  }, "rewrite-propose-1", "choice-1"));

  assert.equal(result.ok, true);
  assert.ok(harness.proposal);
  const operation = harness.proposal!.units[0]!.operations[0]!;
  assert.equal(operation.kind, "replace");
  assert.deepEqual(harness.proposal!.read_set.map((item) => item.path), [scenePath, manuscriptPath]);
  assert.equal(new TextDecoder().decode(new Uint8Array(operation.content)), manuscript.slice(0, start) + replacement + manuscript.slice(start + selected.length));
  assert.equal(harness.calls.some((call) => call.operation === "workspace.change.propose"), true);
}
);

test("proposal receipt actions are scoped read-only Host calls", async () => {
  const harness = new HostHarness();
  const list = await invokeAction(harness, request("paired.changeset.list", { status: "proposed", limit: 10 }, "receipt-list"));
  const status = await invokeAction(harness, request("paired.changeset.status", { proposal_id: "proposal-1" }, "receipt-status"));
  const observations = await invokeAction(harness, request("paired.changeset.observations", { proposal_id: "proposal-1", limit: 20 }, "receipt-events"));
  const inspection = await invokeAction(harness, request("paired.changeset.inspect", { proposal_id: "proposal-1", include_source: true }, "receipt-inspect"));
  const content = await invokeAction(harness, request("paired.changeset.content.read", { proposal_id: "proposal-1", ref: "source-1", offset: 0 }, "receipt-content"));

  assert.equal(list.ok, true);
  assert.equal(status.ok, true);
  assert.equal(observations.ok, true);
  assert.equal(inspection.ok, true);
  assert.equal(content.ok, true);
  assert.deepEqual(harness.calls.slice(-5).map((call) => call.operation), [
    "workspace.change.list", "workspace.change.status", "workspace.change.observations",
    "workspace.change.inspect", "workspace.change.content.read",
  ]);
  assert.deepEqual(harness.calls.at(-1)?.payload, { proposal_id: "proposal-1", ref: "source-1", offset: 0, length: 65_536 });
  assert.equal(harness.calls.some((call) => ["workspace.change.approve", "workspace.change.apply", "workspace.change.reject"].includes(call.operation)), false);
});

test("rewrite panel binds its proposal to the exact manuscript citation", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  const panel = manifest.ui.find((entry: { id: string }) => entry.id === "paired-writing");
  const candidates = panel.body.tabs.find((tab: { id: string }) => tab.id === "rewrite-candidates-tab").body;
  assert.equal(candidates.item_action.input_template.manuscriptPath.data_key, "last_action_result.citations.0.path");
  assert.equal(candidates.item_action.input_template.manuscriptRevision.data_key, "last_action_result.citations.0.revision");
});
