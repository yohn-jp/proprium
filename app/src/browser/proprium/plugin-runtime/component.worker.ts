import { $init as initializeJco, generate } from "@bytecodealliance/jco-transpile/component";
import type * as Guest from "./wit/generated/interfaces/proprium-plugin-guest.js";
import { LIMITS, PLUGIN_GUEST_EXPORT, PLUGIN_HOST_IMPORT, PluginRuntimeError, utf8Size, type RuntimeContext, type RuntimeErrorCode, type WorkerRequest, type WorkerResponse } from "./protocol.js";

const scope = self as DedicatedWorkerGlobalScope;
const failureKey = Symbol.for("proprium.plugin.worker.failure.v1");
const hostModule = `
const denied = () => {
  const error = Object.assign(new Error("Plugin Host capabilities are disabled"), { code: "capability_denied" });
  globalThis[Symbol.for("proprium.plugin.worker.failure.v1")] = error;
  return { tag: "err", val: "capability_denied" };
};
export const snapshotRead = () => denied();
`;

let guest: typeof Guest | undefined;
let workspaceId = "";
let epoch = 0;
let running = false;
let invoking = false;

scope.addEventListener("message", event => {
  void handle(event.data as WorkerRequest);
});

async function handle(request: WorkerRequest): Promise<void> {
  if (!request || typeof request !== "object" || typeof request.id !== "string" ||
      !Number.isSafeInteger(request.epoch) || request.epoch < 1 || typeof request.workspaceId !== "string") return;
  if (running && (request.epoch !== epoch || request.workspaceId !== workspaceId)) {
    respond(request, { code: "malformed_message", message: "Request belongs to an inactive plugin epoch or workspace" });
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

async function start(request: Extract<WorkerRequest, { type: "start" }>): Promise<void> {
  if (running || request.component.byteLength === 0 || request.component.byteLength > LIMITS.componentBytes ||
      request.pluginId.length > 128 || request.version.length > 128 || request.context.workspaceId !== request.workspaceId ||
      request.context.pluginId !== request.pluginId || request.context.version !== request.version) {
    throw new PluginRuntimeError("invalid_input", "Plugin activation request is invalid");
  }
  workspaceId = request.workspaceId;
  epoch = request.epoch;
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

function invoke(request: Extract<WorkerRequest, { type: "invoke" }>): void {
  if (!running || !guest || request.epoch !== epoch || request.workspaceId !== workspaceId) {
    respond(request, { code: "stopped", message: "Plugin is not active for this workspace epoch" });
    return;
  }
  if (request.request.length > LIMITS.requestBytes || typeof request.snapshotId !== "string" || request.snapshotId.length > 256 ||
      typeof request.snapshotRevision !== "string" || request.snapshotRevision.length > 256) {
    respond(request, { code: "invalid_input", message: "Plugin invocation exceeds the input limit" });
    return;
  }
  if (invoking) {
    respond(request, { code: "overloaded", message: "A plugin request is already running" });
    return;
  }
  (globalThis as Record<PropertyKey, unknown>)[failureKey] = undefined;
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
      const response: WorkerResponse = {
        type: request.type, id: request.id, epoch, workspaceId, snapshotId: request.snapshotId,
        result: { requestId: request.id, epoch, workspaceId, snapshotId: request.snapshotId, value },
      };
      scope.postMessage(response);
    } catch (error) {
      const hostFailure = (globalThis as Record<PropertyKey, unknown>)[failureKey];
      respond(request, toRuntimeError(hostFailure ?? error));
    } finally {
      (globalThis as Record<PropertyKey, unknown>)[failureKey] = undefined;
      invoking = false;
    }
  })();
}

async function stop(request: Extract<WorkerRequest, { type: "stop" }>): Promise<void> {
  if (guest) await guest.dispose();
  guest = undefined;
  running = false;
  respond(request);
}

function respond(request: WorkerRequest, error?: { code: RuntimeErrorCode; message: string }): void {
  const response: WorkerResponse = {
    type: request.type,
    id: request.id,
    epoch: request.epoch,
    workspaceId: request.workspaceId,
    ...(request.type === "invoke" ? { snapshotId: request.snapshotId } : {}),
    ...(error ? { error } : {}),
  };
  scope.postMessage(response);
}

function toRuntimeError(error: unknown): { code: RuntimeErrorCode; message: string } {
  if (error instanceof PluginRuntimeError) return { code: error.code, message: error.message.slice(0, 512) };
  const code = (error as { code?: string } | null)?.code;
  if (code === "capability_denied" || code === "snapshot_stale" || code === "invalid_input") {
    return { code, message: error instanceof Error ? error.message.slice(0, 512) : code };
  }
  return { code: "guest_trap", message: error instanceof Error ? error.message.slice(0, 512) : "Plugin component trapped" };
}
