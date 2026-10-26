import type { ActionDescriptor, ActionRequest, ActionResult } from "../../authoring/types.js";
import type { PluginManifestV2 } from "../../plugin-artifact.js";
import {
  assertDeadline, assertEnvelope, canonicalJson, capabilityForHostOperation, encodeHostResponse, isRecord, V2_LIMITS, V2_PLUGIN_ABI,
  V2PluginRuntimeError, utf8Size, type V2Context, type V2Envelope, type V2Grant, type V2HostCall,
  type V2HostResponse, type V2WorkerMessage, type V2WorkerRequest,
} from "./protocol.js";

export type V2ArtifactDescriptor = PluginManifestV2["artifacts"][number];
export type V2PluginManifest = PluginManifestV2;
export type V2Caller = "ui" | "mcp" | "plugin";
export interface V2HostCallContext {
  readonly plugin_id: string;
  readonly activation_epoch: number;
  readonly caller: V2Caller;
  readonly descriptor: ActionDescriptor;
  readonly request: ActionRequest;
  readonly granted_capabilities: readonly string[];
  readonly signal: AbortSignal;
}
export type ResolveV2HostCall = (call: V2HostCall, context: V2HostCallContext) => Promise<unknown>;
export interface V2StartOptions {
  readonly context: V2Context;
  readonly user_grants: readonly string[];
  readonly host_allowed: readonly string[];
  readonly deadline_ms?: number;
}
export interface V2InvokeOptions {
  readonly request: ActionRequest;
  readonly caller: V2Caller;
  readonly user_gesture?: boolean;
  readonly validate_schema: (schema: ActionDescriptor["input_schema"] | ActionDescriptor["output_schema"], value: unknown) => void;
  readonly is_snapshot_current: (scope: ActionRequest["scope"], snapshot: ActionRequest["snapshot"]) => boolean;
  readonly resolve_host_call: ResolveV2HostCall;
}
export type V2RuntimeState = "idle" | "starting" | "active" | "stopping" | "stopped" | "failed";

interface PendingExchange {
  readonly kind: "lifecycle";
  readonly request: V2WorkerRequest;
  resolve: (message: V2WorkerMessage) => void;
  reject: (error: V2PluginRuntimeError) => void;
  readonly deadlineAt: number;
  readonly expected: readonly V2WorkerMessage["type"][];
  timer: number;
}
interface PendingInvocation {
  readonly kind: "invoke";
  readonly request: V2WorkerRequest;
  resolve: (message: V2WorkerMessage) => void;
  reject: (error: V2PluginRuntimeError) => void;
  readonly deadlineAt: number;
  readonly action: ActionRequest;
  readonly descriptor: ActionDescriptor;
  readonly options: V2InvokeOptions;
  callSequence: number;
  resolvingCall: boolean;
  readonly controller: AbortController;
  timer: number;
}

let nextEpoch = 1;
let activeWorkers = 0;
const runtimeAdmissionToken = Symbol("proprium.authoring.runtime.v2.admitted");
const admittedRuntimes = new WeakSet<object>();

function boundedDeadline(deadlineMs: number | undefined, defaultMs: number, maxMs: number): number {
  const value = Number.isSafeInteger(deadlineMs) ? deadlineMs! : defaultMs;
  if (value < 1 || value > maxMs) throw new V2PluginRuntimeError("invalid_input", "Action deadline is outside the supported bound");
  return Date.now() + value;
}
function digest(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)).then(hash =>
    Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join(""));
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}
function hexSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function jsonBytes(value: unknown): number {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new V2PluginRuntimeError("invalid_input", "Worker message is not JSON serializable"); }
  return utf8Size(encoded);
}
function envelopeOf(request: V2Envelope): V2Envelope {
  return {
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
function normalizedError(error: unknown): V2PluginRuntimeError {
  if (error instanceof V2PluginRuntimeError) return error;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    if (["capability_denied", "snapshot_stale", "invalid_input", "capacity", "timeout", "cancelled", "dependency_unavailable", "provider_unavailable"].includes(code)) {
      return new V2PluginRuntimeError(code as V2PluginRuntimeError["code"], error instanceof Error ? error.message : code);
    }
  }
  return new V2PluginRuntimeError("unavailable", error instanceof Error ? error.message.slice(0, 512) : "Host request failed");
}
function thrownResponse(error: unknown): Extract<V2HostResponse, { ok: false }>["error"] {
  const value = normalizedError(error);
  return { code: value.code, message: value.message, retryable: ["timeout", "unavailable", "snapshot_stale"].includes(value.code) };
}

/**
 * Host-owned v2 Component runtime. `verifyArtifact` must be supplied by the
 * signed-manifest admission layer; it runs before a Worker is created. The
 * runtime independently hashes the admitted bytes again inside the Worker.
 */
export class BrowserAuthoringPluginRuntime {
  private worker?: Worker;
  private component?: Uint8Array;
  private epoch = 0;
  private workspaceId = "";
  private stateValue: V2RuntimeState = "idle";
  private inFlight = false;
  private readonly grants = new Set<string>();
  private readonly pending = new Map<string, PendingExchange | PendingInvocation>();
  private capacityHeld = false;
  private readonly sessionId = crypto.randomUUID();
  private constructor(readonly manifest: V2PluginManifest, component: Uint8Array, readonly componentDigest: string, token: symbol) {
    if (token !== runtimeAdmissionToken) throw new V2PluginRuntimeError("untrusted_publisher", "Runtime must be created through v2 artifact admission");
    // `create` already copied the caller-owned bytes before hashing/admission.
    this.component = component;
    admittedRuntimes.add(this);
  }

  static async create(
    manifest: V2PluginManifest,
    component: Uint8Array,
    verifyArtifact: (manifest: V2PluginManifest, path: string, bytes: Uint8Array) => Promise<void>,
  ): Promise<BrowserAuthoringPluginRuntime> {
    if (!manifest || manifest.schema !== "proprium.plugin/v2" || manifest.abi !== V2_PLUGIN_ABI ||
        !/^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u.test(manifest.id) ||
        !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
        !Array.isArray(manifest.capabilities) || !Array.isArray(manifest.actions) || !Array.isArray(manifest.artifacts) ||
        typeof verifyArtifact !== "function" || !(component instanceof Uint8Array) ||
        component.byteLength === 0 || component.byteLength > V2_LIMITS.componentBytes) {
      throw new V2PluginRuntimeError("invalid_input", "Plugin manifest or Component is invalid");
    }
    const artifact = manifest.artifacts.find(item => item.path === manifest.entrypoint && item.mediaType === "application/wasm");
    if (!artifact || artifact.bytes !== component.byteLength || !hexSha256(artifact.sha256)) {
      throw new V2PluginRuntimeError("invalid_input", "Manifest entrypoint does not identify the supplied WASM bytes");
    }
    const admittedBytes = Uint8Array.from(component);
    await verifyArtifact(manifest, manifest.entrypoint, admittedBytes);
    const componentDigest = await digest(admittedBytes);
    if (componentDigest !== artifact.sha256) throw new V2PluginRuntimeError("untrusted_publisher", "Component digest differs from the signed manifest");
    const stableManifest = freezeJson(JSON.parse(JSON.stringify(manifest)) as V2PluginManifest);
    return new BrowserAuthoringPluginRuntime(stableManifest, admittedBytes, componentDigest, runtimeAdmissionToken);
  }

  get state(): V2RuntimeState { this.assertAdmitted(); return this.stateValue; }

  async start(options: V2StartOptions): Promise<void> {
    this.assertAdmitted();
    if (this.stateValue !== "idle" || !this.component) throw new V2PluginRuntimeError("unavailable", `Cannot start plugin in ${this.stateValue} state`);
    if (activeWorkers >= V2_LIMITS.workerCount) throw new V2PluginRuntimeError("overloaded", "The browser plugin Worker limit is reached");
    if (!options.context || options.context.pluginId !== this.manifest.id || options.context.version !== this.manifest.version ||
        typeof options.context.workspaceId !== "string" || options.context.workspaceId.length < 1 || options.context.workspaceId.length > 256) {
      throw new V2PluginRuntimeError("invalid_input", "Plugin activation identity is invalid");
    }
    this.workspaceId = options.context.workspaceId;
    this.epoch = nextEpoch++;
    for (const capability of this.manifest.capabilities) {
      if (options.user_grants.includes(capability) && options.host_allowed.includes(capability)) this.grants.add(capability);
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL("./component.worker.js", import.meta.url), { type: "module", name: `proprium-v2-${this.manifest.id}` });
    } catch {
      throw new V2PluginRuntimeError("unavailable", "This browser cannot start an isolated plugin Worker");
    }
    this.worker = worker;
    this.stateValue = "starting";
    this.capacityHeld = true;
    activeWorkers++;
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerError);
    const component = this.component;
    const request: Extract<V2WorkerRequest, { type: "start" }> = {
      type: "start", id: crypto.randomUUID(), sessionId: this.sessionId, epoch: this.epoch,
      pluginId: this.manifest.id, version: this.manifest.version, digest: this.componentDigest,
      workspaceId: this.workspaceId, deadlineAt: boundedDeadline(options.deadline_ms, 10_000, 30_000),
      grants: [...this.grants], context: options.context, component,
    };
    // Transfer the runtime's private copy into the Worker instead of retaining
    // it while JCO generates the bounded module wrapper.
    this.component = undefined;
    try {
      await this.exchange(request, ["ready"]);
      this.stateValue = "active";
    } catch (error) {
      if (request.component.byteLength > 0) request.component.fill(0);
      this.fail(normalizedError(error));
      throw error;
    }
  }

  async invoke(options: V2InvokeOptions): Promise<ActionResult> {
    this.assertAdmitted();
    if (this.stateValue !== "active" || !this.worker) throw new V2PluginRuntimeError("unavailable", "Plugin is not active");
    if (this.inFlight) throw new V2PluginRuntimeError("overloaded", "A plugin action is already active");
    const request = options.request;
    if (!request || request.plugin_id !== this.manifest.id || request.scope?.workspace_id !== this.workspaceId ||
        !request.action_id || !request.request_id || jsonBytes(request) > V2_LIMITS.actionBytes) {
      throw new V2PluginRuntimeError("invalid_input", "Action request is invalid or belongs to another workspace");
    }
    const descriptor = this.manifest.actions.find(item => item.plugin_id === this.manifest.id && item.action_id === request.action_id);
    if (!descriptor || descriptor.schema_version !== request.schema_version || !descriptor.callers.includes(options.caller) ||
        (descriptor.requires_user_gesture && (options.caller !== "ui" || options.user_gesture !== true))) {
      throw new V2PluginRuntimeError("capability_denied", "Action is unavailable for this caller or requires a fresh Host gesture");
    }
    if (typeof options.validate_schema !== "function") throw new V2PluginRuntimeError("unavailable", "Host JSON Schema validation is required");
    try { options.validate_schema(descriptor.input_schema, request.input); }
    catch { throw new V2PluginRuntimeError("invalid_input", "Action input does not match its signed schema"); }
    for (const capability of descriptor.required_capabilities) {
      if (!this.grants.has(capability)) throw new V2PluginRuntimeError("capability_denied", `Plugin lacks ${capability}`);
    }
    if (typeof options.resolve_host_call !== "function" || typeof options.is_snapshot_current !== "function") {
      throw new V2PluginRuntimeError("unavailable", "Host dispatch and snapshot guards are required");
    }
    if (!this.snapshotIsCurrent(options, request)) {
      throw new V2PluginRuntimeError("snapshot_stale", "Action snapshot is no longer current");
    }
    const deadlineAt = boundedDeadline(request.deadline_ms, V2_LIMITS.interactiveDeadlineMs, V2_LIMITS.batchDeadlineMs);
    const workerRequest: V2WorkerRequest = {
      type: "invoke", id: crypto.randomUUID(), sessionId: this.sessionId, epoch: this.epoch,
      pluginId: this.manifest.id, version: this.manifest.version, digest: this.componentDigest,
      workspaceId: this.workspaceId, deadlineAt, grants: [...this.grants], action: request,
      request: JSON.stringify(request),
    };
    const invocation: PendingInvocation = {
      kind: "invoke", request: workerRequest, deadlineAt, action: request, descriptor, options, callSequence: 0, resolvingCall: false,
      controller: new AbortController(), resolve: () => undefined, reject: () => undefined, timer: 0,
    };
    this.inFlight = true;
    try {
      const response = await this.exchangeInvocation(invocation);
      if (!response.result || response.type !== "result") throw new V2PluginRuntimeError("malformed_message", "Worker omitted the typed action result");
      if (response.result.ok) {
        try { options.validate_schema(descriptor.output_schema, response.result.value); }
        catch { throw new V2PluginRuntimeError("malformed_message", "Plugin result does not match its signed output schema"); }
      }
      if (!this.snapshotIsCurrent(options, request)) {
        throw new V2PluginRuntimeError("snapshot_stale", "Workspace changed while the plugin action was running");
      }
      return response.result;
    } catch (error) {
      const normalized = normalizedError(error);
      if (["timeout", "guest_trap", "malformed_message", "untrusted_publisher"].includes(normalized.code)) this.fail(normalized);
      throw normalized;
    } finally {
      this.inFlight = false;
    }
  }

  private snapshotIsCurrent(options: V2InvokeOptions, request: ActionRequest): boolean {
    try { return options.is_snapshot_current(request.scope, request.snapshot) === true; }
    catch { throw new V2PluginRuntimeError("unavailable", "Host could not verify the action snapshot"); }
  }

  async stop(): Promise<void> {
    this.assertAdmitted();
    if (this.stateValue === "stopped") return;
    if ([...this.pending.values()].some(pending => pending.kind === "invoke")) {
      this.fail(new V2PluginRuntimeError("cancelled", "Plugin action was cancelled during disable"));
      return;
    }
    if (this.stateValue === "idle") { this.releaseWorker(); this.stateValue = "stopped"; return; }
    if (!this.worker || this.stateValue === "failed") { this.releaseWorker(); this.stateValue = "stopped"; return; }
    this.stateValue = "stopping";
    const request: V2WorkerRequest = {
      type: "stop", id: crypto.randomUUID(), sessionId: this.sessionId, epoch: this.epoch,
      pluginId: this.manifest.id, version: this.manifest.version, digest: this.componentDigest,
      workspaceId: this.workspaceId, deadlineAt: Date.now() + V2_LIMITS.stopDeadlineMs, grants: [...this.grants],
    };
    try { await this.exchange(request, ["stopped"]); }
    finally { this.releaseWorker(); this.stateValue = "stopped"; }
  }

  cancel(): void { this.assertAdmitted(); this.fail(new V2PluginRuntimeError("cancelled", "Plugin action was cancelled")); }

  private assertAdmitted(): void {
    if (!admittedRuntimes.has(this)) throw new V2PluginRuntimeError("untrusted_publisher", "Plugin runtime was not created through artifact admission");
  }

  private exchange(request: V2WorkerRequest, expected: readonly V2WorkerMessage["type"][]): Promise<V2WorkerMessage> {
    return this.addPending(request, expected);
  }

  private exchangeInvocation(invocation: PendingInvocation): Promise<V2WorkerMessage> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new V2PluginRuntimeError("stopped", "Plugin Worker is stopped"));
    const request = invocation.request;
    return new Promise<V2WorkerMessage>((resolve, reject) => {
      invocation.resolve = resolve;
      invocation.reject = reject;
      invocation.timer = window.setTimeout(() => {
        this.pending.delete(request.id);
        const error = new V2PluginRuntimeError("timeout", "Plugin action exceeded its deadline");
        invocation.controller.abort(error);
        reject(error);
        this.fail(error);
      }, Math.max(1, invocation.deadlineAt - Date.now()));
      this.pending.set(request.id, invocation);
      try { worker.postMessage(request); }
      catch {
        window.clearTimeout(invocation.timer);
        this.pending.delete(request.id);
        reject(new V2PluginRuntimeError("unavailable", "Plugin Worker rejected the action"));
      }
    }).then(message => message);
  }

  private addPending(request: V2WorkerRequest, expected: readonly V2WorkerMessage["type"][]): Promise<V2WorkerMessage> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new V2PluginRuntimeError("stopped", "Plugin Worker is stopped"));
    return new Promise((resolve, reject) => {
      const pending: PendingExchange = {
        kind: "lifecycle", request, deadlineAt: request.deadlineAt, expected, resolve, reject, timer: window.setTimeout(() => {
          this.pending.delete(request.id);
          reject(new V2PluginRuntimeError("timeout", `Plugin ${request.type} exceeded its deadline`));
          this.fail(new V2PluginRuntimeError("timeout", `Plugin ${request.type} exceeded its deadline`));
        }, Math.max(1, request.deadlineAt - Date.now())),
      };
      this.pending.set(request.id, pending);
      try {
        if (request.type === "start") worker.postMessage(request, [request.component.buffer as ArrayBuffer]);
        else worker.postMessage(request);
      } catch {
        window.clearTimeout(pending.timer);
        this.pending.delete(request.id);
        reject(new V2PluginRuntimeError("unavailable", "Plugin Worker rejected the request"));
      }
    });
  }

  private readonly onMessage = (event: MessageEvent<V2WorkerMessage>) => {
    const response = event.data;
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    try {
      assertEnvelope(response, pending.request);
      if (jsonBytes(response) > V2_LIMITS.actionResultBytes + V2_LIMITS.hostCallBytes + 16_384) {
        throw new V2PluginRuntimeError("malformed_message", "Worker response exceeds the byte limit");
      }
      if (response.type === "host_call") {
        if (pending.kind !== "invoke" || !response.call || !Number.isSafeInteger(response.sequence) ||
            response.actionRequestId !== pending.action.request_id || response.sequence !== pending.callSequence + 1 ||
            response.call.call_id !== `${pending.action.request_id}:${response.sequence}` ||
            typeof response.call.operation !== "string" || response.call.operation.length < 1 || response.call.operation.length > 256 ||
            !isRecord(response.call.payload) || jsonBytes(response.call) > V2_LIMITS.hostCallBytes || pending.resolvingCall) {
          throw new V2PluginRuntimeError("malformed_message", "Worker Host call is stale or out of order");
        }
        pending.callSequence = response.sequence;
        void this.resolveHostCall(pending, response.call);
        return;
      }
      if (pending.kind === "lifecycle" && !pending.expected.includes(response.type)) {
        throw new V2PluginRuntimeError("malformed_message", "Worker returned an unexpected lifecycle response");
      }
      if (response.type === "error") {
        const failure = response.error;
        if (!failure || typeof failure.code !== "string" || typeof failure.message !== "string") throw new V2PluginRuntimeError("malformed_message", "Worker error response is malformed");
        throw new V2PluginRuntimeError(failure.code, failure.message);
      }
      if (response.type === "result") {
        if (pending.kind !== "invoke" || !response.result || response.actionRequestId !== pending.action.request_id ||
            response.result.request_id !== pending.action.request_id ||
            canonicalJson(response.result.scope) !== canonicalJson(pending.action.scope) ||
            canonicalJson(response.result.snapshot) !== canonicalJson(pending.action.snapshot)) {
          throw new V2PluginRuntimeError("malformed_message", "Worker action result does not match its request");
        }
      }
      window.clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    } catch (error) {
      window.clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.reject(normalizedError(error));
      if (error instanceof V2PluginRuntimeError && error.code === "malformed_message") this.fail(error);
    }
  };

  private async resolveHostCall(pending: PendingInvocation, call: V2HostCall): Promise<void> {
    if (pending.resolvingCall) throw new V2PluginRuntimeError("overloaded", "A Host call is already active for this plugin action");
    pending.resolvingCall = true;
    const worker = this.worker;
    try {
      assertDeadline(pending.deadlineAt);
      const capability = capabilityForHostOperation(call.operation);
      if (!pending.descriptor.required_capabilities.includes(capability) || !this.grants.has(capability)) {
        throw new V2PluginRuntimeError("capability_denied", `Action did not declare or receive ${capability}`);
      }
      if (!this.snapshotIsCurrent(pending.options, pending.action)) {
        throw new V2PluginRuntimeError("snapshot_stale", "Workspace changed before a Host call");
      }
      const result = await pending.options.resolve_host_call(call, {
        plugin_id: this.manifest.id,
        activation_epoch: this.epoch,
        caller: pending.options.caller,
        descriptor: pending.descriptor,
        request: pending.action,
        granted_capabilities: [...this.grants],
        signal: pending.controller.signal,
      });
      assertDeadline(pending.deadlineAt);
      if (!worker || this.pending.get(pending.request.id) !== pending) throw new V2PluginRuntimeError("cancelled", "Plugin action ended before Host response");
      if (!this.snapshotIsCurrent(pending.options, pending.action)) {
        throw new V2PluginRuntimeError("snapshot_stale", "Workspace changed during a Host call");
      }
      const hostResponse = JSON.parse(encodeHostResponse(call.call_id, result)) as V2HostResponse;
      worker.postMessage({
        ...envelopeOf(pending.request), type: "resume", actionRequestId: pending.action.request_id,
        callId: call.call_id, sequence: pending.callSequence, response: hostResponse,
      } satisfies V2WorkerRequest);
    } catch (error) {
      if (!worker || this.pending.get(pending.request.id) !== pending) return;
      const hostResponse: V2HostResponse = {
        kind: "host_response", call_id: call.call_id, ok: false, error: thrownResponse(error),
      };
      try {
        worker.postMessage({
          ...envelopeOf(pending.request), type: "resume", actionRequestId: pending.action.request_id,
          callId: call.call_id, sequence: pending.callSequence, response: hostResponse,
        } satisfies V2WorkerRequest);
      } catch { this.fail(new V2PluginRuntimeError("unavailable", "Plugin Worker rejected a Host response")); }
    } finally {
      pending.resolvingCall = false;
    }
  }

  private readonly onWorkerError = () => this.fail(new V2PluginRuntimeError("guest_trap", "Plugin Worker terminated unexpectedly"));

  private fail(error: V2PluginRuntimeError): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      if (pending.kind === "invoke") pending.controller.abort(error);
      pending.reject(error);
    }
    this.pending.clear();
    this.releaseWorker();
    this.inFlight = false;
    this.stateValue = error.code === "cancelled" ? "stopped" : "failed";
  }

  private releaseWorker(): void {
    if (this.worker) {
      this.worker.removeEventListener("message", this.onMessage);
      this.worker.removeEventListener("error", this.onWorkerError);
      this.worker.terminate();
      this.worker = undefined;
    }
    if (this.capacityHeld) {
      activeWorkers = Math.max(0, activeWorkers - 1);
      this.capacityHeld = false;
    }
    this.grants.clear();
    if (this.component) this.component.fill(0);
    this.component = undefined;
  }
}

