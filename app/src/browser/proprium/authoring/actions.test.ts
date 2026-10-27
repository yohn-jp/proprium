import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionDispatchError, AuthoringActionDispatcher, type ActionDispatcherOptions, type ActionRuntime,
  type InvocationContext, type VerifiedActionSet,
} from "./actions.js";
import type { ActionDescriptor, ActionRequest, ActionResult, Scope, Snapshot } from "./types.js";

const scope: Scope = { workspace_id: "local-work", repository_id: 42, branch: "main", generation: "g1" };
const snapshot: Snapshot = { id: "snap-1", local_commit: "c1", worktree_generation: "g1", draft_generation: null };
const plugin_id = "proprium.research";
const action_id = "proprium.research.query";
const cap = "workspace.file.read";
let clock = 50_000;
let requestCount = 0;

function descriptor(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return {
    plugin_id, action_id, schema_version: 1, effect: "read",
    input_schema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["query"], additionalProperties: false },
    output_schema: { type: "object", properties: { hits: { type: "integer" } }, required: ["hits"], additionalProperties: false },
    required_capabilities: [cap], callers: ["ui", "mcp", "plugin"], requires_user_gesture: false,
    ...overrides,
  };
}
function installed(overrides: Partial<VerifiedActionSet> = {}): VerifiedActionSet {
  return {
    plugin_id, version: "1.2.3", manifest_digest: "a".repeat(64), enabled: true, activation_epoch: 1,
    descriptors: [descriptor()], dependencies: [], grants: [cap], host_capabilities: [cap], ...overrides,
  };
}
function principal(caller: "ui" | "mcp" = "ui", id = "request-1") {
  return { caller, actor_id: "author", selected_scope: scope, request_id: id, user_gesture_token: caller === "ui" ? {} : undefined } as const;
}
function context(p = principal(), overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    caller: p.caller, actor_id: p.actor_id, scope, snapshot, request_id: p.request_id,
    deadline_at: clock + 30_000, user_gesture_verified: p.caller === "ui", activation_epoch: 1,
    grants: [cap], host_capabilities: [cap], signal: new AbortController().signal, call_stack: [],
    ...overrides,
  };
}
function createHarness(overrides: Partial<ActionDispatcherOptions> = {}) {
  const entries = new Map<string, VerifiedActionSet>([[plugin_id, installed()]]);
  const executed: ActionRequest[] = [];
  const hostCalls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const runtime: ActionRuntime = {
    async invoke(options) {
      executed.push(options.request);
      const value = await options.resolve_host_call({ call_id: options.request.request_id + ":1",
        operation: "workspace.file.list", payload: { snapshot: options.request.snapshot, prefix: "manuscript/", cursor: null } });
      return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
        ok: true, value: { hits: (value as { entries: unknown[] }).entries.length }, warnings: [] };
    },
  };
  const defaults: ActionDispatcherOptions = {
    installed: async id => entries.get(id),
    authority: {
      issue: async (p, _plugin, _action) => context(p),
      issueChild: async (parent, caller_plugin_id, _target, _action) =>
        context(principal("ui", parent.request_id + "-child"), { caller: "plugin", caller_plugin_id,
          user_gesture_verified: false, grants: [cap], host_capabilities: [cap], signal: parent.signal }),
      assertCurrent: async () => {},
      isSnapshotCurrent: () => true,
    },
    runtime,
    capabilities: {
      fileList: async (payload, ctx) => {
        hostCalls.push({ operation: "workspace.file.list", payload });
        assert.deepEqual(payload.scope, ctx.scope);
        return { entries: [{ path: "manuscript/a.md", revision: "h1", byte_length: 8, media_type: "text/markdown" }], next_cursor: null };
      },
    },
    idempotency: {
      claim: async () => ({ kind: "owner" }),
      complete: async () => {},
      failBeforeEffects: async () => {},
    },
    randomId: () => "cursor-" + (++requestCount),
    now: () => clock,
  };
  return { dispatcher: new AuthoringActionDispatcher({ ...defaults, ...overrides }), entries, executed, hostCalls };
}

test("metadata paging returns signed action descriptors without invoking a plugin Worker", async () => {
  const { dispatcher, executed } = createHarness({
    installed: async () => installed({ descriptors: [
      descriptor({ action_id: "proprium.research.query" }),
      descriptor({ action_id: "proprium.research.terms.list" }),
    ] }),
  });
  const first = await dispatcher.list({ plugin_id, limit: 1 }, principal("mcp"));
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]?.availability, "ready");
  assert.ok(first.next_cursor);
  assert.equal(executed.length, 0);
  const second = await dispatcher.list({ plugin_id, limit: 1, cursor: first.next_cursor! }, principal("mcp"));
  assert.equal(second.items.length, 1);
  assert.equal(second.next_cursor, null);
});

test("UI and MCP invoke the same typed action with Host-issued scope and pinned revision", async () => {
  const { dispatcher, executed, hostCalls } = createHarness();
  const ui = await dispatcher.invoke({ plugin_id, action_id, input: { query: "星" } }, principal("ui"));
  const mcp = await dispatcher.invoke({ plugin_id, action_id, input: { query: "星" } }, principal("mcp", "request-2"));
  assert.equal(ui.ok, true);
  assert.equal(mcp.ok, true);
  assert.equal(executed.length, 2);
  assert.deepEqual(executed[0]?.scope, scope);
  assert.deepEqual(executed[1]?.scope, scope);
  assert.deepEqual(executed[0]?.snapshot, snapshot);
  assert.deepEqual(executed[1]?.snapshot, snapshot);
  assert.equal(hostCalls.length, 2);
  assert.deepEqual(hostCalls[0]?.payload.scope, scope);
});

test("canonical camel-case action identifiers are admitted and dispatched", async () => {
  const canonicalId = "speaker.ruleGates";
  const action = descriptor({ action_id: canonicalId });
  const h = createHarness({ installed: async () => installed({ descriptors: [action] }) });
  const result = await h.dispatcher.invoke({ plugin_id, action_id: canonicalId, input: { query: "x" } }, principal());
  assert.equal(result.ok, true);
  assert.equal(h.executed.length, 1);
});

test("receipt reads use their exact read capability, independently of proposal permission", async () => {
  const operation = "workspace.change.list";
  const readAction = descriptor({ action_id: "proprium.research.receipts", required_capabilities: [operation] });
  const runtime: ActionRuntime = { invoke: async options => {
    const value = await options.resolve_host_call({ call_id: "receipt:1", operation, payload: { limit: 10 } });
    return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
      ok: true, value: { hits: (value as { items: unknown[] }).items.length }, warnings: [] };
  } };
  let readCalls = 0;
  const exact = createHarness({
    installed: async () => installed({ descriptors: [readAction], grants: [operation], host_capabilities: [operation] }), runtime,
    capabilities: { proposalList: async payload => { readCalls++; assert.deepEqual(payload.scope, scope); return { items: [], next_cursor: null }; } },
  });
  const allowed = await exact.dispatcher.invoke({ plugin_id, action_id: readAction.action_id, input: { query: "x" } }, principal());
  assert.equal(allowed.ok, true);
  assert.equal(readCalls, 1);

  const proposalOnlyAction = descriptor({ action_id: "proprium.research.receipts", required_capabilities: ["workspace.change.propose"] });
  const proposalOnly = createHarness({
    installed: async () => installed({ descriptors: [proposalOnlyAction], grants: ["workspace.change.propose"], host_capabilities: ["workspace.change.propose"] }),
    runtime, capabilities: { proposalList: async () => { readCalls++; return { items: [], next_cursor: null }; } },
  });
  const denied = await proposalOnly.dispatcher.invoke({ plugin_id, action_id: proposalOnlyAction.action_id, input: { query: "x" } }, principal());
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "capability_denied");
  assert.equal(readCalls, 1);
});

test("optional Host operations use runtime grants without becoming required action capabilities", async () => {
  const assetCapability = "workspace.asset.read";
  const readAction = descriptor({ action_id: "proprium.research.optional", required_capabilities: [cap] });
  const assetRuntime: ActionRuntime = { invoke: async options => {
    const value = await options.resolve_host_call({ call_id: "optional-asset:1", operation: assetCapability,
      payload: { group_id: "semantic-model", file_path: "manifest.json", offset: 0, length: 32 } });
    return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
      ok: true, value: { hits: value ? 1 : 0 }, warnings: [] };
  } };
  const pureRuntime: ActionRuntime = { invoke: async options => {
    const value = await options.resolve_host_call({ call_id: "pure-read:1", operation: "workspace.file.list",
      payload: { snapshot: options.request.snapshot, prefix: "manuscript/" } });
    return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
      ok: true, value: { hits: (value as { entries: unknown[] }).entries.length }, warnings: [] };
  } };
  const pure = createHarness({
    installed: async () => installed({ descriptors: [readAction], grants: [cap], host_capabilities: [cap] }),
    runtime: pureRuntime,
  });
  const pureResult = await pure.dispatcher.invoke({ plugin_id, action_id: readAction.action_id, input: { query: "x" } }, principal());
  assert.equal(pureResult.ok, true);

  const denied = createHarness({
    installed: async () => installed({ descriptors: [readAction], grants: [cap], host_capabilities: [cap] }),
    runtime: assetRuntime,
  });
  const deniedResult = await denied.dispatcher.invoke({ plugin_id, action_id: readAction.action_id, input: { query: "x" } }, principal("ui", "request-no-asset"));
  assert.equal(deniedResult.ok, false);
  if (!deniedResult.ok) assert.equal(deniedResult.error.code, "capability_denied");

  const allowed = createHarness({
    installed: async () => installed({ descriptors: [readAction], grants: [cap, assetCapability], host_capabilities: [cap, assetCapability] }),
    runtime: assetRuntime, capabilities: { assetRead: async () => ({ bytes: [] }) },
  });
  const allowedResult = await allowed.dispatcher.invoke({ plugin_id, action_id: readAction.action_id, input: { query: "x" } }, principal("ui", "request-with-asset"));
  assert.equal(allowedResult.ok, true);

  let proposalCalls = 0;
  const proposalFromRead = createHarness({
    installed: async () => installed({ descriptors: [readAction], grants: [cap, "workspace.change.propose"],
      host_capabilities: [cap, "workspace.change.propose"] }),
    runtime: { invoke: async options => {
      await options.resolve_host_call({ call_id: "read-proposal:1", operation: "workspace.change.propose",
        payload: { changeset: { scope: options.request.scope, snapshot: options.request.snapshot } } });
      return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
        ok: true, value: { hits: 1 }, warnings: [] };
    } },
    capabilities: { propose: async () => { proposalCalls++; return {}; } },
  });
  const proposalResult = await proposalFromRead.dispatcher.invoke({ plugin_id, action_id: readAction.action_id, input: { query: "x" } }, principal("ui", "request-read-proposal"));
  assert.equal(proposalResult.ok, false);
  if (!proposalResult.ok) assert.equal(proposalResult.error.code, "capability_denied");
  assert.equal(proposalCalls, 0);
});

test("foreign file reads require and preserve the Host-selected scoped snapshot lease", async () => {
  const foreignScope: Scope = { workspace_id: "selected-bible", repository_id: 99, branch: "main", generation: "foreign-g1" };
  const foreignSnapshot: Snapshot = { id: "foreign-snapshot-1", local_commit: "fc1", worktree_generation: "foreign-g1", draft_generation: null };
  const operation = "workspace.repository.snapshot.read";
  const readAction = descriptor({ action_id: "proprium.research.foreign", required_capabilities: [cap] });
  const runtime: ActionRuntime = { invoke: async options => {
    const lease = await options.resolve_host_call({ call_id: "foreign-lease:1", operation,
      payload: { workspace_id: foreignScope.workspace_id, repository_id: foreignScope.repository_id!,
        branch: foreignScope.branch, snapshot_id: foreignSnapshot.id } }) as { scope: Scope; snapshot: Snapshot };
    assert.deepEqual(lease, { scope: foreignScope, snapshot: foreignSnapshot });
    const page = await options.resolve_host_call({ call_id: "foreign-list:1", operation: "workspace.file.list",
      payload: { snapshot: lease.snapshot, prefix: "bible/" } });
    return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
      ok: true, value: { hits: (page as { entries: unknown[] }).entries.length }, warnings: [] };
  } };
  let reads = 0;
  const h = createHarness({
    installed: async () => installed({ descriptors: [readAction], grants: [cap, operation], host_capabilities: [cap, operation] }),
    runtime,
    capabilities: {
      repositorySnapshotRead: async payload => {
        assert.deepEqual(payload, { workspace_id: foreignScope.workspace_id, repository_id: foreignScope.repository_id,
          branch: foreignScope.branch, snapshot_id: foreignSnapshot.id });
        return { scope: foreignScope, snapshot: foreignSnapshot };
      },
      fileList: async payload => {
        reads++; assert.deepEqual(payload.scope, foreignScope); assert.deepEqual(payload.snapshot, foreignSnapshot);
        return { entries: [{ path: "bible/entities.yaml" }], next_cursor: null };
      },
    },
  });
  const result = await h.dispatcher.invoke({ plugin_id, action_id: readAction.action_id, input: { query: "x" } }, principal());
  assert.equal(result.ok, true);
  assert.equal(reads, 1);

  const arbitrary = createHarness({
    installed: async () => installed({ descriptors: [readAction], grants: [cap], host_capabilities: [cap] }),
    runtime: { invoke: async options => {
      await options.resolve_host_call({ call_id: "unleased:1", operation: "workspace.file.list",
        payload: { snapshot: foreignSnapshot, prefix: "bible/" } });
      return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
        ok: true, value: { hits: 0 }, warnings: [] };
    } },
    capabilities: { fileList: async () => { reads++; return { entries: [] }; } },
  });
  const rejected = await arbitrary.dispatcher.invoke({ plugin_id, action_id: readAction.action_id, input: { query: "x" } }, principal("ui", "request-unleased"));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "snapshot_stale");
  assert.equal(reads, 1);
});

test("staged file reads require the Host-issued token and retain the original snapshot fields", async () => {
  const pairedPlugin = "proprium.paired-writing";
  const compileAction = descriptor({ plugin_id: pairedPlugin, action_id: "proprium.paired-writing.compile" });
  const stagedSnapshot = { ...snapshot, id: "issued-stage" };
  let validateCalls = 0;
  let fileCalls = 0;
  let releasedInvocation = "";
  const h = createHarness({
    authority: {
      issue: async p => context(p, { staging_snapshot: "issued-stage" }),
      issueChild: async (parent, caller_plugin_id) => context(principal("ui", parent.request_id + "child"), {
        caller: "plugin", caller_plugin_id, staging_snapshot: parent.staging_snapshot,
        grants: [cap], host_capabilities: [cap], signal: parent.signal,
      }),
      assertCurrent: async () => {}, isSnapshotCurrent: () => true,
    },
    runtime: { invoke: async options => {
      const value = await options.resolve_host_call({ call_id: "stage-read:1", operation: "workspace.file.list",
        payload: { snapshot: stagedSnapshot, prefix: "manuscript/" } });
      return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
        ok: true, value: { hits: (value as { entries: unknown[] }).entries.length }, warnings: [] };
    } },
    capabilities: {
      validateStage: async (token, ctx) => { validateCalls++; assert.equal(token, "issued-stage"); assert.ok(ctx.call_stack.length > 0); assert.equal(ctx.invocation_id, "request-1"); },
      releaseInvocation: async ctx => { releasedInvocation = ctx.invocation_id; assert.deepEqual(ctx.scope, scope); },
      fileList: async payload => { fileCalls++; assert.deepEqual(payload.snapshot, stagedSnapshot); return { entries: [], next_cursor: null }; },
    },
  });
  h.entries.set(pairedPlugin, installed({ plugin_id: pairedPlugin, descriptors: [compileAction] }));
  const valid = await h.dispatcher.invoke({ plugin_id: pairedPlugin, action_id: compileAction.action_id, input: { query: "x" } }, principal());
  assert.equal(valid.ok, true);
  assert.equal(validateCalls, 1);
  assert.equal(fileCalls, 1);
  assert.equal(releasedInvocation, "request-1");

  const forged = createHarness({
    authority: {
      issue: async p => context(p, { staging_snapshot: "issued-stage" }),
      issueChild: async (parent, caller_plugin_id) => context(principal("ui", parent.request_id + "child"), {
        caller: "plugin", caller_plugin_id, staging_snapshot: parent.staging_snapshot,
        grants: [cap], host_capabilities: [cap], signal: parent.signal,
      }),
      assertCurrent: async () => {}, isSnapshotCurrent: () => true,
    },
    runtime: { invoke: async options => {
      await options.resolve_host_call({ call_id: "stage-read:2", operation: "workspace.file.list",
        payload: { snapshot: { ...snapshot, id: "forged-stage" }, prefix: "manuscript/" } });
      return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
        ok: true, value: { hits: 0 }, warnings: [] };
    } },
    capabilities: { validateStage: async () => { validateCalls++; }, fileList: async () => { fileCalls++; return { entries: [] }; } },
  });
  forged.entries.set(pairedPlugin, installed({ plugin_id: pairedPlugin, descriptors: [compileAction] }));
  const rejected = await forged.dispatcher.invoke({ plugin_id: pairedPlugin, action_id: compileAction.action_id, input: { query: "x" } }, principal("ui", "request-forged"));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "snapshot_stale");
  assert.equal(validateCalls, 1);
  assert.equal(fileCalls, 1);
});

test("unknown action input fields and missing grants fail before guest execution", async () => {
  const h = createHarness();
  const extra = await h.dispatcher.invoke({ plugin_id, action_id, input: { query: "x", arbitrary: true } }, principal());
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.equal(extra.error.code, "invalid_input");
  h.entries.set(plugin_id, installed({ grants: [], host_capabilities: [] }));
  const denied = await h.dispatcher.invoke({ plugin_id, action_id, input: { query: "x" } }, principal("ui", "request-2"));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "capability_denied");
  assert.equal(h.executed.length, 0);
});

test("disabled and uninstalled plugins have typed unavailable metadata/results", async () => {
  const h = createHarness();
  h.entries.set(plugin_id, installed({ enabled: false }));
  const page = await h.dispatcher.list({ plugin_id }, principal());
  assert.equal(page.items[0]?.availability, "disabled");
  const result = await h.dispatcher.invoke({ plugin_id, action_id, input: { query: "x" } }, principal());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "plugin_unavailable");
  const missing = await h.dispatcher.invoke({ plugin_id: "proprium.missing", action_id, input: { query: "x" } }, principal());
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "plugin_unavailable");
});

test("navigation from MCP and Host-only apply operations are denied", async () => {
  const navigation = descriptor({ action_id: "proprium.research.open", required_capabilities: ["workspace.navigation"] });
  let called = false;
  const h = createHarness({ installed: async () => installed({ descriptors: [navigation], grants: ["workspace.navigation"],
    host_capabilities: ["workspace.navigation"] }),
    runtime: { invoke: async options => {
      called = true;
      await options.resolve_host_call({ call_id: "n:1", operation: "workspace.navigation", payload: { target: { path: "manuscript/a.md" } } });
      return { request_id: options.request.request_id, scope: scope, snapshot, ok: true, value: { hits: 1 }, warnings: [] };
    } },
  });
  const result = await h.dispatcher.invoke({ plugin_id, action_id: navigation.action_id, input: { query: "x" } }, principal("mcp"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "capability_denied");
  assert.equal(called, true);
  const apply = await h.dispatcher.invoke({ plugin_id, action_id: "workspace.change.apply", input: {} }, principal());
  assert.equal(apply.ok, false);
});

test("proposal idempotency binds scope, plugin, action, key, snapshot and canonical payload", async () => {
  const proposed = descriptor({ action_id: "proprium.research.terms.propose", effect: "propose",
    required_capabilities: ["workspace.change.propose"] });
  const seen = new Map<string, { digest: string; result?: ActionResult }>();
  let runtimeCount = 0;
  const h = createHarness({
    installed: async () => installed({ descriptors: [proposed], grants: ["workspace.change.propose"],
      host_capabilities: ["workspace.change.propose"] }),
    idempotency: {
      claim: async (key, request_digest) => {
        const id = [key.workspace_id, key.plugin_id, key.action_id, key.key].join("/");
        const found = seen.get(id);
        if (found) return found.digest !== request_digest ? { kind: "conflict" } :
          found.result ? { kind: "completed", result: found.result } : { kind: "pending" };
        seen.set(id, { digest: request_digest });
        return { kind: "owner" };
      },
      complete: async (key, request_digest, result) => seen.set([key.workspace_id, key.plugin_id, key.action_id, key.key].join("/"), { digest: request_digest, result }),
      failBeforeEffects: async () => {},
    },
    runtime: { invoke: async options => {
      runtimeCount++;
      const result = await options.resolve_host_call({ call_id: "p:1", operation: "workspace.change.propose",
        payload: { changeset: { scope: options.request.scope, snapshot: options.request.snapshot } } });
      return { request_id: options.request.request_id, scope: options.request.scope, snapshot: options.request.snapshot,
        ok: true, value: { hits: result ? 1 : 0 }, warnings: [] };
    } },
    capabilities: { propose: async () => ({ proposal_id: "p1", status: "proposed", preview: {} }) },
  });
  const key = "stable-proposal-key";
  const first = await h.dispatcher.invoke({ plugin_id, action_id: proposed.action_id, input: { query: "x" }, idempotency_key: key }, principal());
  const retry = await h.dispatcher.invoke({ plugin_id, action_id: proposed.action_id, input: { query: "x" }, idempotency_key: key }, principal("ui", "request-retry"));
  const conflict = await h.dispatcher.invoke({ plugin_id, action_id: proposed.action_id, input: { query: "y" }, idempotency_key: key }, principal("ui", "request-conflict"));
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.request_id, "request-retry");
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "idempotency_conflict");
  assert.equal(runtimeCount, 1);
});

test("stale snapshots prevent all Host capability operations", async () => {
  let fileReads = 0;
  const h = createHarness({ authority: {
    issue: async p => context(p),
    issueChild: async (parent, caller_plugin_id) => context(principal("ui", parent.request_id + "child"), {
      caller: "plugin", caller_plugin_id, grants: [cap], host_capabilities: [cap], signal: parent.signal,
    }),
    assertCurrent: async () => { throw new ActionDispatchError("snapshot_stale", "Stale worktree"); },
    isSnapshotCurrent: () => false,
  }, capabilities: { fileList: async () => { fileReads++; return { entries: [] }; } } });
  const result = await h.dispatcher.invoke({ plugin_id, action_id, input: { query: "x" } }, principal());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "snapshot_stale");
  assert.equal(fileReads, 0);
});
