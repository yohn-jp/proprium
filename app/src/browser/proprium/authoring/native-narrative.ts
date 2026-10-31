import manifest from "../../../../../plugins/narrative/plugin.json";
import type { ActionDescriptor, ActionResult, SurfaceDeclaration } from "./types.js";
import type { RuntimeInvokeOptions, VerifiedActionSet } from "./actions.js";

export const NATIVE_NARRATIVE_ID = "proprium.narrative";
const definition = manifest as unknown as {
  id: string; version: string; capabilities: string[];
  actions: ActionDescriptor[]; ui: SurfaceDeclaration[];
};
let manifestDigest: Promise<string> | undefined;

/** This bundled, first-party definition is not a downloadable/third-party plugin. */
export function nativeNarrativeSurfaces(): readonly SurfaceDeclaration[] { return definition.ui; }
export function nativeNarrativeVersion(): string { return definition.version; }
export async function nativeNarrativeActionSet(): Promise<VerifiedActionSet> {
  if (definition.id !== NATIVE_NARRATIVE_ID) throw new Error("Incorrect built-in Narrative identity");
  manifestDigest ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(definition))).then(
    buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
  return {
    plugin_id: NATIVE_NARRATIVE_ID, version: definition.version, manifest_digest: await manifestDigest,
    enabled: true, activation_epoch: 1, descriptors: definition.actions,
    dependencies: [], grants: definition.capabilities, host_capabilities: definition.capabilities,
  };
}
type HostCallMessage = { type: "host_call"; call_id: string; operation: string; payload: Record<string, unknown> };
type ResultMessage = { type: "result"; result: ActionResult };
type WorkerMessage = HostCallMessage | ResultMessage;

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * One short-lived TS Worker per invocation. The Host dispatcher remains the sole
 * capability broker, schema validator, snapshot authority and ChangeWriter.
 * Terminating a Worker cannot directly mutate the Git worktree.
 */
export async function invokeNativeNarrative(options: RuntimeInvokeOptions): Promise<ActionResult> {
  const request = options.request;
  if (request.plugin_id !== NATIVE_NARRATIVE_ID) throw runtimeError("invalid_input", "Not a Narrative request");
  const descriptor = definition.actions.find(item => item.action_id === request.action_id);
  if (!descriptor || descriptor.schema_version !== request.schema_version ||
      !descriptor.callers.includes(options.caller) ||
      (descriptor.requires_user_gesture && (options.caller !== "ui" || !options.user_gesture))) {
    throw runtimeError("capability_denied", "Narrative action is not available to this caller");
  }
  options.validate_schema(descriptor.input_schema, request.input, "input");
  if (descriptor.required_capabilities.some(name => !options.granted_capabilities.includes(name))) {
    throw runtimeError("capability_denied", "Narrative action lacks an approved Host capability");
  }
  if (options.signal?.aborted) throw runtimeError("cancelled", "Narrative invocation was cancelled");
  if (!options.is_snapshot_current()) throw runtimeError("snapshot_stale", "Narrative snapshot is stale");
  const remaining = Math.min(request.deadline_ms, options.deadline_at - Date.now());
  if (remaining <= 0) throw runtimeError("timeout", "Narrative invocation deadline expired");

  let worker: Worker;
  try { worker = new Worker(new URL("./native-narrative.worker.js", import.meta.url), { type: "module", name: "proprium-narrative-ts" }); }
  catch { throw runtimeError("unavailable", "Unable to start the native Narrative Worker"); }

  return new Promise<ActionResult>((resolve, reject) => {
    let finished = false;
    let callPending = false;
    let lastCallId = "";
    const finish = (result?: ActionResult, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(undefined, runtimeError("cancelled", "Narrative invocation was cancelled"));
    const timeout = setTimeout(() => finish(undefined, runtimeError("timeout", "Narrative invocation timed out")), remaining);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(undefined, runtimeError("guest_trap", "Native Narrative Worker failed"));
    worker.onmessageerror = () => finish(undefined, runtimeError("malformed_message", "Narrative Worker response could not be decoded"));
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (finished) return;
      const message = event.data;
      if (!message || typeof message !== "object") {
        finish(undefined, runtimeError("malformed_message", "Narrative Worker sent malformed data"));
        return;
      }
      if (message.type === "host_call") {
        if (callPending || typeof message.call_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(message.call_id) ||
            message.call_id === lastCallId || typeof message.operation !== "string" || !message.payload ||
            typeof message.payload !== "object" || Array.isArray(message.payload)) {
          finish(undefined, runtimeError("malformed_message", "Narrative Worker Host call is malformed"));
          return;
        }
        callPending = true;
        lastCallId = message.call_id;
        if (!options.is_snapshot_current()) {
          finish(undefined, runtimeError("snapshot_stale", "Workspace changed before Narrative Host I/O"));
          return;
        }
        void options.resolve_host_call({ call_id: message.call_id, operation: message.operation, payload: message.payload })
          .then(value => {
            if (finished) return;
            callPending = false;
            worker.postMessage({ type: "host_response", call_id: message.call_id, ok: true, value });
          }, error => {
            if (finished) return;
            callPending = false;
            const reason = error as { code?: unknown; message?: unknown; retryable?: unknown } | null;
            worker.postMessage({ type: "host_response", call_id: message.call_id, ok: false,
              error: { code: typeof reason?.code === "string" ? reason.code : "unavailable",
                message: error instanceof Error ? error.message : "Host call failed", retryable: reason?.retryable === true } });
          }).catch(error => finish(undefined, error));
      } else if (message.type === "result") {
        if (callPending || !message.result || message.result.request_id !== request.request_id) {
          finish(undefined, runtimeError("malformed_message", "Narrative result did not match its request"));
          return;
        }
        if (!options.is_snapshot_current()) {
          finish(undefined, runtimeError("snapshot_stale", "Workspace changed during Narrative invocation"));
          return;
        }
        try {
          if (message.result.ok) options.validate_schema(descriptor.output_schema, message.result.value, "output");
          finish(message.result);
        } catch (error) { finish(undefined, error); }
      } else finish(undefined, runtimeError("malformed_message", "Unexpected Narrative Worker message"));
    };
    if (options.signal?.aborted) { abort(); return; }
    worker.postMessage({ type: "invoke", request });
  });
}
