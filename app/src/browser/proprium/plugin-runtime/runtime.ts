import { verifyPluginArtifact, type PluginManifestV1 } from "../plugin-artifact.js";
import { CAPABILITIES, LIMITS, PLUGIN_ABI, PluginRuntimeError, assertSnapshot, matchesResponse, utf8Size, type PluginCapability, type PluginTranscript, type RuntimeContext, type RuntimeSnapshot, type WorkerRequest, type WorkerResponse } from "./protocol.js";

export type PluginRuntimeState = "idle" | "starting" | "active" | "stopping" | "stopped" | "failed";

export interface RuntimeStartOptions {
  readonly context: RuntimeContext;
  readonly deadlineMs?: number;
}

export interface RuntimeInvokeOptions {
  readonly snapshot: RuntimeSnapshot;
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

/** One lazy, host-owned Worker and one admitted Component instance. */
export class BrowserPluginRuntime {
  static async create(manifest: PluginManifestV1, component: Uint8Array): Promise<BrowserPluginRuntime> {
    if (manifest.abi !== PLUGIN_ABI) throw new PluginRuntimeError("incompatible_abi", `Unsupported plugin ABI ${manifest.abi}`);
    const unknownCapability = manifest.capabilities.find(capability => !CAPABILITIES.includes(capability as PluginCapability));
    if (unknownCapability) throw new PluginRuntimeError("incompatible_abi", `Unsupported required capability ${unknownCapability}`);
    await verifyPluginArtifact(manifest, manifest.entrypoint, component);
    return new BrowserPluginRuntime(manifest, component.slice());
  }

  private worker?: Worker;
  private epoch = 0;
  private workspaceId = "";
  private stateValue: PluginRuntimeState = "idle";
  private inFlight = false;
  private capacityHeld = false;
  private readonly pending = new Map<string, PendingRequest>();

  private constructor(readonly manifest: PluginManifestV1, private readonly component: Uint8Array) {}

  get state(): PluginRuntimeState { return this.stateValue; }

  async start(options: RuntimeStartOptions): Promise<void> {
    if (this.stateValue !== "idle") throw new PluginRuntimeError("unavailable", `Cannot start a plugin in ${this.stateValue} state`);
    if (activeWorkers >= LIMITS.activeWorkers) throw new PluginRuntimeError("overloaded", "The browser plugin Worker limit is reached");
    if (!options.context || typeof options.context.workspaceId !== "string" || options.context.workspaceId.length < 1 ||
        options.context.workspaceId.length > 256 || options.context.pluginId !== this.manifest.id || options.context.version !== this.manifest.version) {
      throw new PluginRuntimeError("invalid_input", "Plugin activation context is invalid");
    }
    this.workspaceId = options.context.workspaceId;
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
      type: "start", id: crypto.randomUUID(), epoch: this.epoch, workspaceId: this.workspaceId,
      pluginId: this.manifest.id, version: this.manifest.version, context: options.context, component: this.component,
    };
    try {
      await this.exchange(request, options.deadlineMs ?? LIMITS.requestDeadlineMs);
      this.stateValue = "active";
    } catch (error) {
      this.fail(error instanceof PluginRuntimeError ? error : new PluginRuntimeError("unavailable", "Plugin Worker failed during startup"));
      throw error;
    }
  }

  async invoke(options: RuntimeInvokeOptions): Promise<PluginTranscript> {
    if (this.stateValue !== "active" || !this.worker) throw new PluginRuntimeError("unavailable", "Plugin is not active");
    if (this.inFlight) throw new PluginRuntimeError("overloaded", "A plugin request is already running");
    if (typeof options.request !== "string" || utf8Size(options.request) > LIMITS.requestBytes) {
      throw new PluginRuntimeError("invalid_input", "Plugin request exceeds the byte limit");
    }
    assertSnapshot(options.snapshot);
    this.inFlight = true;
    const request: WorkerRequest = {
      type: "invoke", id: crypto.randomUUID(), epoch: this.epoch, workspaceId: this.workspaceId,
      snapshotId: options.snapshot.id, snapshotRevision: options.snapshot.revision, request: options.request,
    };
    try {
      const response = await this.exchange(request, options.deadlineMs ?? LIMITS.requestDeadlineMs);
      if (!response.result) throw new PluginRuntimeError("malformed_message", "Plugin Worker omitted its invocation result");
      return this.validateTranscript(response.result, request);
    } catch (error) {
      if (error instanceof PluginRuntimeError && ["timeout", "guest_trap", "capability_denied", "malformed_message", "invalid_input"].includes(error.code)) this.fail(error);
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stateValue === "stopped") return;
    if (this.inFlight) { this.cancel(); return; }
    if (this.stateValue === "idle") { this.stateValue = "stopped"; return; }
    if (!this.worker || this.stateValue === "failed") { this.releaseWorker(); this.stateValue = "stopped"; return; }
    this.stateValue = "stopping";
    try {
      await this.exchange({ type: "stop", id: crypto.randomUUID(), epoch: this.epoch, workspaceId: this.workspaceId }, LIMITS.stopDeadlineMs);
    } finally {
      this.releaseWorker();
      this.stateValue = "stopped";
    }
  }

  cancel(): void {
    this.fail(new PluginRuntimeError("canceled", "Plugin execution was canceled"));
  }

  private exchange(request: WorkerRequest, deadlineMs: number): Promise<WorkerResponse> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new PluginRuntimeError("stopped", "Plugin Worker is stopped"));
    const encodedSize = request.type === "start"
      ? request.component.byteLength + utf8Size(JSON.stringify({ ...request, component: undefined }))
      : utf8Size(JSON.stringify(request));
    const messageLimit = request.type === "start" ? LIMITS.componentBytes + 64 * 1024 : LIMITS.requestBytes + 8 * 1024;
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
      }, Math.max(1, Math.min(deadlineMs, 60_000)));
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
    if (!value || value.requestId !== request.id || value.epoch !== request.epoch || value.workspaceId !== request.workspaceId ||
        value.snapshotId !== request.snapshotId || typeof value.value !== "string" || utf8Size(value.value) > LIMITS.outputBytes) {
      throw new PluginRuntimeError("malformed_message", "Plugin Worker returned an invalid invocation transcript");
    }
    return value;
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
  }
}
