import { $init as initializeJco, generate } from "@bytecodealliance/jco-transpile/component";
import {
  assertActionRequest, assertDeadline, canonicalJson, decodeGuestStep, isRecord, V2_LIMITS,
  V2_PLUGIN_GUEST_EXPORT, V2_PLUGIN_HOST_IMPORT, V2PluginRuntimeError, utf8Size, validateHostResponse,
  type V2Envelope, type V2HostResponse, type V2WorkerMessage, type V2WorkerRequest,
} from "./protocol.js";
import type { ActionRequest } from "../../authoring/types.js";

interface ComponentGuest {
  initialize(context: { pluginId: string; version: string; workspaceId: string }): void | Promise<void>;
  invoke(request: string): string | Promise<string>;
  dispose(): void | Promise<void>;
}

const scope = self as DedicatedWorkerGlobalScope;
const hostFailureKey = Symbol.for("proprium.plugin.worker.v2.host-failure");
const hostModule = `
export const request = (operation, payload) => {
  const failure = Object.assign(new Error("Direct synchronous Host calls are unavailable in the v2 continuation ABI"), {code: "capability_denied"});
  globalThis[Symbol.for("proprium.plugin.worker.v2.host-failure")] = failure;
  return {tag: "err", val: failure.code};
};
`;

let guest: ComponentGuest | undefined;
let active: V2Envelope | undefined;
let activeAction: ActionRequest | undefined;
let actionRequestId: string | undefined;
let nextSequence = 0;
let pendingCallId: string | undefined;
let running = false;
let initialized = false;
let activationEpoch = 0;
let activePluginId = "";
let activeVersion = "";
let activeWorkspaceId = "";
let activeSessionId = "";
let activeDigest = "";
let activeGrants: readonly string[] = [];

scope.addEventListener("message", event => { void handle(event.data as V2WorkerRequest); });

async function handle(request: V2WorkerRequest): Promise<void> {
  if (!validEnvelope(request)) return;
  try {
    if (request.type === "start") await start(request);
    else if (request.type === "invoke") await invoke(request);
    else if (request.type === "resume") await resume(request);
    else if (request.type === "stop") await stop(request);
    else sendError(request, { code: "malformed_message", message: "Unknown plugin operation" });
  } catch (error) {
    if (request.type === "start" && request.component instanceof Uint8Array) request.component.fill(0);
    sendError(request, runtimeError(error));
    if (request.type !== "stop") resetInvocation();
  }
}

function validEnvelope(request: unknown): request is V2WorkerRequest {
  if (!isRecord(request) || !["start", "invoke", "resume", "stop"].includes(request.type as string) ||
      typeof request.id !== "string" || request.id.length < 1 || request.id.length > 128 ||
      typeof request.sessionId !== "string" || request.sessionId.length < 1 || request.sessionId.length > 128 ||
      !Number.isSafeInteger(request.epoch) || (request.epoch as number) < 1 ||
      typeof request.pluginId !== "string" || request.pluginId.length < 1 || request.pluginId.length > 128 ||
      typeof request.version !== "string" || request.version.length < 1 || request.version.length > 128 ||
      typeof request.digest !== "string" || !/^[a-f0-9]{64}$/u.test(request.digest) ||
      typeof request.workspaceId !== "string" || request.workspaceId.length < 1 || request.workspaceId.length > 256 ||
      !Array.isArray(request.grants) || request.grants.length > 128 || request.grants.some(item => typeof item !== "string" || item.length > 128) ||
      !Number.isSafeInteger(request.deadlineAt) || (request.deadlineAt as number) <= Date.now()) return false;
  const common = ["type", "id", "sessionId", "epoch", "pluginId", "version", "digest", "workspaceId", "deadlineAt", "grants"];
  const extra = request.type === "start" ? ["context", "component"]
    : request.type === "invoke" ? ["action", "request"]
      : request.type === "resume" ? ["actionRequestId", "callId", "sequence", "response"] : [];
  const allowed = new Set([...common, ...extra]);
  if (Object.keys(request).length !== allowed.size || Object.keys(request).some(key => !allowed.has(key))) return false;
  if (request.type !== "start" && initialized && !sameInstance(request as unknown as V2Envelope)) return false;
  return true;
}

function sameInstance(request: V2Envelope): boolean {
  return request.sessionId === activeSessionId && request.epoch === activationEpoch && request.pluginId === activePluginId && request.version === activeVersion &&
    request.workspaceId === activeWorkspaceId && request.digest === activeDigest &&
    request.grants.length === activeGrants.length && request.grants.every((grant, index) => grant === activeGrants[index]);
}

async function start(request: Extract<V2WorkerRequest, { type: "start" }>): Promise<void> {
  if (initialized || request.component.byteLength === 0 || request.component.byteLength > V2_LIMITS.componentBytes ||
      request.context.pluginId !== request.pluginId || request.context.version !== request.version ||
      request.context.workspaceId !== request.workspaceId || request.deadlineAt <= Date.now() ||
      await digest(request.component) !== request.digest) {
    throw new V2PluginRuntimeError("invalid_input", "Plugin activation request or Component digest is invalid");
  }
  activePluginId = request.pluginId;
  activeVersion = request.version;
  activeWorkspaceId = request.workspaceId;
  activeSessionId = request.sessionId;
  activeDigest = request.digest;
  activationEpoch = request.epoch;
  activeGrants = Object.freeze([...request.grants]);
  const hostUrl = URL.createObjectURL(new Blob([hostModule], { type: "text/javascript" }));
  try {
    await initializeJco;
    let generated: ReturnType<typeof generate>;
    try {
      generated = generate(request.component, {
        name: `proprium_plugin_v2_${activationEpoch}`,
        noTypescript: true,
        noNodejsCompat: true,
        base64Cutoff: V2_LIMITS.generatedBytes,
        importBindings: { tag: "js" },
        map: [[V2_PLUGIN_HOST_IMPORT, hostUrl]],
      });
    } finally {
      request.component.fill(0);
    }
    const imports = [...new Set(generated.imports)];
    const exports = generated.exports.filter(([name]) => name !== "guest");
    if (imports.length !== 1 || imports[0] !== hostUrl || exports.length !== 1 ||
        exports[0]?.[0] !== V2_PLUGIN_GUEST_EXPORT || exports[0]?.[1] !== "instance") {
      throw new V2PluginRuntimeError("incompatible_abi", "Component imports or exports do not match the Proprium v2 WIT world");
    }
    if (generated.files.length !== 1 || generated.files[0]?.[0] !== `proprium_plugin_v2_${activationEpoch}.js` ||
        generated.files[0][1].byteLength > V2_LIMITS.generatedBytes) {
      throw new V2PluginRuntimeError("invalid_input", "Component transform produced external or excessive runtime files");
    }
    const generatedBytes = generated.files[0][1].slice();
    const generatedUrl = URL.createObjectURL(new Blob([generatedBytes.buffer as ArrayBuffer], { type: "text/javascript" }));
    try {
      const module = await import(/* @vite-ignore */ generatedUrl) as { guest?: ComponentGuest };
      if (!module.guest || typeof module.guest.initialize !== "function" || typeof module.guest.invoke !== "function" ||
          typeof module.guest.dispose !== "function") {
        throw new V2PluginRuntimeError("incompatible_abi", "Component guest does not implement the v2 lifecycle");
      }
      guest = module.guest;
      await guest.initialize(request.context);
      initialized = true;
    } finally {
      URL.revokeObjectURL(generatedUrl);
    }
  } finally {
    URL.revokeObjectURL(hostUrl);
  }
  send(request, "ready");
}

async function invoke(request: Extract<V2WorkerRequest, { type: "invoke" }>): Promise<void> {
  if (!initialized || !guest || running || pendingCallId) throw new V2PluginRuntimeError("overloaded", "A v2 plugin action is already active or unavailable");
  if (request.action.plugin_id !== activePluginId || request.action.scope.workspace_id !== activeWorkspaceId) {
    throw new V2PluginRuntimeError("invalid_input", "Action identity does not match the active plugin workspace");
  }
  assertActionRequest(request.action, activePluginId, activeWorkspaceId);
  if (typeof request.request !== "string" || utf8Size(request.request) > V2_LIMITS.actionBytes) {
    throw new V2PluginRuntimeError("invalid_input", "Action request exceeds its byte limit");
  }
  const encoded = JSON.stringify(request.action);
  if (canonicalJson(JSON.parse(request.request) as unknown) !== canonicalJson(request.action)) {
    throw new V2PluginRuntimeError("invalid_input", "Action bytes differ from the typed request envelope");
  }
  active = request;
  activeAction = request.action;
  actionRequestId = request.action.request_id;
  nextSequence = 0;
  pendingCallId = undefined;
  running = true;
  await runStep(request.request);
}

async function resume(request: Extract<V2WorkerRequest, { type: "resume" }>): Promise<void> {
  if (!running || !guest || !active || !activeAction || request.id !== active.id ||
      request.actionRequestId !== actionRequestId || !pendingCallId || request.callId !== pendingCallId ||
      request.sequence !== nextSequence) {
    throw new V2PluginRuntimeError("malformed_message", "Host continuation is stale or does not match the pending call");
  }
  validateHostResponse(request.response, pendingCallId);
  const serialized = JSON.stringify(request.response);
  if (utf8Size(serialized) > V2_LIMITS.hostCallBytes) throw new V2PluginRuntimeError("invalid_input", "Host continuation exceeds its byte limit");
  pendingCallId = undefined;
  await runStep(serialized);
}

async function runStep(input: string): Promise<void> {
  if (!active || !activeAction || !guest || !running || !actionRequestId) {
    throw new V2PluginRuntimeError("stopped", "Plugin action is no longer active");
  }
  assertDeadline(active.deadlineAt);
  const failureKey = hostFailureKey;
  (globalThis as Record<PropertyKey, unknown>)[failureKey] = undefined;
  let raw: string;
  try {
    raw = await guest.invoke(input);
    const hostFailure = (globalThis as Record<PropertyKey, unknown>)[failureKey];
    if (hostFailure) throw hostFailure;
  }
  catch (error) {
    const hostFailure = (globalThis as Record<PropertyKey, unknown>)[failureKey];
    throw hostFailure ?? error;
  } finally {
    (globalThis as Record<PropertyKey, unknown>)[failureKey] = undefined;
  }
  assertDeadline(active.deadlineAt);
  const step = decodeGuestStep(raw, activeAction, nextSequence + 1);
  if (step.kind === "host_call") {
    if (nextSequence >= V2_LIMITS.hostCalls) throw new V2PluginRuntimeError("overloaded", "Plugin exceeded the Host call limit");
    nextSequence++;
    pendingCallId = step.call.call_id;
    send(active, "host_call", { actionRequestId, sequence: nextSequence, call: step.call });
    return;
  }
  running = false;
  send(active, "result", { actionRequestId, result: step.result });
  resetInvocation();
}

async function stop(request: Extract<V2WorkerRequest, { type: "stop" }>): Promise<void> {
  if (guest) await guest.dispose();
  guest = undefined;
  initialized = false;
  activePluginId = activeVersion = activeWorkspaceId = activeSessionId = activeDigest = "";
  activeGrants = [];
  activationEpoch = 0;
  resetInvocation();
  send(request, "stopped");
}

function resetInvocation(): void {
  active = undefined;
  activeAction = undefined;
  actionRequestId = undefined;
  nextSequence = 0;
  pendingCallId = undefined;
  running = false;
}

function send(request: V2Envelope, type: V2WorkerMessage["type"], extra: Partial<V2WorkerMessage> = {}): void {
  scope.postMessage({
    id: request.id,
    sessionId: request.sessionId,
    epoch: request.epoch,
    pluginId: request.pluginId,
    version: request.version,
    digest: request.digest,
    workspaceId: request.workspaceId,
    deadlineAt: request.deadlineAt,
    grants: request.grants,
    type,
    ...extra,
  } satisfies V2WorkerMessage);
}

type WorkerErrorCode = NonNullable<V2WorkerMessage["error"]>["code"];

function sendError(request: V2Envelope, error: { code: WorkerErrorCode; message: string }): void {
  send(request, "error", { error: { code: error.code, message: error.message.slice(0, 512) } });
}

function runtimeError(error: unknown): { code: WorkerErrorCode; message: string } {
  if (error instanceof V2PluginRuntimeError) return { code: error.code, message: error.message };
  const code = (error as { code?: string } | null)?.code;
  if (code === "capability_denied" || code === "snapshot_stale" || code === "invalid_input" || code === "capacity" || code === "timeout") {
    return { code, message: error instanceof Error ? error.message : code };
  }
  if (error instanceof RangeError) {
    return { code: "capacity", message: "Plugin exceeded this browser's available memory capacity" };
  }
  return { code: "guest_trap", message: error instanceof Error ? error.message : "Plugin component trapped" };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

