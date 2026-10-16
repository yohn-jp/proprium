import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { ActionDescriptor, ActionResult, ChangeProposal, ModuleActionContext, SnapshotId } from "@scriptorium/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpHttpContribution } from "./http.js";

const snapshot: SnapshotId = {
  repository: {
    provider: "local",
    repositoryId: "repo-one",
    defaultBranch: "main",
    ownerScope: "owner-one",
    url: "file:///repo-one",
  },
  remoteCommit: "a".repeat(40),
};

function actionContext(calls: string[], extraActions: ActionDescriptor[] = []) {
  const actions: ActionDescriptor[] = [
    { id: "core.status", module: "core", effect: "read" },
    { id: "story.changes.propose", module: "story", effect: "propose" },
    ...extraActions,
  ];
  const reader = {
    snapshot,
    async read() { return null; },
    async list() { return []; },
  };
  let storedProposal: ChangeProposal | undefined;
  let storedProposalStatus: unknown;
  return {
    projectId: "project-one",
    reader,
    async listActions() { return actions; },
    async invoke(actionId: string, input: unknown): Promise<ActionResult> {
      calls.push(actionId);
      if (actionId === "core.status") {
        return { ok: true, snapshot, data: { status: "ready" } };
      }
      if (actionId === "story.changes.propose") {
        const changeSet = input as { id: string; projectId: string; operations: Array<{ id: string }> };
        const coreProposalId = /^[A-Za-z0-9_-]{1,128}$/u.test(changeSet.id)
          ? changeSet.id
          : `story-cs-${createHash("sha256").update(changeSet.id, "utf8").digest("hex")}`;
        const sourceDetails = {
          sourceChangeSet: input,
          sourceFingerprint: "f".repeat(64),
          submittedAt: "2026-10-17T00:00:00.000Z",
          coreProposalId,
          operationMap: { "op-one": "op-one" },
          resultIds: { "op-one": "char-one" },
          resultPaths: { "op-one": ["characters/char-one.yaml"] },
          resultRevisions: { "op-one": "sha256-result" },
          affectedEntities: {},
        };
        const proposal: ChangeProposal = {
          id: coreProposalId,
          snapshot,
          operations: [{
            id: "op-one",
            generation: 0,
            repository: snapshot.repository,
            baseRemoteCommit: snapshot.remoteCommit,
            effect: "metadata",
            reads: [],
            writes: [{ path: "characters/char-one.yaml", revision: "a".repeat(64), content: "updated" }],
            message: "test source change",
          }],
          source: "mcp",
          evidence: [{
            id: "ncs-one",
            snapshot,
            module: "story",
            kind: "source.narrative-change-set.v1",
            paths: [],
            details: sourceDetails,
          }],
        };
        storedProposal = proposal;
        storedProposalStatus = {
          proposal,
          state: "proposed",
          approvedOperationIds: [],
          checkpoints: [],
          stale: false,
        };
        return {
          ok: true,
          snapshot,
          data: {
            changeSetId: changeSet.id,
            proposalId: coreProposalId,
            coreProposalId,
            submittedAt: sourceDetails.submittedAt,
            sourceFingerprint: sourceDetails.sourceFingerprint,
            operationIds: ["op-one"],
            operationMap: sourceDetails.operationMap,
            dependencies: {},
            resultIds: sourceDetails.resultIds,
            resultPaths: sourceDetails.resultPaths,
            resultRevisions: sourceDetails.resultRevisions,
            affectedEntities: {},
            replayed: false,
          },
          proposals: [proposal],
        };
      }
      if (actionId === "core.proposals.get" && storedProposal && storedProposalStatus) {
        return { ok: true, snapshot, data: { proposal: storedProposalStatus } };
      }
      if (actionId === "core.proposals.list") {
        return { ok: true, snapshot, data: { proposals: storedProposalStatus ? [storedProposalStatus] : [] } };
      }
      return { ok: false, snapshot, error: { code: "not_found", message: "Unknown action", retryable: false } };
    },
    async linkedReader() { return reader; },
    signal: new AbortController().signal,
    async propose() {
      throw new Error("Read-only test action unexpectedly proposed");
    },
    async runJob() {
      throw new Error("MCP must not start a model job");
    },
    setProposalReview(approvedOperationIds: string[], checkpoints: unknown[]) {
      if (!storedProposalStatus || typeof storedProposalStatus !== "object") throw new Error("No proposal is stored");
      storedProposalStatus = {
        ...(storedProposalStatus as Record<string, unknown>),
        state: checkpoints.length ? "checkpointed" : approvedOperationIds.length ? "approved" : "proposed",
        approvedOperationIds,
        checkpoints,
      };
    },
  } satisfies ModuleActionContext;
}

test("SDK Streamable HTTP transport lists and invokes tools through the host action context", async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const sourceTools = [
      "get_entity", "get_scene_context", "suggest_rewrite", "list_entities", "search", "get_volume_tree",
      "reload", "analyze_manuscript", "check_stylometric_deviations", "check_plot_semantics", "get_diagnostics",
      "get_thread_status", "get_dialogue", "format_manuscript", "create_scene", "update_entity",
      "check_consistency", "check_continuity", "compute_cooccurrence", "check_voice_consistency",
      "check_style_deviations", "get_writing_context", "get_context_manifest", "lint_manuscript",
      "submit_change_set", "get_change_set", "list_change_sets",
    ];
    assert.equal(sourceTools.length, 27);
    assert.ok(sourceTools.every((name) => names.has(name)));
    assert.ok(names.has("discover_actions"));
    assert.ok(names.has("get_status"));

    const result = await client.callTool({ name: "get_status", arguments: { project_id: "project-one" } });
    assert.deepEqual(result.structuredContent, {
      snapshot,
      data: { status: "ready" },
    });
    assert.deepEqual(calls, ["core.status"]);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("MCP refuses action names that could approve or publish author changes", async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "invoke_action",
      arguments: { project_id: "project-one", action_id: "core.checkpoint", input: {} },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, []);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("submit_change_set returns a source ChangeSetRecord with its source ID", async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });
  const changeSet = {
    schemaVersion: 1,
    id: "cs-one",
    projectId: "project-one",
    goal: "Update the character profile",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "low" },
    operations: [{
      id: "op-one",
      kind: "entity.update",
      precondition: { kind: "revision", value: "r1" },
      target: { entityId: "char-one" },
      changes: { name: "New name" },
      evidenceIds: ["evidence-one"],
      assessment: { confidence: 0.9, risk: "low" },
    }],
    evidence: [{ id: "evidence-one", sourceKind: "entity", sourceId: "char-one", revision: "r1" }],
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "submit_change_set",
      arguments: { project_id: "project-one", change_set: changeSet },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls, ["story.changes.propose", "core.proposals.get"]);
    const record = result.structuredContent as { changeSet: { id: string }; status: string; fingerprint: string };
    assert.equal(record.changeSet.id, "cs-one");
    assert.equal(record.status, "proposed");
    assert.equal(record.fingerprint, "f".repeat(64));
    const listed = await client.callTool({ name: "list_change_sets", arguments: { project_id: "project-one" } });
    assert.deepEqual((listed.structuredContent as { change_sets: Array<{ change_set_id: string; status: string }> }).change_sets, [
      { change_set_id: "cs-one", project_id: "project-one", status: "proposed", submitted_at: "2026-10-17T00:00:00.000Z", operation_ids: ["op-one"] },
    ]);
    const fetched = await client.callTool({ name: "get_change_set", arguments: { project_id: "project-one", change_set_id: "cs-one" } });
    assert.deepEqual(fetched.structuredContent, record);
    host.setProposalReview(["op-one"], [{
      operationId: "op-one",
      generation: 0,
      localCommit: "d".repeat(40),
      remoteBase: "a".repeat(40),
      revisions: [{ path: "characters/char-one.yaml", revision: "b".repeat(64) }],
    }]);
    const applied = await client.callTool({ name: "get_change_set", arguments: { project_id: "project-one", change_set_id: "cs-one" } });
    const appliedRecord = applied.structuredContent as { status: string; approvedOperationIds: string[]; result: { status: string; operations: Array<{ operationId: string; resultId: string; resultingRevision: string }> } };
    assert.equal(appliedRecord.status, "applied");
    assert.deepEqual(appliedRecord.approvedOperationIds, ["op-one"]);
    assert.deepEqual(appliedRecord.result.operations, [{
      operationId: "op-one",
      kind: "entity.update",
      precondition: { kind: "revision", value: "r1" },
      resultingRevision: "sha256-result",
      resultId: "char-one",
    }]);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("submit_change_set maps source IDs outside Core's proposal ID alphabet and length", async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });
  const changeSet = {
    schemaVersion: 1,
    id: `legacy:${"a".repeat(140)}`,
    projectId: "project-one",
    goal: "Update the character profile",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "low" },
    operations: [{
      id: "op-one",
      kind: "entity.update",
      precondition: { kind: "revision", value: "r1" },
      target: { entityId: "char-one" },
      changes: { name: "New name" },
      evidenceIds: ["evidence-one"],
      assessment: { confidence: 0.9, risk: "low" },
    }],
    evidence: [{ id: "evidence-one", sourceKind: "entity", sourceId: "char-one", revision: "r1" }],
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "submit_change_set",
      arguments: { project_id: "project-one", change_set: changeSet },
    });
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as { changeSet: { id: string } }).changeSet.id, changeSet.id);
    assert.deepEqual(calls, ["story.changes.propose", "core.proposals.get"]);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("HTTP MCP session rejects cross-project tool calls with a machine scope error", async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "get_status",
      arguments: { project_id: "project-two" },
    });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, "PROJECT_SCOPE_MISMATCH");
    assert.deepEqual(calls, []);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("submit_change_set rejects source records that are not proposed before host invocation", async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });
  const changeSet = {
    schemaVersion: 1,
    id: "cs-one",
    projectId: "project-one",
    goal: "Update the character profile",
    status: "approved",
    assessment: { confidence: 0.9, risk: "low" },
    operations: [{
      id: "op-one",
      kind: "entity.update",
      precondition: { kind: "revision", value: "r1" },
      target: { entityId: "char-one" },
      changes: { name: "New name" },
      evidenceIds: ["evidence-one"],
      assessment: { confidence: 0.9, risk: "low" },
    }],
    evidence: [{ id: "evidence-one", sourceKind: "entity", sourceId: "char-one", revision: "r1" }],
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "submit_change_set",
      arguments: { project_id: "project-one", change_set: changeSet },
    });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, "INVALID_INPUT");
    assert.deepEqual(calls, []);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("source tools fail with a module availability error when their producer is not enabled", async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "get_dialogue", arguments: { character_id: "char-one" } });
    assert.equal(result.isError, true);
    assert.deepEqual((result.structuredContent as { error: { code: string } }).error.code, "MODULE_UNAVAILABLE");
    assert.deepEqual(calls, []);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("hybrid search and full diagnostics fail closed instead of returning partial substitutes", async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [
    { id: "core.search", module: "core", effect: "read" },
    { id: "diagnostics.analyze", module: "diagnostics", effect: "compute" },
  ]);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const search = await client.callTool({
      name: "search",
      arguments: { project_id: "project-one", query: "memory", limit: 20 },
    });
    assert.equal(search.isError, true);
    assert.equal((search.structuredContent as { error: { code: string } }).error.code, "MODULE_UNAVAILABLE");

    const diagnostics = await client.callTool({
      name: "get_diagnostics",
      arguments: { project_id: "project-one", scene_id: "scene-one", text: "draft" },
    });
    assert.equal(diagnostics.isError, true);
    assert.equal((diagnostics.structuredContent as { error: { code: string } }).error.code, "ACTION_UNAVAILABLE");
    assert.deepEqual(calls, []);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});
