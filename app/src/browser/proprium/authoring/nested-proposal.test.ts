import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthoringActionDispatcher, type InvocationContext, type VerifiedActionSet } from './actions.js';
import type { ActionDescriptor, ActionRequest, Scope, Snapshot } from './types.js';

const scope: Scope = { workspace_id: 'local-work', repository_id: 42, branch: 'main', generation: 'g1' };
const snapshot: Snapshot = { id: 'snap-1', local_commit: 'c1', worktree_generation: 'g1', draft_generation: null };
const parent = 'proprium.research', child = 'proprium.narrative';
const parentAction = 'proprium.research.propose', childAction = 'proprium.narrative.propose';
const invoke = 'workspace.plugin.invoke';
const shape = { type: 'object', properties: { query: { type: 'string', maxLength: 4096 } }, required: ['query'], additionalProperties: false };
const output = { type: 'object', properties: { hits: { type: 'integer' } }, required: ['hits'], additionalProperties: false };
function descriptor(plugin_id: string, action_id: string, effect: 'read' | 'propose'): ActionDescriptor {
 return { plugin_id, action_id, effect, schema_version: 1, input_schema: shape, output_schema: output,
  required_capabilities: plugin_id === parent ? [invoke] : [], callers: ['ui', 'plugin'], requires_user_gesture: false };
}
function installed(plugin_id: string, descriptors: ActionDescriptor[]): VerifiedActionSet {
 return { plugin_id, version: '1.0.0', manifest_digest: 'a'.repeat(64), enabled: true, activation_epoch: 1,
  descriptors, dependencies: plugin_id === parent ? [child] : [], grants: [invoke], host_capabilities: [invoke] };
}
function harness(parentEffect: 'read' | 'propose' = 'propose', failParent = false) {
 const childRequests: ActionRequest[] = [], failed: string[] = [];
 let targetAction = childAction;
 const entries = new Map([[parent, installed(parent, [descriptor(parent, parentAction, parentEffect), descriptor(parent, 'proprium.research.other', parentEffect)])],
  [child, installed(child, [descriptor(child, childAction, 'propose'), descriptor(child, 'proprium.narrative.other', 'propose')])]]);
 const context = (request_id: string, caller: 'ui' | 'plugin', caller_plugin_id?: string): InvocationContext => ({
  caller, actor_id: 'author', scope, snapshot, request_id, deadline_at: 80_000, user_gesture_verified: caller === 'ui', activation_epoch: 1,
  grants: [invoke], host_capabilities: [invoke], signal: new AbortController().signal, call_stack: [], ...(caller_plugin_id ? { caller_plugin_id } : {}) });
 const dispatcher = new AuthoringActionDispatcher({
  installed: async id => entries.get(id),
  authority: { issue: async p => context(p.request_id, 'ui'), issueChild: async (p, source) => ({ ...context(p.request_id + '-child', 'plugin', source), signal: p.signal }),
   assertCurrent: async () => {}, isSnapshotCurrent: () => true },
  idempotency: { claim: async () => ({ kind: 'owner' }), complete: async () => {}, failBeforeEffects: async key => { failed.push(key.plugin_id); } },
  capabilities: {}, now: () => 50_000,
  runtime: { invoke: async options => {
   const request = options.request;
   if (request.plugin_id === child) { childRequests.push(request); return { request_id: request.request_id, scope, snapshot, ok: true, value: { hits: 1 }, warnings: [] }; }
   await options.resolve_host_call({ call_id: request.request_id + ':1', operation: invoke,
    payload: { plugin_id: child, action_id: targetAction,
     input: { query: request.input.query } } });
   return failParent ? { request_id: request.request_id, scope, snapshot, ok: false, error: { code: 'guest_trap', message: 'after child', retryable: false } }
    : { request_id: request.request_id, scope, snapshot, ok: true, value: { hits: 1 }, warnings: [] };
  } },
 });
 const call = (query: string, key = 'parent-key', action = parentAction, requestId = 'r1') => dispatcher.invoke({ plugin_id: parent, action_id: action, input: { query }, ...(parentEffect === 'propose' ? { idempotency_key: key } : {}) },
  { caller: 'ui', actor_id: 'author', selected_scope: scope, request_id: requestId, user_gesture_token: {} });
 return { call, childRequests, failed, setTarget: (action: string) => { targetAction = action; } };
}

test('dependent proposal gets a deterministic parent-bound key unique to action and input', async () => {
 const h = harness();
 for (const [query, key, action, id] of [['x', 'key-a', parentAction, 'r1'], ['x', 'key-a', parentAction, 'r2'], ['x', 'key-b', parentAction, 'r3'], ['y', 'key-a', parentAction, 'r4'], ['x', 'key-a', 'proprium.research.other', 'r5']]) {
  const result = await h.call(query!, key!, action!, id!); assert.equal(result.ok, true, JSON.stringify(result));
 }
 h.setTarget('proprium.narrative.other');
 assert.equal((await h.call('x', 'key-a', parentAction, 'r6')).ok, true);
 const keys = h.childRequests.map(request => request.idempotency_key);
 assert.match(keys[0]!, /^[a-f0-9]{64}$/u);
 assert.equal(keys[0], keys[1]);
 assert.equal(new Set([keys[0], ...keys.slice(2)]).size, 5);
});

test('read action cannot delegate a proposal', async () => {
 const h = harness('read'); const result = await h.call('x');
 assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'capability_denied');
 assert.equal(h.childRequests.length, 0);
});

test('parent failure after a successful nested proposal remains unresolved and is not cleared before effects', async () => {
 const h = harness('propose', true); const result = await h.call('x');
 assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'external_state_unknown');
 assert.equal(h.childRequests.length, 1);
 assert.equal(h.failed.includes(parent), false);
});
