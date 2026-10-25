import { verifyPluginArtifact, type PluginManifestV1 } from "../plugin-artifact.js";
import { CapabilityBroker } from "./capability-broker.js";
import { CAPABILITIES, deadlineFor, intersectCapabilities, LIMITS, PLUGIN_ABI, PluginRuntimeError, assertSnapshot, matchesResponse, utf8Size, type PluginCapability, type PluginTranscript, type RuntimeContext, type RuntimeSnapshot, type WorkerRequest, type WorkerResponse } from "./protocol.js";

export type PluginRuntimeState = "idle" | "starting" | "active" | "stopping" | "stopped" | "failed";

export interface RuntimeStartOptions {
  readonly context: RuntimeContext;
  readonly userGrants: readonly PluginCapability[];
  readonly hostAllowed: readonly PluginCapability[];
  readonly deadlineMs?: number;
}

export interface RuntimeInvokeOptions {
  readonly snapshot: RuntimeSnapshot;
  readonly isSnapshotCurrent: (snapshotId: string, revision: string) => boolean;
  readonly request: string;
  readonly deadlineMs?: number;
}

interface PendingRequest {
  readonly request: WorkerRequest;
  readonly resolve: (response: WorkerResponse) => void;
  readonly reject: (error: PluginRuntimeError) => void;
  timer: number;
}

let activeWorkers = 0;
let nextEpoch = 1;
const runtimeAdmissionToken = Symbol("proprium.plugin-runtime.admitted");
const admittedRuntimes = new WeakSet<object>();

function pinSnapshot(source: RuntimeSnapshot): RuntimeSnapshot {
  assertSnapshot(source);
  return Object.freeze({
    id: source.id,
    revision: source.revision,
    files: Object.freeze(source.files.map(file => Object.freeze({ path: file.path, revision: file.revision, content: file.content }))),
  });
}

function assertCurrentSnapshot(snapshot: RuntimeSnapshot, guard: RuntimeInvokeOptions["isSnapshotCurrent"]): void {
  if (typeof guard !== "function") throw new PluginRuntimeError("unavailable", "A Host snapshot freshness guard is required");
  let current: boolean;
  try { current = guard(snapshot.id, snapshot.revision); }
  catch { throw new PluginRuntimeError("unavailable", "Host snapshot freshness check failed"); }
  if (current !== true) throw new PluginRuntimeError("snapshot_stale", "The workspace snapshot changed during plugin execution");
}

function assertAdmittedRuntime(runtime: object): void {
  if (!admittedRuntimes.has(runtime)) {
    throw new PluginRuntimeError("untrusted_publisher", "Plugin runtime was not created through artifact admission");
  }
}

/** One lazy, host-owned Worker and one admitted Component instance. */
export class BrowserPluginRuntime {
  static async create(manifest: PluginManifestV1, component: Uint8Array): Promise<BrowserPluginRuntime> {
    if (manifest.abi !== PLUGIN_ABI) throw new PluginRuntimeError("incompatible_abi", `Unsupported plugin ABI ${manifest.abi}`);
    const unknownCapability = manifest.capabilities.find(capability => !CAPABILITIES.includes(capability as PluginCapability));
    if (unknownCapability) throw new PluginRuntimeError("incompatible_abi", `Unsupported required capability ${unknownCapability}`);
    if (!(component instanceof Uint8Array) || component.byteLength === 0 || component.byteLength > LIMITS.componentBytes) {
      throw new PluginRuntimeError("invalid_input", "Plugin Component is empty or exceeds the byte limit");
    }
    const admittedBytes = Uint8Array.from(component);
    await verifyPluginArtifact(manifest, manifest.entrypoint, admittedBytes);
    const artifact = manifest.artifacts.find(item => item.path === manifest.entrypoint);
    if (!artifact) throw new PluginRuntimeError("invalid_input", "Admitted manifest has no Component entrypoint");
    return new BrowserPluginRuntime(manifest, admittedBytes, artifact.sha256, runtimeAdmissionToken);
  }

  private readonly sessionId = crypto.randomUUID();
  private worker?: Worker;
  private component?: Uint8Array;
  private readonly digest: string;
  private epoch = 0;
  private workspaceId = "";
  private stateValue: PluginRuntimeState = "idle";
  private inFlight = false;
  private capacityHeld = false;
  private grants = new Set<PluginCapability>();
  private readonly pending = new Map<string, PendingRequest>();

  private constructor(readonly manifest: PluginManifestV1, component: Uint8Array, digest: string, admissionToken: symbol) {
    if (admissionToken !== runtimeAdmissionToken) {
      throw new PluginRuntimeError("untrusted_publisher", "Plugin runtime must be created through artifact admission");
    }
    this.component = component;
    this.digest = digest;
    admittedRuntimes.add(this);
  }

  get state(): PluginRuntimeState { assertAdmittedRuntime(this); return this.stateValue; }

  async start(options: RuntimeStartOptions): Promise<void> {
    assertAdmittedRuntime(this);
    if (this.stateValue !== "idle") throw new PluginRuntimeError("unavailable", `Cannot start a plugin in ${this.stateValue} state`);
    if (!this.component) throw new PluginRuntimeError("stopped", "Plugin Component has been destroyed");
    if (activeWorkers >= LIMITS.activeWorkers) throw new PluginRuntimeError("overloaded", "The browser plugin Worker limit is reached");
    if (!options.context || typeof options.context.workspaceId !== "string" || options.context.workspaceId.length < 1 ||
        options.context.workspaceId.length > 256 || options.context.pluginId !== this.manifest.id || options.context.version !== this.manifest.version) {
      throw new PluginRuntimeError("invalid_input", "Plugin activation context is invalid");
    }
    this.workspaceId = options.context.workspaceId;
    const grants = intersectCapabilities(this.manifest.capabilities, options.userGrants, options.hostAllowed);
    this.grants = new Set(grants);
    this.epoch = nextEpoch++;
    let worker: Worker;
    try { worker = new Worker(new URL("./component.worker.js", import.meta.url), { type: "module", name: `proprium-plugin-${this.manifest.id}` }); }
    catch { throw new PluginRuntimeError("unavailable", "This browser cannot start an isolated plugin Worker"); }
    this.worker = worker;
    this.stateValue = "starting";
    activeWorkers++;
    this.capacityHeld = true;
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerError);
    const request: WorkerRequest = {
      type: "start", id: crypto.randomUUID(), sessionId: this.sessionId, epoch: this.epoch,
      pluginId: this.manifest.id, version: this.manifest.version, digest: this.digest, workspaceId: this.workspaceId,
      deadlineAt: deadlineFor(options.deadlineMs ?? LIMITS.requestDeadlineMs), grants, context: options.context, component: this.component,
    };
    try {
      await this.exchange(request);
      this.stateValue = "active";
    } catch (error) {
      this.fail(error instanceof PluginRuntimeError ? error : new PluginRuntimeError("unavailable", "Plugin Worker failed during startup"));
      throw error;
    }
  }

  async invoke(options: RuntimeInvokeOptions): Promise<PluginTranscript> {
    assertAdmittedRuntime(this);
    if (this.stateValue !== "active" || !this.worker) throw new PluginRuntimeError("unavailable", "Plugin is not active");
    if (this.inFlight) throw new PluginRuntimeError("overloaded", "A plugin request is already running");
    if (typeof options.request !== "string" || utf8Size(options.request) > LIMITS.requestBytes) {
      throw new PluginRuntimeError("invalid_input", "Plugin request exceeds the byte limit");
    }
    const snapshot = pinSnapshot(options.snapshot);
    assertCurrentSnapshot(snapshot, options.isSnapshotCurrent);
    this.inFlight = true;
    const request: WorkerRequest = {
      type: "invoke", id: crypto.randomUUID(), sessionId: this.sessionId, epoch: this.epoch,
      pluginId: this.manifest.id, version: this.manifest.version, digest: this.digest, workspaceId: this.workspaceId,
      deadlineAt: deadlineFor(options.deadlineMs ?? LIMITS.requestDeadlineMs), grants: [...this.grants],
      snapshot, request: options.request,
    };
    try {
      const response = await this.exchange(request);
      if (!response.result) throw new PluginRuntimeError("malformed_message", "Plugin Worker omitted its invocation result");
      assertCurrentSnapshot(snapshot, options.isSnapshotCurrent);
      return this.validateTranscript(response.result, request);
    } catch (error) {
      if (error instanceof PluginRuntimeError && ["timeout", "guest_trap", "capability_denied", "malformed_message", "invalid_input"].includes(error.code)) this.fail(error);
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  async stop(): Promise<void> {
    assertAdmittedRuntime(this);
    if (this.stateValue === "stopped") return;
    if (this.inFlight) { this.cancel(); return; }
    if (this.stateValue === "idle") { this.releaseWorker(); this.stateValue = "stopped"; return; }
    if (!this.worker || this.stateValue === "failed") { this.releaseWorker(); this.stateValue = "stopped"; return; }
    this.stateValue = "stopping";
    try {
      await this.exchange({
        type: "stop", id: crypto.randomUUID(), sessionId: this.sessionId, epoch: this.epoch,
        pluginId: this.manifest.id, version: this.manifest.version, digest: this.digest, workspaceId: this.workspaceId,
        deadlineAt: deadlineFor(LIMITS.stopDeadlineMs), grants: [...this.grants],
      });
    } finally {
      this.releaseWorker();
      this.stateValue = "stopped";
    }
  }

  async destroy(): Promise<void> {
    assertAdmittedRuntime(this);
    await this.stop();
  }

  cancel(): void {
    assertAdmittedRuntime(this);
    this.fail(new PluginRuntimeError("canceled", "Plugin execution was canceled"));
  }

  private exchange(request: WorkerRequest): Promise<WorkerResponse> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new PluginRuntimeError("stopped", "Plugin Worker is stopped"));
    const encodedSize = request.type === "start"
      ? request.component.byteLength + utf8Size(JSON.stringify({ ...request, component: undefined }))
      : utf8Size(JSON.stringify(request));
    const messageLimit = request.type === "start" ? LIMITS.componentBytes + 64 * 1024
      : LIMITS.snapshotBytes + LIMITS.requestBytes + 64 * 1024;
    if (encodedSize > messageLimit) {
      return Promise.reject(new PluginRuntimeError("invalid_input", "Plugin Worker message exceeds the byte limit"));
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { request, resolve, reject, timer: 0 };
      pending.timer = window.setTimeout(() => {
        this.pending.delete(request.id);
        const error = new PluginRuntimeError("timeout", `Plugin ${request.type} exceeded its deadline`);
        reject(error);
        this.fail(error);
      }, Math.max(1, request.deadlineAt - Date.now()));
      this.pending.set(request.id, pending);
      try {
        if (request.type === "start") worker.postMessage(request, [request.component.buffer as ArrayBuffer]);
        else worker.postMessage(request);
      }
      catch { window.clearTimeout(pending.timer); this.pending.delete(request.id); reject(new PluginRuntimeError("unavailable", "Plugin Worker rejected the request")); }
    });
  }

  private readonly onMessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pending.delete(response.id);
    let responseBytes = Number.POSITIVE_INFINITY;
    try { responseBytes = utf8Size(JSON.stringify(response) ?? ""); } catch { /* Reject non-JSON structured payloads below. */ }
    if (responseBytes > LIMITS.outputBytes + 64 * 1024) {
      const error = new PluginRuntimeError("malformed_message", "Plugin Worker response exceeds the byte limit");
      pending.reject(error);
      this.fail(error);
      return;
    }
    if (!matchesResponse(pending.request, response)) {
      const error = new PluginRuntimeError("malformed_message", "Plugin Worker returned a stale or mismatched response");
      pending.reject(error);
      this.fail(error);
      return;
    }
    if (response.error) {
      pending.reject(new PluginRuntimeError(response.error.code, response.error.message));
      return;
    }
    pending.resolve(response);
  };

  private readonly onWorkerError = () => this.fail(new PluginRuntimeError("guest_trap", "Plugin Worker terminated unexpectedly"));

  private validateTranscript(value: PluginTranscript, request: Extract<WorkerRequest, { type: "invoke" }>): PluginTranscript {
    if (!value || value.requestId !== request.id || value.sessionId !== request.sessionId || value.epoch !== request.epoch ||
        value.pluginId !== request.pluginId || value.version !== request.version || value.digest !== request.digest ||
        value.workspaceId !== request.workspaceId || value.deadlineAt !== request.deadlineAt ||
        value.snapshotId !== request.snapshot.id || value.snapshotRevision !== request.snapshot.revision ||
        !Array.isArray(value.grants) || value.grants.length !== request.grants.length ||
        value.grants.some((grant, index) => grant !== request.grants[index]) ||
        typeof value.value !== "string" || utf8Size(value.value) > LIMITS.outputBytes ||
        !Array.isArray(value.reads) || !Array.isArray(value.proposals) || !Array.isArray(value.contributions)) {
      throw new PluginRuntimeError("malformed_message", "Plugin Worker returned an invalid invocation transcript");
    }
    const broker = new CapabilityBroker(this.grants, request, false);
    for (const read of value.reads) broker.validateRead(read);
    for (const proposal of value.proposals) broker.proposeChange(proposal);
    for (const contribution of value.contributions) broker.uiContribute(contribution);
    return broker.transcript(value.value);
  }

  private fail(error: PluginRuntimeError): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.releaseWorker();
    this.stateValue = error.code === "canceled" ? "stopped" : "failed";
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
    if (this.component?.buffer.byteLength) this.component.fill(0);
    this.component = undefined;
  }
}
