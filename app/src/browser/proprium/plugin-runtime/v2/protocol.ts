import type { ActionRequest, ActionResult, ActionError } from "../../authoring/types.js";
import { capabilityForHostOperation } from "../../authoring/capabilities.js";
export { capabilityForHostOperation };

export const V2_PLUGIN_HOST_IMPORT = "proprium:plugin/host@2.0.0";
export const V2_PLUGIN_GUEST_EXPORT = "proprium:plugin/guest@2.0.0";
export const V2_PLUGIN_ABI = "proprium.component/v2";

export const V2_LIMITS = Object.freeze({
  componentBytes: 128 * 1024 * 1024,
  generatedBytes: 192 * 1024 * 1024,
  actionBytes: 1024 * 1024,
  hostCallBytes: 1024 * 1024,
  actionResultBytes: 1024 * 1024,
  hostCalls: 4096,
  workerCount: 4,
  interactiveDeadlineMs: 30_000,
  batchDeadlineMs: 120_000,
  stopDeadlineMs: 1_000,
});

export type V2Grant = string;
export interface V2Context {
  readonly pluginId: string;
  readonly version: string;
  readonly workspaceId: string;
}
export interface V2Envelope {
  readonly id: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly pluginId: string;
  readonly version: string;
  readonly digest: string;
  readonly workspaceId: string;
  readonly deadlineAt: number;
  readonly grants: readonly V2Grant[];
}
export type V2WorkerRequest =
  | (V2Envelope & { readonly type: "start"; readonly context: V2Context; readonly component: Uint8Array })
  | (V2Envelope & { readonly type: "invoke"; readonly action: ActionRequest; readonly request: string })
  | (V2Envelope & { readonly type: "resume"; readonly actionRequestId: string; readonly callId: string; readonly sequence: number; readonly response: V2HostResponse })
  | (V2Envelope & { readonly type: "stop" });

export interface V2HostCall {
  readonly kind: "host_call";
  readonly call_id: string;
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}
export type V2HostResponse = { readonly kind: "host_response"; readonly call_id: string } &
  ({ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ActionError });
export type V2GuestStep = { readonly kind: "host_call"; readonly call: V2HostCall } |
  { readonly kind: "result"; readonly result: ActionResult };

export interface V2WorkerMessage extends V2Envelope {
  readonly type: "ready" | "host_call" | "result" | "stopped" | "error";
  readonly actionRequestId?: string;
  readonly sequence?: number;
  readonly call?: V2HostCall;
  readonly result?: ActionResult;
  readonly error?: { readonly code: V2RuntimeErrorCode; readonly message: string };
}

export type V2RuntimeErrorCode = "untrusted_publisher" | "incompatible_abi" | "capability_denied" |
  "invalid_input" | "snapshot_stale" | "overloaded" | "capacity" | "timeout" | "cancelled" | "guest_trap" |
  "unavailable" | "stopped" | "malformed_message";

export class V2PluginRuntimeError extends Error {
  constructor(readonly code: V2RuntimeErrorCode, message: string) {
    super(message);
    this.name = "V2PluginRuntimeError";
  }
}

export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value: unknown, maxBytes: number, description: string): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new V2PluginRuntimeError("malformed_message", `${description} is not JSON serializable`);
  }
  if (typeof encoded !== "string" || utf8Size(encoded) > maxBytes) {
    throw new V2PluginRuntimeError("invalid_input", `${description} exceeds the byte limit`);
  }
  return encoded;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function safeError(value: unknown): value is ActionError {
  return isRecord(value) && typeof value.code === "string" && value.code.length > 0 && value.code.length <= 96 &&
    typeof value.message === "string" && value.message.length <= 512 && typeof value.retryable === "boolean" &&
    (value.details === undefined || isRecord(value.details)) &&
    (value.details === undefined ? exactKeys(value, ["code", "message", "retryable"]) : exactKeys(value, ["code", "message", "retryable", "details"]));
}

export function assertActionRequest(value: unknown, pluginId: string, workspaceId: string): asserts value is ActionRequest {
  if (!isRecord(value) || value.schema_version !== 1 || typeof value.request_id !== "string" ||
      value.request_id.length < 1 || value.request_id.length > 128 || value.plugin_id !== pluginId ||
      typeof value.action_id !== "string" || !/^[a-z][a-z0-9-]{0,62}(?:\.[a-z][a-z0-9-]{0,62}){1,5}$/u.test(value.action_id) ||
      !isRecord(value.input) || !isRecord(value.scope) || value.scope.workspace_id !== workspaceId || workspaceId.length < 1 || workspaceId.length > 256 ||
      typeof value.scope.branch !== "string" || value.scope.branch.length > 256 ||
      typeof value.scope.generation !== "string" || value.scope.generation.length < 1 || value.scope.generation.length > 256 ||
      !(value.scope.repository_id === null || (Number.isSafeInteger(value.scope.repository_id) && (value.scope.repository_id as number) > 0)) ||
      !isRecord(value.snapshot) || typeof value.snapshot.id !== "string" || value.snapshot.id.length < 1 || value.snapshot.id.length > 256 ||
      typeof value.snapshot.worktree_generation !== "string" || value.snapshot.worktree_generation.length < 1 || value.snapshot.worktree_generation.length > 256 ||
      !(value.snapshot.local_commit === null || (typeof value.snapshot.local_commit === "string" && value.snapshot.local_commit.length <= 256)) ||
      !(value.snapshot.draft_generation === null || (typeof value.snapshot.draft_generation === "string" && value.snapshot.draft_generation.length <= 256)) ||
      (value.snapshot.remote_commit !== undefined && !(value.snapshot.remote_commit === null || typeof value.snapshot.remote_commit === "string")) ||
      !Number.isSafeInteger(value.deadline_ms) ||
      (value.deadline_ms as number) < 1 || (value.deadline_ms as number) > V2_LIMITS.batchDeadlineMs) {
    throw new V2PluginRuntimeError("invalid_input", "Authoring ActionRequest is malformed or belongs to another plugin/workspace");
  }
}

export function decodeGuestStep(raw: unknown, request: ActionRequest, nextSequence: number): V2GuestStep {
  if (typeof raw !== "string" || utf8Size(raw) > V2_LIMITS.actionResultBytes) {
    throw new V2PluginRuntimeError("invalid_input", "Guest result exceeds the action limit");
  }
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new V2PluginRuntimeError("malformed_message", "Guest returned invalid JSON"); }
  if (!isRecord(value)) throw new V2PluginRuntimeError("malformed_message", "Guest returned an invalid envelope");
  if (value.kind === "host_call") {
    if (!exactKeys(value, ["kind", "call_id", "operation", "payload"]) ||
        value.call_id !== `${request.request_id}:${nextSequence}` || typeof value.operation !== "string" ||
        value.operation.length < 1 || value.operation.length > 256 || !isRecord(value.payload) ||
        utf8Size(raw) > V2_LIMITS.hostCallBytes) {
      throw new V2PluginRuntimeError("malformed_message", "Guest yielded an invalid or out-of-order Host call");
    }
    return { kind: "host_call", call: value as unknown as V2HostCall };
  }
  if (value.request_id !== request.request_id || !isRecord(value.scope) || !isRecord(value.snapshot) ||
      canonicalJson(value.scope) !== canonicalJson(request.scope) ||
      canonicalJson(value.snapshot) !== canonicalJson(request.snapshot) || typeof value.ok !== "boolean") {
    throw new V2PluginRuntimeError("malformed_message", "Guest result changed the request identity, scope, or snapshot");
  }
  if (value.ok === true) {
    if (!exactKeys(value, ["request_id", "scope", "snapshot", "ok", "value", "warnings"]) || !Array.isArray(value.warnings) ||
        value.warnings.length > 256 || value.warnings.some(item => typeof item !== "string" || item.length > 1024)) {
      throw new V2PluginRuntimeError("malformed_message", "Guest success result is malformed");
    }
  } else if (!exactKeys(value, ["request_id", "scope", "snapshot", "ok", "error"]) || !safeError(value.error)) {
    throw new V2PluginRuntimeError("malformed_message", "Guest error result is malformed");
  }
  return { kind: "result", result: value as unknown as ActionResult };
}

export function encodeHostResponse(callId: string, result: unknown): string {
  if (result === undefined) throw new V2PluginRuntimeError("malformed_message", "Host operation returned no JSON value");
  const value: V2HostResponse = { kind: "host_response", call_id: callId, ok: true, value: result };
  return jsonBytes(value, V2_LIMITS.hostCallBytes, "Host response");
}

/** Stable comparison for JSON scope/snapshot envelopes independent of key order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function validateHostResponse(raw: unknown, callId: string): asserts raw is V2HostResponse {
  if (!isRecord(raw) || raw.kind !== "host_response" || raw.call_id !== callId || typeof raw.ok !== "boolean" ||
      (raw.ok === true && !exactKeys(raw, ["kind", "call_id", "ok", "value"])) ||
      (raw.ok === false && (!exactKeys(raw, ["kind", "call_id", "ok", "error"]) || !safeError(raw.error)))) {
    throw new V2PluginRuntimeError("malformed_message", "Host continuation does not match the pending guest call");
  }
}

export function assertEnvelope(message: unknown, expected: V2Envelope): asserts message is V2Envelope & { type: string } {
  if (!isRecord(message) || message.id !== expected.id || message.sessionId !== expected.sessionId ||
      message.epoch !== expected.epoch || message.pluginId !== expected.pluginId || message.version !== expected.version ||
      message.digest !== expected.digest || message.workspaceId !== expected.workspaceId ||
      message.deadlineAt !== expected.deadlineAt || canonicalJson(message.grants) !== canonicalJson(expected.grants)) {
    throw new V2PluginRuntimeError("malformed_message", "Worker message has stale or mismatched identity");
  }
}

export function assertDeadline(deadlineAt: number): void {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) {
    throw new V2PluginRuntimeError("timeout", "Authoring action exceeded its deadline");
  }
}

