import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ActionDescriptor, ActionResult, ChangeProposal, ModuleActionContext, SnapshotId } from "@scriptorium/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { closeMcpSessions, createMcpHttpContribution } from "./http.js";

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

function actionContext(
  calls: string[],
  extraActions: ActionDescriptor[] = [],
  onStatusSignal?: (signal: AbortSignal | undefined) => void,
  sourceOperationIds: string[] = ["op-one"],
) {
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
    async invoke(actionId: string, input: unknown, signal?: AbortSignal): Promise<ActionResult> {
      calls.push(actionId);
      if (actionId === "core.status") {
        if (onStatusSignal) {
          onStatusSignal(signal);
          if (signal) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        }
        return { ok: true, snapshot, data: { status: "ready" } };
      }
      if (actionId === "story.changes.propose") {
        const changeSet = input as { id: string; projectId: string; operations: Array<{ id: string }> };
        const coreProposalId = /^[A-Za-z0-9_-]{1,128}$/u.test(changeSet.id)
          ? changeSet.id
          : `story-cs-${createHash("sha256").update(changeSet.id, "utf8").digest("hex")}`;
        const operationMap = Object.fromEntries(sourceOperationIds.map((id) => [id, id]));
        const resultIds = Object.fromEntries(sourceOperationIds.map((id, index) => [id, `char-${index ? "two" : "one"}`]));
        const resultPaths = Object.fromEntries(sourceOperationIds.map((id, index) => [id, [`characters/char-${index ? "two" : "one"}.yaml`]]));
        const resultRevisions = Object.fromEntries(sourceOperationIds.map((id) => [id, `sha256-${id}`]));
        const sourceDetails = {
          sourceChangeSet: input,
          sourceFingerprint: "f".repeat(64),
          submittedAt: "2026-10-17T00:00:00.000Z",
          coreProposalId,
          operationMap,
          resultIds,
          resultPaths,
          resultRevisions,
          affectedEntities: {},
        };
        const proposal: ChangeProposal = {
          id: coreProposalId,
          snapshot,
          operations: sourceOperationIds.map((id, index) => ({
            id,
            generation: 0,
            repository: snapshot.repository,
            baseRemoteCommit: snapshot.remoteCommit,
            effect: "metadata",
            reads: [],
            writes: [{
              path: `characters/char-${index ? "two" : "one"}.yaml`,
              revision: "a".repeat(64),
              content: "updated",
            }],
            message: "test source change",
          })),
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
            operationIds: sourceOperationIds,
            operationMap,
            dependencies: {},
            resultIds,
            resultPaths,
            resultRevisions,
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
      if (actionId === "story.cooccurrence") {
        return { ok: true, snapshot, data: { edges: [], gaps: [] } };
      }
      if (actionId === "diagnostics.checkConsistency") {
        return { ok: true, snapshot, data: { ok: true, scope: null, issues: [] } };
      }
      if (actionId === "diagnostics.checkContinuity") {
        return { ok: true, snapshot, data: { scope: null, warnings: [] } };
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

test("compute_cooccurrence maps to the Story co-occurrence action without extra source arguments", async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [{ id: "story.cooccurrence", module: "story", effect: "read" }]);
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
    const cooccurrence = tools.find((tool) => tool.name === "compute_cooccurrence");
    assert.ok(cooccurrence);
    assert.equal("scope" in (cooccurrence.inputSchema.properties ?? {}), false);
    const result = await client.callTool({ name: "compute_cooccurrence", arguments: { project_id: "project-one" } });
    assert.deepEqual(result.structuredContent, { snapshot, data: { edges: [], gaps: [] } });
    assert.deepEqual(calls, ["story.cooccurrence"]);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("consistency and continuity use their exact project-level diagnostics actions", async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [
    { id: "diagnostics.checkConsistency", module: "diagnostics", effect: "read" },
    { id: "diagnostics.checkContinuity", module: "diagnostics", effect: "read" },
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
    const { tools } = await client.listTools();
    for (const name of ["check_consistency", "check_continuity"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool);
      assert.equal("scope" in (tool.inputSchema.properties ?? {}), false);
    }
    const consistency = await client.callTool({ name: "check_consistency", arguments: { project_id: "project-one" } });
    assert.deepEqual(consistency.structuredContent, {
      snapshot,
      data: { ok: true, issue_count: 0, issues: [] },
    });
    const continuity = await client.callTool({ name: "check_continuity", arguments: { project_id: "project-one" } });
    assert.deepEqual(continuity.structuredContent, { snapshot, data: [] });
    assert.deepEqual(calls, ["diagnostics.checkConsistency", "diagnostics.checkContinuity"]);
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
      resultingRevision: "sha256-op-one",
      resultId: "char-one",
    }]);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});

test("ChangeSet readback preserves approved IDs while selected checkpoints are pending", async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [], undefined, ["op-one", "op-two"]);
  const contribution = createMcpHttpContribution(new Map());
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://scriptorium.test/api/projects/project-one/modules/mcp/streamable"),
    { fetch },
  );
  const client = new Client({ name: "mcp-module-test", version: "1.0.0" });
  const changeSet = {
    schemaVersion: 1,
    id: "cs-two-operations",
    projectId: "project-one",
    goal: "Update two character profiles",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "low" },
    operations: ["op-one", "op-two"].map((id, index) => ({
      id,
      kind: "entity.update",
      precondition: { kind: "revision", value: `r${index + 1}` },
      target: { entityId: `char-${index ? "two" : "one"}` },
      changes: { name: `New name ${index + 1}` },
      evidenceIds: [`evidence-${index + 1}`],
      assessment: { confidence: 0.9, risk: "low" },
    })),
    evidence: [1, 2].map((index) => ({
      id: `evidence-${index}`,
      sourceKind: "entity",
      sourceId: `char-${index === 1 ? "one" : "two"}`,
      revision: `r${index}`,
    })),
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const submitted = await client.callTool({
      name: "submit_change_set",
      arguments: { project_id: "project-one", change_set: changeSet },
    });
    assert.notEqual(submitted.isError, true);
    host.setProposalReview(["op-one", "op-two"], [{
      operationId: "op-one",
      generation: 0,
      localCommit: "d".repeat(40),
      remoteBase: "a".repeat(40),
      revisions: [{ path: "characters/char-one.yaml", revision: "b".repeat(64) }],
    }]);
    const mixed = await client.callTool({
      name: "get_change_set",
      arguments: { project_id: "project-one", change_set_id: "cs-two-operations" },
    });
    const mixedRecord = mixed.structuredContent as { status: string; approvedOperationIds: string[]; result?: unknown };
    assert.equal(mixedRecord.status, "approved");
    assert.deepEqual(mixedRecord.approvedOperationIds, ["op-one", "op-two"]);
    assert.equal("result" in mixedRecord, false);

    host.setProposalReview(["op-one"], [{
      operationId: "op-one",
      generation: 0,
      localCommit: "d".repeat(40),
      remoteBase: "a".repeat(40),
      revisions: [{ path: "characters/char-one.yaml", revision: "b".repeat(64) }],
    }]);
    const partial = await client.callTool({
      name: "get_change_set",
      arguments: { project_id: "project-one", change_set_id: "cs-two-operations" },
    });
    const partialRecord = partial.structuredContent as {
      status: string;
      approvedOperationIds: string[];
      result: { status: string; operations: Array<{ operationId: string }> };
    };
    assert.equal(partialRecord.status, "partially-applied");
    assert.deepEqual(partialRecord.approvedOperationIds, ["op-one"]);
    assert.deepEqual(partialRecord.result.operations, [{
      operationId: "op-one",
      kind: "entity.update",
      precondition: { kind: "revision", value: "r1" },
      resultingRevision: "sha256-op-one",
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

test("SDK cancellation reaches an in-flight HTTP host action", async () => {
  const calls: string[] = [];
  let signalObserved!: (signal: AbortSignal | undefined) => void;
  const started = new Promise<AbortSignal | undefined>((resolve) => {
    signalObserved = resolve;
  });
  const host = actionContext(calls, [], signalObserved);
  const sessions = new Map();
  const contribution = createMcpHttpContribution(sessions);
  const server = createServer(async (incoming, outgoing) => {
    const requestController = new AbortController();
    incoming.once("aborted", () => requestController.abort(new Error("HTTP client disconnected")));
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) requestController.abort(new Error("HTTP response closed"));
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) headers.set(name, value.join(", "));
        else if (value !== undefined) headers.set(name, value);
      }
      const init: RequestInit & { duplex?: "half" } = {
        method: incoming.method,
        headers,
        signal: requestController.signal,
      };
      if (chunks.length) {
        init.body = Buffer.concat(chunks);
        init.duplex = "half";
      }
      const response = await contribution.handle(new Request(`http://127.0.0.1${incoming.url}`, init), host);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (!response.body) {
        outgoing.end();
        return;
      }
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!outgoing.write(Buffer.from(chunk.value))) {
            await new Promise<void>((resolve) => outgoing.once("drain", resolve));
          }
        }
        outgoing.end();
      } finally {
        reader.releaseLock();
      }
    } catch {
      if (!outgoing.headersSent) outgoing.statusCode = 500;
      outgoing.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/api/projects/project-one/modules/mcp/streamable`),
  );
  const client = new Client({ name: "mcp-cancellation-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const cancellation = new AbortController();
    const pending = client.callTool(
      { name: "get_status", arguments: { project_id: "project-one" } },
      undefined,
      { signal: cancellation.signal },
    );
    const hostSignal = await started;
    assert.ok(hostSignal);
    assert.equal(hostSignal.aborted, false);
    cancellation.abort(new Error("caller cancelled tool"));
    await assert.rejects(pending);
    await new Promise<void>((resolve, reject) => {
      if (hostSignal.aborted) return resolve();
      const timeout = setTimeout(() => reject(new Error("MCP cancellation did not reach the HTTP host action")), 2_000);
      hostSignal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    assert.equal(hostSignal.aborted, true);
    assert.deepEqual(calls, ["core.status"]);
  } finally {
    await client.close().catch(() => undefined);
    await closeMcpSessions(sessions);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
