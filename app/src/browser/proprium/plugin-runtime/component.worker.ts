import { $init as initializeJco, generate } from "@bytecodealliance/jco-transpile/component";
import type * as Guest from "./wit/generated/interfaces/proprium-plugin-guest.js";
import { CapabilityBroker } from "./capability-broker.js";
import { assertSnapshot, CAPABILITIES, LIMITS, PLUGIN_GUEST_EXPORT, PLUGIN_HOST_IMPORT, PluginRuntimeError, utf8Size, type PluginCapability, type RuntimeContext, type RuntimeErrorCode, type WorkerEnvelope, type WorkerRequest, type WorkerResponse } from "./protocol.js";

const scope = self as DedicatedWorkerGlobalScope;
const brokerKey = Symbol.for("proprium.plugin.worker.broker.v1");
const failureKey = Symbol.for("proprium.plugin.worker.failure.v1");
const hostModule = `
const broker = () => globalThis[Symbol.for("proprium.plugin.worker.broker.v1")];
const call = (name, value) => {
  try {
    const target = broker();
    if (!target) throw Object.assign(new Error("No active Host capability request"), { code: "capability_denied" });
    return target[name](value);
  } catch (error) {
    globalThis[Symbol.for("proprium.plugin.worker.failure.v1")] = error;
    return { tag: "err", val: error && typeof error === "object" && "code" in error ? error.code : "invalid_input" };
  }
};
export const snapshotList = () => call("snapshotList");
export const snapshotRead = path => call("snapshotRead", path);
export const proposeChange = proposal => call("proposeChange", proposal);
export const uiContribute = contribution => call("uiContribute", contribution);
`;

let guest: typeof Guest | undefined;
let sessionId = "";
let pluginId = "";
let version = "";
let digest = "";
let workspaceId = "";
let epoch = 0;
let capabilities = new Set<PluginCapability>();
let running = false;
let invoking = false;

scope.addEventListener("message", event => {
  void handle(event.data as WorkerRequest);
});

async function handle(request: WorkerRequest): Promise<void> {
  if (!validEnvelope(request)) return;
  if (running && !sameInstance(request)) {
    respond(request, { code: "malformed_message", message: "Request belongs to a different plugin session or epoch" });
    return;
  }
  try {
    if (request.type === "start") await start(request);
    else if (request.type === "invoke") invoke(request);
    else if (request.type === "stop") await stop(request);
    else respond(request, { code: "malformed_message", message: "Unknown plugin operation" });
  } catch (error) {
    respond(request, toRuntimeError(error));
  }
}

function validEnvelope(request: WorkerRequest): request is WorkerRequest {
  const now = Date.now();
  return Boolean(request && typeof request === "object" && ["start", "invoke", "stop"].includes(request.type) &&
    typeof request.id === "string" && request.id.length <= 128 &&
    typeof request.sessionId === "string" && request.sessionId.length <= 128 && Number.isSafeInteger(request.epoch) && request.epoch > 0 &&
    typeof request.pluginId === "string" && request.pluginId.length <= 128 && typeof request.version === "string" && request.version.length <= 128 &&
    /^[a-f0-9]{64}$/u.test(request.digest) && typeof request.workspaceId === "string" && request.workspaceId.length <= 256 &&
    Array.isArray(request.grants) && request.grants.every(capability => CAPABILITIES.includes(capability)) &&
    Number.isSafeInteger(request.deadlineAt) && request.deadlineAt > now && request.deadlineAt <= now + LIMITS.maxDeadlineMs);
}

function sameInstance(request: WorkerEnvelope): boolean {
  return request.sessionId === sessionId && request.epoch === epoch && request.pluginId === pluginId &&
    request.version === version && request.digest === digest && request.workspaceId === workspaceId &&
    request.grants.length === capabilities.size && request.grants.every(capability => capabilities.has(capability));
}

async function start(request: Extract<WorkerRequest, { type: "start" }>): Promise<void> {
  if (running || request.component.byteLength === 0 || request.component.byteLength > LIMITS.componentBytes ||
      request.context.workspaceId !== request.workspaceId || request.context.pluginId !== request.pluginId ||
      request.context.version !== request.version || request.grants.some(capability => !CAPABILITIES.includes(capability))) {
    throw new PluginRuntimeError("invalid_input", "Plugin activation request is invalid");
  }
  if (await sha256(request.component) !== request.digest) throw new PluginRuntimeError("invalid_input", "Component bytes no longer match the admitted digest");
  sessionId = request.sessionId;
  pluginId = request.pluginId;
  version = request.version;
  digest = request.digest;
  workspaceId = request.workspaceId;
  epoch = request.epoch;
  capabilities = new Set(request.grants);
  const hostUrl = URL.createObjectURL(new Blob([hostModule], { type: "text/javascript" }));
  try {
    await initializeJco;
    const generated = generate(request.component, {
      name: `plugin_${epoch}`,
      noTypescript: true,
      noNodejsCompat: true,
      base64Cutoff: LIMITS.generatedBytes,
      importBindings: { tag: "js" },
      map: [[PLUGIN_HOST_IMPORT, hostUrl]],
    });
    const imports = [...new Set(generated.imports)];
    const exports = generated.exports.filter(([name]) => name !== "guest");
    if (imports.length !== 1 || imports[0] !== hostUrl || exports.length !== 1 ||
        exports[0]?.[0] !== PLUGIN_GUEST_EXPORT || exports[0]?.[1] !== "instance") {
      throw new PluginRuntimeError("incompatible_abi", "Component imports or exports do not match the admitted Proprium WIT world");
    }
    if (generated.files.length !== 1 || generated.files[0]?.[0] !== `plugin_${epoch}.js` ||
        generated.files[0][1].byteLength > LIMITS.generatedBytes) {
      throw new PluginRuntimeError("invalid_input", "Component transform produced external or excessive runtime files");
    }
    const generatedBytes = generated.files[0][1].slice();
    const generatedUrl = URL.createObjectURL(new Blob([generatedBytes.buffer as ArrayBuffer], { type: "text/javascript" }));
    try {
      const module = await import(/* @vite-ignore */ generatedUrl) as { guest?: typeof Guest };
      if (!module.guest || typeof module.guest.initialize !== "function" || typeof module.guest.invoke !== "function" || typeof module.guest.dispose !== "function") {
        throw new PluginRuntimeError("incompatible_abi", "Component guest does not implement the Proprium lifecycle");
      }
      guest = module.guest;
      await guest.initialize(request.context satisfies RuntimeContext);
      running = true;
    } finally {
      URL.revokeObjectURL(generatedUrl);
    }
  } finally {
    URL.revokeObjectURL(hostUrl);
  }
  respond(request);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}

function invoke(request: Extract<WorkerRequest, { type: "invoke" }>): void {
  if (!running || !guest || !sameInstance(request)) {
    respond(request, { code: "stopped", message: "Plugin is not active for this workspace epoch" });
    return;
  }
  if (typeof request.request !== "string" || utf8Size(request.request) > LIMITS.requestBytes) {
    respond(request, { code: "invalid_input", message: "Plugin invocation exceeds the input limit" });
    return;
  }
  try { assertSnapshot(request.snapshot); }
  catch (error) { respond(request, toRuntimeError(error)); return; }
  if (invoking) {
    respond(request, { code: "overloaded", message: "A plugin request is already running" });
    return;
  }
  let broker: CapabilityBroker;
  try {
    broker = new CapabilityBroker(capabilities, request);
  } catch (error) {
    respond(request, toRuntimeError(error));
    return;
  }
  (globalThis as Record<PropertyKey, unknown>)[failureKey] = undefined;
  (globalThis as Record<PropertyKey, unknown>)[brokerKey] = broker;
  invoking = true;
  void (async () => {
    try {
      const value = await guest!.invoke(request.request);
      if (typeof value !== "string" || utf8Size(value) > LIMITS.outputBytes) throw new PluginRuntimeError("invalid_input", "Plugin output exceeds the byte limit");
      const hostFailure = (globalThis as Record<PropertyKey, unknown>)[failureKey];
      if (hostFailure) {
        respond(request, toRuntimeError(hostFailure));
        return;
      }
      scope.postMessage({ ...envelope(request), snapshotId: request.snapshot.id, snapshotRevision: request.snapshot.revision, result: broker.transcript(value) });
    } catch (error) {
      const hostFailure = (globalThis as Record<PropertyKey, unknown>)[failureKey];
      respond(request, toRuntimeError(hostFailure ?? error));
    } finally {
      (globalThis as Record<PropertyKey, unknown>)[brokerKey] = undefined;
      (globalThis as Record<PropertyKey, unknown>)[failureKey] = undefined;
      invoking = false;
    }
  })();
}

async function stop(request: Extract<WorkerRequest, { type: "stop" }>): Promise<void> {
  if (guest) await guest.dispose();
  guest = undefined;
  running = false;
  capabilities.clear();
  sessionId = pluginId = version = digest = workspaceId = "";
  epoch = 0;
  respond(request);
}

function envelope(request: WorkerRequest) {
  return {
    type: request.type,
    id: request.id,
    sessionId: request.sessionId,
    epoch: request.epoch,
    pluginId: request.pluginId,
    version: request.version,
    digest: request.digest,
    workspaceId: request.workspaceId,
    deadlineAt: request.deadlineAt,
    grants: request.grants,
  };
}

function respond(request: WorkerRequest, error?: { code: RuntimeErrorCode; message: string }): void {
  scope.postMessage({
    ...envelope(request),
    ...(request.type === "invoke" ? { snapshotId: request.snapshot.id, snapshotRevision: request.snapshot.revision } : {}),
    ...(error ? { error } : {}),
  } satisfies WorkerResponse);
}

function toRuntimeError(error: unknown): { code: RuntimeErrorCode; message: string } {
  if (error instanceof PluginRuntimeError) return { code: error.code, message: error.message.slice(0, 512) };
  const code = (error as { code?: string } | null)?.code;
  if (code === "untrusted_publisher" || code === "capability_denied" || code === "snapshot_stale" || code === "invalid_input" || code === "timeout") {
    return { code, message: error instanceof Error ? error.message.slice(0, 512) : code };
  }
  return { code: "guest_trap", message: error instanceof Error ? error.message.slice(0, 512) : "Plugin component trapped" };
}
