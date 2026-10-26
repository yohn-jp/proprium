import type { ActionRequest, ActionResult, ActionError } from "../../app/src/browser/proprium/authoring/types.js";

export interface HostCall {
  kind: "host_call";
  call_id: string;
  operation: string;
  payload: Record<string, unknown>;
}
export type HostResponse = { kind: "host_response"; call_id: string } &
  ({ ok: true; value: unknown } | { ok: false; error: ActionError });
export interface GuestHost {
  request<T = unknown>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown>;
}
export type Handler = (input: Record<string, unknown>, context: ActionRequest, host: GuestHost) =>
  Generator<HostCall, unknown, unknown> | unknown;

/**
 * Cooperative component-model adapter. Each call yields to the trusted Host,
 * which performs asynchronous I/O and resumes this same component instance.
 * No JSPI, shared memory, filesystem or network is exposed to the guest.
 * This helper is bundled into each independently compiled WASM product.
 */
export function createGuest(pluginId: string, handlers: Record<string, Handler>) {
  let initialized = false;
  let workspaceId: string | undefined;
  let current: ActionRequest | undefined;
  let task: Generator<HostCall, unknown, unknown> | undefined;
  let pending: string | undefined;
  let sequence = 0;

  const result = (body: { ok: true; value: unknown; warnings: string[] } | { ok: false; error: ActionError }) => {
    if (!current) throw new Error("No active action");
    const response: ActionResult = {
      request_id: current.request_id, scope: current.scope, snapshot: current.snapshot, ...body,
    };
    task = undefined; pending = undefined; current = undefined;
    return JSON.stringify(response);
  };
  const failure = (error: unknown) => {
    const value = error as Partial<ActionError> | null;
    return result({ ok: false, error: {
      code: typeof value?.code === "string" ? value.code : "guest_trap",
      message: error instanceof Error ? error.message : typeof value?.message === "string" ? value.message : "Guest action failed",
      retryable: value?.retryable === true,
      ...(value?.details ? { details: value.details } : {}),
    } });
  };
  const step = (response?: HostResponse): string => {
    try {
      const state = response?.ok === false ? task!.throw(response.error) : task!.next(response?.value);
      if (state.done) return result({ ok: true, value: state.value, warnings: [] });
      const call = state.value;
      if (!call || call.kind !== "host_call" || typeof call.operation !== "string" ||
          !call.payload || typeof call.payload !== "object" || Array.isArray(call.payload)) {
        throw Object.assign(new Error("Invalid guest continuation"), { code: "invalid_input" });
      }
      pending = `${current!.request_id}:${++sequence}`;
      return JSON.stringify({ ...call, call_id: pending });
    } catch (error) { return failure(error); }
  };
  return {
    initialize(context: { pluginId: string; version: string; workspaceId: string }): void {
      if (initialized || context.pluginId !== pluginId || !context.workspaceId) throw new Error("Invalid plugin initialization");
      initialized = true; workspaceId = context.workspaceId;
    },
    invoke(raw: string): string {
      if (!initialized) throw new Error("Plugin is not initialized");
      const message = JSON.parse(raw) as ActionRequest | HostResponse;
      if ("kind" in message && message.kind === "host_response") {
        if (!task || message.call_id !== pending) throw new Error("Unexpected Host continuation");
        pending = undefined;
        return step(message);
      }
      if (current || task) throw new Error("An action is already active");
      const request = message as ActionRequest;
      if (request.plugin_id !== pluginId || request.scope?.workspace_id !== workspaceId || request.schema_version !== 1) {
        throw new Error("Invalid action identity");
      }
      current = request; sequence = 0;
      const handler = handlers[request.action_id];
      if (!handler) return failure(Object.assign(new Error("Unknown action"), { code: "invalid_input" }));
      const host: GuestHost = {
        *request<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
          return (yield { kind: "host_call", call_id: "", operation, payload }) as T;
        },
      };
      try {
        const value = handler(request.input, request, host);
        if (value && typeof value === "object" && "next" in value && typeof value.next === "function") {
          task = value as Generator<HostCall, unknown, unknown>;
          return step();
        }
        if (value && typeof value === "object" && "then" in value) {
          throw Object.assign(new Error("Use a generator for asynchronous Host calls"), { code: "incompatible_abi" });
        }
        return result({ ok: true, value, warnings: [] });
      } catch (error) { return failure(error); }
    },
    dispose(): void { task = undefined; current = undefined; pending = undefined; initialized = false; workspaceId = undefined; },
  };
}
