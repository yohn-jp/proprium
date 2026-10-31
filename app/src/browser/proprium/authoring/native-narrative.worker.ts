import { invokeNarrative } from "../../../../../plugins/narrative/src/actions.js";
import type { ActionRequest, ActionResult } from "./types.js";
import type { HostCall } from "../../../../../plugins/shared/guest.js";

/** First-party Narrative runs as ordinary TypeScript in a standard browser Worker. No WASM ABI. */
type Incoming =
  | { type: "invoke"; request: ActionRequest }
  | { type: "host_response"; call_id: string; ok: true; value: unknown }
  | { type: "host_response"; call_id: string; ok: false; error: { code: string; message: string; retryable: boolean } };
type Outgoing =
  | { type: "host_call"; call_id: string; operation: string; payload: Record<string, unknown> }
  | { type: "result"; result: ActionResult };
const port = self as unknown as { postMessage(message: Outgoing): void; onmessage: ((event: MessageEvent<Incoming>) => void) | null };
let request: ActionRequest | undefined;
let iterator: Generator<HostCall, unknown, unknown> | undefined;
let pending: string | undefined;
let sequence = 0;

function complete(result: ActionResult): void {
  iterator = undefined;
  pending = undefined;
  port.postMessage({ type: "result", result });
}
function failed(error: unknown): void {
  if (!request) return;
  const value = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown } | null;
  complete({ request_id: request.request_id, scope: request.scope, snapshot: request.snapshot,
    ok: false, error: { code: typeof value?.code === "string" ? value.code : error instanceof RangeError ? "capacity" : "guest_trap",
      message: error instanceof Error ? error.message : typeof value?.message === "string" ? value.message : "Narrative action failed",
      retryable: value?.retryable === true,
      ...(value?.details && typeof value.details === "object" && !Array.isArray(value.details)
        ? { details: value.details as Record<string, unknown> } : {}) } });
}
function step(response?: Extract<Incoming, { type: "host_response" }>): void {
  if (!iterator || !request) return;
  try {
    const next = response?.ok === false ? iterator.throw(response.error) : iterator.next(response?.value);
    if (next.done) {
      complete({ request_id: request.request_id, scope: request.scope, snapshot: request.snapshot,
        ok: true, value: next.value, warnings: [] });
      return;
    }
    const call = next.value;
    if (!call || call.kind !== "host_call" || typeof call.operation !== "string" ||
        !call.payload || typeof call.payload !== "object" || Array.isArray(call.payload)) {
      throw Object.assign(new Error("Narrative yielded an invalid Host operation"), { code: "invalid_input" });
    }
    pending = `h:${++sequence}`;
    port.postMessage({ type: "host_call", call_id: pending, operation: call.operation, payload: call.payload });
  } catch (error) { failed(error); }
}
port.onmessage = event => {
  const message = event.data;
  try {
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      throw Object.assign(new Error("Invalid Narrative Worker message"), { code: "invalid_input" });
    }
    if (message.type === "invoke") {
      if (request || !message.request || message.request.plugin_id !== "proprium.narrative") {
        throw Object.assign(new Error("Invalid Narrative invocation"), { code: "invalid_input" });
      }
      request = message.request;
      iterator = invokeNarrative(request as Parameters<typeof invokeNarrative>[0], {
        *request<T = unknown>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
          return (yield { kind: "host_call", call_id: "", operation, payload }) as T;
        },
      });
      step();
    } else if (message.type === "host_response") {
      if (!iterator || !pending || message.call_id !== pending) throw new Error("Unexpected Narrative Host response");
      pending = undefined;
      step(message);
    } else { throw new Error("Unknown Narrative worker message"); }
  } catch (error) { failed(error); }
};
