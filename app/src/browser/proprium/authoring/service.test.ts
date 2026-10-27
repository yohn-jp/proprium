import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAuthoringService, IndexedDbActionIdempotencyStore } from "./service.js";
import type { VerifiedActionSet } from "./actions.js";
import type { ActionDescriptor, ActionRequest, ActionResult, Scope, Snapshot } from "./types.js";
import type { BrowserLocalGit } from "../git/index.js";
import type { WorkspaceIdentity } from "../git/protocol.js";

const pluginId = "proprium.research";
const actionId = "proprium.research.identity";
const scope: Scope = { workspace_id: "workspace-local", repository_id: null, branch: "main", generation: "generation-1" };
const snapshot: Snapshot = { id: "snapshot-1", local_commit: "a".repeat(40), worktree_generation: "b".repeat(64), draft_generation: null };
const identity: WorkspaceIdentity = { provider: "local", name: "Local", branch: "main", localWorkspaceId: scope.workspace_id };

function action(requiresGesture = false): ActionDescriptor {
  return {
    plugin_id: pluginId, action_id: actionId, schema_version: 1, effect: "read",
    input_schema: { type: "object", additionalProperties: false }, output_schema: true,
    required_capabilities: ["workspace.identity.read"], callers: ["ui", "mcp"],
    requires_user_gesture: requiresGesture,
  };
}

function makeService(descriptor = action()) {
  const calls: Array<{ caller: string; request: ActionRequest }> = [];
  const hostReads: Array<{ scope: Scope; snapshot: Snapshot }> = [];
  let sequence = 0;
  let pins = 0;
  const admitted: VerifiedActionSet = {
    plugin_id: pluginId, version: "1.0.0", manifest_digest: "c".repeat(64), enabled: true,
    activation_epoch: 1, descriptors: [descriptor], dependencies: [], grants: ["workspace.identity.read"],
    host_capabilities: ["workspace.identity.read"],
  };
  const runtime = {
    async invoke(options: { request: ActionRequest; caller: string; resolve_host_call(call: {
      call_id: string; operation: string; payload: Record<string, unknown>;
    }): Promise<unknown> }): Promise<ActionResult> {
      calls.push({ caller: options.caller, request: options.request });
      const value = await options.resolve_host_call({ call_id: `${options.request.request_id}:identity`,
        operation: "workspace.identity.read", payload: { paths: [] } });
      return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
        ok: true, value, warnings: [] };
    },
  };
  const manager = {
    installed: async () => [],
    verifiedActionSet: async (id: string) => id === pluginId ? admitted : undefined,
    authoringRuntime: () => runtime,
  } as unknown as ConstructorParameters<typeof BrowserAuthoringService>[0]["manager"];
  const git = {
    pinAuthoringSnapshot: async () => { pins++; return { snapshot_id: snapshot.id, local_commit: snapshot.local_commit,
      worktree_generation: snapshot.worktree_generation }; },
    assertAuthoringSnapshot: async (id: string) => { assert.equal(id, snapshot.id); },
    listAuthoringSnapshot: async () => { throw new Error("Lease validation must not fetch unrelated repository files"); },
    releaseAuthoringSnapshot: async () => {},
  } as unknown as BrowserLocalGit;
  const service = new BrowserAuthoringService({
    selectWorkspace: () => ({ git, identity, generation: scope.generation }),
    editorState: () => ({ path: null, dirty: false, draft_generation: null, composing: false }),
    manager,
    idempotency: {
      claim: async () => ({ kind: "owner" }), complete: async () => {}, failBeforeEffects: async () => {},
    },
    gestures: { issue: () => ({}), consume: () => false },
    createRequestId: () => `request-${++sequence}`,
    backends: { identityRead: async context => {
      hostReads.push({ scope: context.scope, snapshot: context.snapshot });
      return { scope: context.scope, snapshot: context.snapshot, device_id: "device-local", legacy_project_ids: [],
        publication: { remote_commit: null, files: [] } };
    } },
  });
  return { service, calls, hostReads, pinCount: () => pins };
}

test("UI background reads and MCP use the same typed Host dispatcher and selected snapshot", async () => {
  const { service, calls, hostReads, pinCount } = makeService();
  const ui = await service.invokeRead(pluginId, actionId, {});
  const mcp = await service.invokeMcp(pluginId, actionId, {}, "gateway-test", "request-mcp");

  assert.equal(ui.ok, true);
  assert.equal(mcp.ok, true);
  assert.deepEqual(calls.map(item => item.caller), ["ui", "mcp"]);
  assert.deepEqual(calls.map(item => item.request.scope), [scope, scope]);
  assert.deepEqual(calls.map(item => item.request.snapshot), [snapshot, snapshot]);
  assert.deepEqual(hostReads.map(item => item.scope), [scope, scope]);
  assert.deepEqual(hostReads.map(item => item.snapshot), [snapshot, snapshot]);
  assert.equal(pinCount(), 1, "unchanged UI/MCP paging retains the exact same snapshot lease");
  assert.equal(service.authority.isSnapshotCurrent({ scope, snapshot } as never), true);
  await service.dispose();
  assert.equal(service.authority.isSnapshotCurrent({ scope, snapshot } as never), false);
});

test("a synthetic UI event never satisfies a signed action gesture requirement", async () => {
  const { service, calls } = makeService(action(true));
  const result = await service.invokeUi(new Event("click"), pluginId, actionId, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "capability_denied");
  assert.equal(calls.length, 0);
  await service.dispose();
});

test("production action idempotency fails closed when durable IndexedDB is unavailable", async () => {
  if (typeof indexedDB !== "undefined") return;
  const store = new IndexedDbActionIdempotencyStore("authoring-service-test-unavailable");
  await assert.rejects(store.claim({ workspace_id: scope.workspace_id, plugin_id: pluginId,
    action_id: actionId, key: "stable-key" }, "d".repeat(64)), error =>
    (error as { code?: string }).code === "storage_unknown");
});

 test("navigation continuation rejects a synthetic gesture before guest execution", async () => {
  const { service, calls } = makeService();
  await assert.rejects(service.invokeUi(new Event("click"), pluginId, actionId, {}, true),
    error => (error as { code?: string }).code === "capability_denied");
  assert.equal(calls.length, 0);
  await service.dispose();
});

test("concurrent first callers share one paging snapshot", async () => {
  const { service, pinCount } = makeService();
  const principal = (request_id: string) => ({ caller: "mcp" as const, actor_id: "gateway", request_id, selected_scope: scope });
  const [first, second] = await Promise.all([
    service.authority.issue(principal("request-one"), pluginId, actionId),
    service.authority.issue(principal("request-two"), pluginId, actionId),
  ]);
  assert.equal(pinCount(), 1);
  assert.deepEqual(first.snapshot, second.snapshot);
  await service.dispose();
});

 test("UI proposal envelopes get a Host key without changing a closed action input", async () => {
  const { service, calls } = makeService({ ...action(), effect: "propose" });
  const result = await service.invokeUi(new Event("click"), pluginId, actionId, {});
  assert.equal(result.ok, true);
  assert.ok(calls[0]?.request.idempotency_key);
  assert.deepEqual(calls[0]?.request.input, {});
  await service.dispose();
});
