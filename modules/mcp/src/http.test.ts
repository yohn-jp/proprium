import assert from "node:assert/strict";
import test from "node:test";
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
        assert.equal((input as { id?: string }).id, "cs-one");
        const proposal: ChangeProposal = {
          id: "cs-one",
          snapshot,
          operations: [],
          source: "mcp",
        };
        return {
          ok: true,
          snapshot,
          data: { changeSetId: "cs-one", proposalId: "cs-one", operationIds: ["op-one"], operationMap: {}, dependencies: {} },
          proposals: [proposal],
        };
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

test("submit_change_set preserves the source NarrativeChangeSet payload and ID", async () => {
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
    assert.deepEqual(calls, ["story.changes.propose"]);
    assert.equal((result.structuredContent as { proposals: ChangeProposal[] }).proposals[0]?.id, "cs-one");
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
