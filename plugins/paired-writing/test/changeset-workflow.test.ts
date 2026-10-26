import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRequest, ActionResult, ChangeSet, Scope, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import { guest } from "../guest.js";

const scope: Scope = { workspace_id: "workspace-1", repository_id: 41, branch: "main", generation: "generation-1" };
const snapshot: Snapshot = { id: "snapshot-1", local_commit: "commit-1", worktree_generation: "worktree-1", draft_generation: null };

function sourceChangeSet(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "source-cs-1",
    projectId: "legacy-project-1",
    goal: "Add a character",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "low" },
    operations: [{
      id: "op-create-character",
      kind: "entity.create",
      precondition: { kind: "absent" },
      target: { entityId: "character-1", entityType: "character" },
      values: { id: "character-1", type: "character", name: "Ari" },
      evidenceIds: ["evidence-1"],
      assessment: { confidence: 0.9, risk: "low" },
    }],
    evidence: [{ id: "evidence-1", sourceKind: "external", sourceId: "note-1", revision: "source-rev-1" }],
    diagnostics: { before: null, after: null },
    ...overrides,
  };
}

class HostHarness {
  readonly calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  activeRequest?: ActionRequest;
  readonly bindingIds = ["legacy-project-1"];
  omitCompilerMapping = false;
  readonly compiledUnit = {
    id: "knowledge-unit-1", label: "Create character", depends_on: [], source_operation_ids: ["op-create-character"],
    operations: [{ id: "knowledge-operation-1", kind: "create", path: "bible/characters/character-1.yaml", expected_revision: null,
      content: Array.from(new TextEncoder().encode("id: character-1\ntype: character\nname: Ari\n")) }],
  };

  async respond(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ operation, payload });
    if (operation === "workspace.identity.read") {
      return { scope, snapshot, legacy_project_ids: this.bindingIds };
    }
    if (operation === "workspace.plugin.invoke") {
      assert.equal(payload.plugin_id, "proprium.knowledge");
      assert.equal(payload.action_id, "proprium.knowledge.changes.compile");
      const result: ActionResult = {
        ok: true, request_id: "compiler-request", scope, snapshot,
        value: {
          read_set: [{ path: "bible/characters/character-1.yaml", revision: null }],
          units: [this.compiledUnit],
          operation_map: this.omitCompilerMapping ? [] : [{ source_operation_id: "op-create-character", unit_id: this.compiledUnit.id, operation_ids: ["knowledge-operation-1"] }],
          diagnostics: [],
        }, warnings: [],
      };
      return result;
    }
    if (operation === "workspace.change.stage") {
      assert.deepEqual(payload.base_snapshot, snapshot);
      return { staging_snapshot: `stage-${this.calls.filter((call) => call.operation === operation).length}` };
    }
    if (operation === "workspace.change.propose") {
      return { proposal_id: "proposal-1", preview: { unit_count: 1 } };
    }
    throw new Error(`Unexpected Host operation ${operation}`);
  }
}

async function invoke(harness: HostHarness, request: ActionRequest): Promise<ActionResult> {
  harness.activeRequest = request;
  let message = JSON.parse(guest.invoke(JSON.stringify(request))) as Record<string, unknown>;
  while (message.kind === "host_call") {
    const value = await harness.respond(String(message.operation), message.payload as Record<string, unknown>);
    message = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: message.call_id, ok: true, value }))) as Record<string, unknown>;
  }
  return message as unknown as ActionResult;
}

function request(actionId: string, input: Record<string, unknown>, id: string, idempotencyKey?: string): ActionRequest {
  return {
    schema_version: 1, request_id: id, plugin_id: "proprium.paired-writing", action_id: actionId,
    scope, snapshot, input, deadline_ms: 30_000, ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
}

guest.initialize({ pluginId: "proprium.paired-writing", version: "0.1.0", workspaceId: scope.workspace_id });

test("projectId must match Host-registered legacy bindings before owner compilation", async () => {
  const harness = new HostHarness();
  harness.bindingIds.splice(0, 1, "different-project");
  const result = await invoke(harness, request("paired.changeset.validate", { changeSet: sourceChangeSet() }, "validate-binding"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "conflict");
  assert.deepEqual(harness.calls.map((call) => call.operation), ["workspace.identity.read"]);
  assert.equal(harness.calls.some((call) => call.operation === "workspace.change.propose"), false);
});

test("validate compiles the owner projection against a Host stage without registering a proposal", async () => {
  const harness = new HostHarness();
  const result = await invoke(harness, request("paired.changeset.validate", { changeSet: sourceChangeSet() }, "validate-compile"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { valid: boolean; operation_map: Array<Record<string, unknown>>; write_set: Array<Record<string, unknown>> };
  assert.equal(value.valid, true);
  assert.deepEqual(value.operation_map.map((item) => item.source_operation_id), ["op-create-character"]);
  assert.deepEqual(value.write_set, [{ path: "bible/characters/character-1.yaml", expected_revision: null, kind: "create" }]);
  assert.deepEqual(harness.calls.map((call) => call.operation), ["workspace.identity.read", "workspace.plugin.invoke", "workspace.change.stage"]);
  assert.equal(harness.calls.some((call) => call.operation === "workspace.change.propose"), false);
});

test("owner compiler output without complete source mapping is rejected before staging or proposal", async () => {
  const harness = new HostHarness();
  harness.omitCompilerMapping = true;
  const result = await invoke(harness, request("paired.changeset.validate", { changeSet: sourceChangeSet() }, "validate-missing-map"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid_input");
  assert.match(result.error.message, /omitted source operation/);
  assert.deepEqual(harness.calls.map((call) => call.operation), ["workspace.identity.read", "workspace.plugin.invoke"]);
});

test("proposal submits one source-preserving Host ChangeSet with no approval authority", async () => {
  const harness = new HostHarness();
  const source = sourceChangeSet();
  const result = await invoke(harness, request("paired.changeset.propose", { changeSet: source }, "propose-source", "source-key-1"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(harness.calls.filter((call) => call.operation === "workspace.change.propose").length, 1);
  const submitted = harness.calls.find((call) => call.operation === "workspace.change.propose")?.payload.changeset as Record<string, unknown>;
  assert.deepEqual(submitted.source_payload, source);
  assert.equal(submitted.source_payload_digest, (result.value as { source_fingerprint: string }).source_fingerprint);
  assert.deepEqual(submitted.domain_evidence, {
    assessment: source.assessment, diagnostics: source.diagnostics, evidence: source.evidence,
  });
  assert.equal((submitted as ChangeSet).idempotency_key, "source-key-1");
  assert.equal(harness.calls.some((call) => /approve|apply|reject/.test(call.operation)), false);
});
