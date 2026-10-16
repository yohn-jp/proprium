import { fork, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { MAX_JOB_INPUT_BYTES, MAX_JOB_OUTPUT_BYTES, snapshotKey, type JobOutcome, type JobRequest, type JobResult, type MachineError, type ModuleId, type WorkerService } from "@scriptorium/contracts";
import { isModuleId, ModuleRuntimeError } from "./runtime-error.js";

type WorkerResponse =
  | { type: "result"; result: JobResult }
  | { type: "error"; id: string; snapshot: JobRequest["snapshot"]; error: MachineError };

interface WorkerRecord {
  request: JobRequest;
  workerEntry: string;
  child?: ChildProcess;
  promise: Promise<JobOutcome>;
  resolve(value: JobOutcome): void;
  state: "queued" | "starting" | "running" | "settled";
  response?: WorkerResponse;
  stopError?: MachineError;
  exiting: boolean;
  deadlineTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export interface WorkerSupervisorOptions {
  /** Maximum one-shot child processes at once; defaults to available CPUs, capped at 8. */
  maxConcurrentJobs?: number;
  /** Maximum one-shot requests waiting for a process slot; defaults to 8 (64 MiB at the input bound). */
  maxQueuedJobs?: number;
  /** Maximum live persistent worker processes; defaults to the eight installed module IDs. */
  maxWorkerServices?: number;
  /** Maximum jobs dispatched to one persistent service; defaults to 1 to serialize model access. */
  maxConcurrentServiceJobs?: number;
  /** Maximum jobs waiting for one persistent service; defaults to 4 (32 MiB at the input bound). */
  maxQueuedServiceJobs?: number;
  /** Absolute Node executable used to launch workers; defaults to process.execPath. */
  workerExecPath?: string;
  maxJobDurationMs?: number;
  cancellationGraceMs?: number;
}

const DEFAULT_MAX_CONCURRENT_JOBS = Math.max(1, Math.min(availableParallelism(), 8));

function boundedOption(name: string, value: number | undefined, fallback: number, allowZero = false): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be a finite ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return result;
}

function machineError(code: string, message: string, retryable = false): MachineError {
  return { code, message: message.slice(0, 512), retryable };
}

function failure<T>(request: JobRequest, error: MachineError): JobOutcome<T> {
  return { ok: false, id: request.id, snapshot: request.snapshot, error };
}

function encodeJson(value: unknown): { text: string; bytes: number } {
  const text = JSON.stringify(value);
  if (text === undefined) throw new ModuleRuntimeError("invalid_job_payload", "Job payload is not JSON serializable");
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

function validRequest(value: unknown): value is JobRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as JobRequest;
  const snapshot = request.snapshot;
  const repository = snapshot?.repository;
  return typeof request.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(request.id) &&
    isModuleId(request.module) && typeof request.task === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(request.task) &&
    !!snapshot && typeof snapshot === "object" && !!snapshot.repository && typeof snapshot.remoteCommit === "string" &&
    (repository.provider === "github" || repository.provider === "local") &&
    [repository.repositoryId, repository.defaultBranch, repository.ownerScope, repository.url].every((item) => typeof item === "string" && item.length > 0 && item.length <= 512) &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64}|)$/.test(snapshot.remoteCommit) &&
    (snapshot.overlayCommit === undefined || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.overlayCommit)) &&
    typeof request.model === "string" && request.model.length > 0 && request.model.length <= 128 &&
    typeof request.modelVersion === "string" && request.modelVersion.length > 0 && request.modelVersion.length <= 128 &&
    typeof request.moduleVersion === "string" && request.moduleVersion.length > 0 && request.moduleVersion.length <= 128 &&
    Number.isSafeInteger(request.deadline) && request.deadline > 0;
}

function workerError(value: unknown): MachineError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = value as Partial<MachineError>;
  if (typeof error.code !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(error.code) ||
      typeof error.message !== "string" || typeof error.retryable !== "boolean") return undefined;
  return machineError(error.code, error.message, error.retryable);
}

function workerEnvironment(mode: "job" | "service" = "job"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"] as const) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.SCRIPTORIUM_WORKER_MODE = mode;
  return env;
}

/** Starts one supervised child process per bounded job. */
export class WorkerSupervisor {
  private readonly jobs = new Map<string, WorkerRecord>();
  private readonly queuedJobs = new Map<string, WorkerRecord>();
  private readonly jobQueue: WorkerRecord[] = [];
  private readonly services = new Set<SupervisedWorkerService>();
  private readonly maxConcurrentJobs: number;
  private readonly maxQueuedJobs: number;
  private readonly maxWorkerServices: number;
  private readonly maxConcurrentServiceJobs: number;
  private readonly maxQueuedServiceJobs: number;
  private readonly workerExecPath: string;
  private readonly maxJobDurationMs: number;
  private readonly cancellationGraceMs: number;
  private closed = false;

  constructor(options: WorkerSupervisorOptions = {}) {
    this.maxConcurrentJobs = boundedOption("maxConcurrentJobs", options.maxConcurrentJobs, DEFAULT_MAX_CONCURRENT_JOBS);
    this.maxQueuedJobs = boundedOption("maxQueuedJobs", options.maxQueuedJobs, 8, true);
    this.maxWorkerServices = boundedOption("maxWorkerServices", options.maxWorkerServices, 8);
    this.maxConcurrentServiceJobs = boundedOption("maxConcurrentServiceJobs", options.maxConcurrentServiceJobs, 1);
    this.maxQueuedServiceJobs = boundedOption("maxQueuedServiceJobs", options.maxQueuedServiceJobs, 4, true);
    this.workerExecPath = options.workerExecPath ?? process.execPath;
    if (!path.isAbsolute(this.workerExecPath)) throw new RangeError("workerExecPath must be absolute");
    this.maxJobDurationMs = options.maxJobDurationMs ?? 15 * 60_000;
    this.cancellationGraceMs = options.cancellationGraceMs ?? 250;
    if (!Number.isSafeInteger(this.maxJobDurationMs) || this.maxJobDurationMs < 1 || this.maxJobDurationMs > 24 * 60 * 60_000 ||
        !Number.isSafeInteger(this.cancellationGraceMs) || this.cancellationGraceMs < 1 || this.cancellationGraceMs > 10_000) {
      throw new RangeError("Invalid worker supervisor bounds");
    }
  }

  get activeJobCount(): number {
    return this.jobs.size + this.queuedJobs.size + [...this.services].reduce((total, service) => total + service.activeJobCount, 0);
  }

  activeJobCountFor(module: ModuleId): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.request.module === module) count += 1;
    for (const job of this.queuedJobs.values()) if (job.request.module === module) count += 1;
    for (const service of this.services) if (service.module === module) count += service.activeJobCount;
    return count;
  }

  /** Local process IDs support shutdown diagnostics and lifecycle acceptance checks. */
  get activeWorkerPids(): readonly number[] {
    return [
      ...[...this.jobs.values()].map((job) => job.child?.pid),
      ...[...this.services].map((service) => service.pid),
    ].filter((pid): pid is number => pid !== undefined);
  }

  async createService(module: ModuleId, moduleVersion: string, workerEntry: string, signal?: AbortSignal): Promise<WorkerService> {
    if (this.closed) throw new ModuleRuntimeError("runtime_shutdown", "Worker supervisor is shut down", true);
    if (signal?.aborted) throw new ModuleRuntimeError("module_disabled", "Worker service creation was cancelled", true);
    if (this.services.size >= this.maxWorkerServices) {
      throw new ModuleRuntimeError("worker_overloaded", `Worker service limit (${this.maxWorkerServices}) has been reached`, true);
    }
    if (!path.isAbsolute(workerEntry)) throw new ModuleRuntimeError("invalid_worker_entry", "Worker entry point must be an absolute installed-module path");
    const service = new SupervisedWorkerService(
      module,
      moduleVersion,
      workerEntry,
      this.maxJobDurationMs,
      this.cancellationGraceMs,
      this.maxConcurrentServiceJobs,
      this.maxQueuedServiceJobs,
      this.workerExecPath,
      () => this.services.delete(service),
      (id) => this.jobs.has(id) || this.queuedJobs.has(id) || [...this.services].some((candidate) => candidate.hasJob(id)),
    );
    this.services.add(service);
    try {
      await service.start();
      if (this.closed || signal?.aborted) {
        await service.dispose();
        throw new ModuleRuntimeError(signal?.aborted ? "module_disabled" : "runtime_shutdown", "Worker service creation was cancelled", true);
      }
      if (signal) {
        const abort = () => { void service.dispose(); };
        signal.addEventListener("abort", abort, { once: true });
        service.onDispose(() => signal.removeEventListener("abort", abort));
      }
      return service;
    } catch (error) {
      await service.dispose();
      throw error;
    }
  }

  async run<T = unknown>(request: JobRequest, workerEntry: string, signal?: AbortSignal): Promise<JobOutcome<T>> {
    if (!validRequest(request)) {
      const invalid = request as unknown as Partial<JobRequest> | null;
      const safeRequest = { id: typeof invalid?.id === "string" ? invalid.id : "invalid", snapshot: invalid?.snapshot ?? {} } as JobRequest;
      return failure(safeRequest, machineError("invalid_job_request", "Job request is invalid")) as JobOutcome<T>;
    }
    if (this.closed) return failure<T>(request, machineError("runtime_shutdown", "Worker supervisor is shut down", true));
    if (signal?.aborted) return failure<T>(request, machineError("job_cancelled", "Job was cancelled"));
    if (this.jobs.has(request.id) || this.queuedJobs.has(request.id) || [...this.services].some((service) => service.hasJob(request.id))) {
      return failure<T>(request, machineError("duplicate_job_id", "A job with this ID is already running"));
    }
    let serializedRequest: JobRequest;
    try {
      const encoded = encodeJson(request);
      if (encoded.bytes > MAX_JOB_INPUT_BYTES) return failure<T>(request, machineError("job_input_too_large", `Job request exceeds ${MAX_JOB_INPUT_BYTES} UTF-8 bytes`));
      serializedRequest = JSON.parse(encoded.text) as JobRequest;
    } catch (error) {
      return failure<T>(request, machineError("invalid_job_request", error instanceof Error ? error.message : "Job request is not JSON serializable"));
    }
    const remainingMs = request.deadline - Date.now();
    if (remainingMs <= 0) return failure<T>(request, machineError("job_deadline_exceeded", "Job deadline has already expired", true));
    if (remainingMs > this.maxJobDurationMs) return failure<T>(request, machineError("job_deadline_out_of_bounds", `Job deadline exceeds the ${this.maxJobDurationMs} ms runtime bound`));
    if (!path.isAbsolute(workerEntry)) return failure<T>(request, machineError("invalid_worker_entry", "Worker entry point must be an absolute installed-module path"));
    const activeRequest = serializedRequest;
    let resolve!: (result: JobOutcome) => void;
    const promise = new Promise<JobOutcome>((done) => { resolve = done; });
    const queued = this.jobs.size >= this.maxConcurrentJobs;
    if (queued && this.queuedJobs.size >= this.maxQueuedJobs) {
      return failure<T>(activeRequest, machineError("worker_overloaded", "Worker job queue is full", true));
    }
    const record: WorkerRecord = { request: activeRequest, workerEntry, promise, resolve, state: queued ? "queued" : "starting", exiting: false };
    if (queued) {
      this.queuedJobs.set(activeRequest.id, record);
      this.jobQueue.push(record);
    } else {
      this.jobs.set(activeRequest.id, record);
      void this.startJob(record);
    }
    record.deadlineTimer = setTimeout(() => this.stop(record, machineError("job_deadline_exceeded", "Job exceeded its deadline", true)), remainingMs);
    if (signal) {
      record.abortSignal = signal;
      record.abortListener = () => this.stop(record, machineError("job_cancelled", "Job was cancelled"));
      signal.addEventListener("abort", record.abortListener, { once: true });
    }
    return (await promise) as JobOutcome<T>;
  }

  async cancel(id: string): Promise<boolean> {
    const record = this.jobs.get(id) ?? this.queuedJobs.get(id);
    if (record && !record.response && !record.stopError) {
      this.stop(record, machineError("job_cancelled", "Job was cancelled"));
      await record.promise;
      return true;
    }
    for (const service of this.services) if (service.cancel(id)) return true;
    return false;
  }

  async cancelModule(module: ModuleId): Promise<void> {
    const records = [...this.jobs.values(), ...this.queuedJobs.values()].filter((job) => job.request.module === module);
    for (const record of records) this.stop(record, machineError("job_cancelled", `Module ${module} was disabled`));
    await Promise.all([
      ...records.map((record) => record.promise),
      ...[...this.services].filter((service) => service.module === module).map((service) => service.cancelAllJobs("Module was disabled")),
    ]);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.jobs.values(), ...this.queuedJobs.values()];
    for (const record of records) this.stop(record, machineError("runtime_shutdown", "Runtime shutdown cancelled the job", true));
    await Promise.all([
      ...records.map((record) => record.promise),
      ...[...this.services].map((service) => service.dispose()),
    ]);
  }

  private async startJob(record: WorkerRecord): Promise<void> {
    if (this.jobs.get(record.request.id) !== record || record.state !== "starting") return;
    let workerAvailable = false;
    try { workerAvailable = (await stat(record.workerEntry)).isFile(); } catch { workerAvailable = false; }
    if (this.jobs.get(record.request.id) !== record || record.state !== "starting") return;
    if (this.closed) {
      this.finishWithoutChild(record, machineError("runtime_shutdown", "Runtime shutdown cancelled the job", true));
      return;
    }
    const remainingMs = record.request.deadline - Date.now();
    if (remainingMs <= 0) {
      this.finishWithoutChild(record, machineError("job_deadline_exceeded", "Job deadline expired before the worker started", true));
      return;
    }
    if (!workerAvailable) {
      this.finishWithoutChild(record, machineError("worker_entry_missing", "Worker entry point is unavailable", true));
      return;
    }

    let child: ChildProcess;
    try {
      child = fork(record.workerEntry, [], {
        cwd: path.dirname(record.workerEntry),
        env: workerEnvironment("job"),
        execArgv: [],
        execPath: this.workerExecPath,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
    } catch (error) {
      this.finishWithoutChild(record, machineError("worker_start_failed", error instanceof Error ? error.message : "Worker could not start", true));
      return;
    }

    record.child = child;
    record.state = "running";
    child.on("message", (message: unknown) => this.receive(record, message));
    child.once("error", (error) => {
      if (!record.response && !record.stopError) {
        record.stopError = machineError(child.pid === undefined ? "worker_start_failed" : "worker_failed", error.message || "Worker process failed", true);
      }
      this.terminate(record);
    });
    const finish = (code: number | null, signalName: NodeJS.Signals | null) => this.onExit(record, code, signalName);
    child.once("exit", finish);
    child.once("close", finish);
    child.send({ type: "job", request: record.request }, (error) => {
      if (error && !record.response && !record.stopError) {
        record.stopError = machineError("worker_ipc_failed", error.message, true);
        this.terminate(record);
      }
    });
  }

  private pumpJobs(): void {
    if (this.closed) return;
    while (this.jobs.size < this.maxConcurrentJobs && this.jobQueue.length > 0) {
      const record = this.jobQueue.shift()!;
      if (this.queuedJobs.get(record.request.id) !== record || record.state !== "queued") continue;
      this.queuedJobs.delete(record.request.id);
      record.state = "starting";
      this.jobs.set(record.request.id, record);
      void this.startJob(record);
    }
  }

  private finishWithoutChild(record: WorkerRecord, error: MachineError): void {
    if (record.state === "settled") return;
    if (this.jobs.get(record.request.id) === record) this.jobs.delete(record.request.id);
    if (this.queuedJobs.get(record.request.id) === record) this.queuedJobs.delete(record.request.id);
    const queuedIndex = this.jobQueue.indexOf(record);
    if (queuedIndex >= 0) this.jobQueue.splice(queuedIndex, 1);
    record.state = "settled";
    this.clearJobTimers(record);
    record.resolve(failure(record.request, error));
    this.pumpJobs();
  }

  private clearJobTimers(record: WorkerRecord): void {
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
    if (record.graceTimer) clearTimeout(record.graceTimer);
    if (record.killTimer) clearTimeout(record.killTimer);
    record.deadlineTimer = undefined;
    record.graceTimer = undefined;
    record.killTimer = undefined;
    if (record.abortSignal && record.abortListener) record.abortSignal.removeEventListener("abort", record.abortListener);
  }

  private receive(record: WorkerRecord, message: unknown): void {
    if (!message || typeof message !== "object") {
      this.stop(record, machineError("worker_protocol_error", "Worker returned an invalid message"));
      return;
    }
    const envelope = message as { type?: unknown; result?: unknown; id?: unknown; snapshot?: unknown; error?: unknown };
    if (envelope.type === "ready") return;
    if (record.response) {
      this.stop(record, machineError("worker_protocol_error", "Worker returned more than one result"));
      return;
    }
    if (envelope.type === "error") {
      const error = workerError(envelope.error);
      if (envelope.id !== record.request.id || !error || !sameSnapshot(envelope.snapshot, record.request.snapshot)) {
        this.stop(record, machineError("worker_protocol_error", "Worker returned a mismatched error response"));
        return;
      }
      record.response = { type: "error", id: record.request.id, snapshot: record.request.snapshot, error };
      if (!record.stopError) this.terminate(record);
      return;
    }
    if (envelope.type !== "result" || !envelope.result || typeof envelope.result !== "object") {
      this.stop(record, machineError("worker_protocol_error", "Worker returned an invalid result envelope"));
      return;
    }
    const result = envelope.result as JobResult;
    if (result.id !== record.request.id || !sameSnapshot(result.snapshot, record.request.snapshot) ||
        result.model !== record.request.model || result.modelVersion !== record.request.modelVersion ||
        result.moduleVersion !== record.request.moduleVersion || !isModuleId(record.request.module)) {
      this.stop(record, machineError("worker_identity_mismatch", "Worker result does not match the requested snapshot or module/model version"));
      return;
    }
    try {
      const encoded = encodeJson(result);
      if (encoded.bytes > MAX_JOB_OUTPUT_BYTES) {
        this.stop(record, machineError("job_output_too_large", `Job result exceeds ${MAX_JOB_OUTPUT_BYTES} UTF-8 bytes`));
        return;
      }
      const sanitized = JSON.parse(encoded.text) as JobResult;
      record.response = { type: "result", result: sanitized };
    } catch (error) {
      this.stop(record, machineError("invalid_job_output", error instanceof Error ? error.message : "Job result is not JSON serializable"));
      return;
    }
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
    record.deadlineTimer = undefined;
    if (record.abortSignal && record.abortListener) record.abortSignal.removeEventListener("abort", record.abortListener);
    this.terminate(record);
  }

  private stop(record: WorkerRecord, error: MachineError): void {
    if (record.exiting || record.state === "settled" || record.response || record.stopError) return;
    record.stopError = error;
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
    record.deadlineTimer = undefined;
    if (record.abortSignal && record.abortListener) record.abortSignal.removeEventListener("abort", record.abortListener);
    if (record.state === "queued" || record.state === "starting") {
      this.finishWithoutChild(record, error);
      return;
    }
    const child = record.child;
    if (child?.connected) {
      child.send({ type: "cancel", id: record.request.id }, () => {});
      record.graceTimer = setTimeout(() => this.terminate(record), this.cancellationGraceMs);
    } else {
      this.terminate(record);
    }
  }

  private terminate(record: WorkerRecord): void {
    const child = record.child;
    if (record.exiting || !child || child.killed) return;
    if (record.graceTimer) clearTimeout(record.graceTimer);
    record.graceTimer = undefined;
    child.kill("SIGTERM");
    record.killTimer = setTimeout(() => {
      if (!record.exiting) child.kill("SIGKILL");
    }, this.cancellationGraceMs);
  }

  private onExit(record: WorkerRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (record.exiting) return;
    record.exiting = true;
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
    if (record.graceTimer) clearTimeout(record.graceTimer);
    if (record.killTimer) clearTimeout(record.killTimer);
    if (record.abortSignal && record.abortListener) record.abortSignal.removeEventListener("abort", record.abortListener);
    if (this.jobs.get(record.request.id) === record) this.jobs.delete(record.request.id);
    record.state = "settled";
    if (record.stopError) {
      record.resolve({ ok: false, id: record.request.id, snapshot: record.request.snapshot, error: record.stopError });
    } else if (record.response?.type === "error") {
      record.resolve({ ok: false, id: record.request.id, snapshot: record.request.snapshot, error: record.response.error });
    } else if (record.response?.type === "result") {
      record.resolve({ ok: true, result: record.response.result });
    } else {
      record.resolve({ ok: false, id: record.request.id, snapshot: record.request.snapshot,
        error: machineError("worker_exited", `Worker exited without a result (code ${String(code)}, signal ${String(signal)})`, true) });
    }
    this.pumpJobs();
  }
}

interface ServiceJobRecord {
  request: JobRequest;
  promise: Promise<JobOutcome>;
  resolve(value: JobOutcome): void;
  state: "queued" | "active";
  dispatched: boolean;
  stopError?: MachineError;
  deadlineTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

/** One reusable child process owned by a capability provider and shared by its consumers. */
class SupervisedWorkerService implements WorkerService {
  readonly module: ModuleId;
  private readonly moduleVersion: string;
  private readonly workerEntry: string;
  private readonly maxJobDurationMs: number;
  private readonly cancellationGraceMs: number;
  private readonly maxConcurrentServiceJobs: number;
  private readonly maxQueuedServiceJobs: number;
  private readonly workerExecPath: string;
  private readonly onRemoved: () => void;
  private readonly isDuplicateJobId: (id: string) => boolean;
  private readonly jobs = new Map<string, ServiceJobRecord>();
  private readonly records = new Map<string, ServiceJobRecord>();
  private readonly jobQueue: ServiceJobRecord[] = [];
  private child?: ChildProcess;
  private startPromise?: Promise<void>;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private terminalError?: MachineError;
  private disposal?: Promise<void>;
  private disposed = false;
  private exitSeen = false;
  private ready = false;
  private readyTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private readonly disposeCallbacks: Array<() => void> = [];

  constructor(
    module: ModuleId,
    moduleVersion: string,
    workerEntry: string,
    maxJobDurationMs: number,
    cancellationGraceMs: number,
    maxConcurrentServiceJobs: number,
    maxQueuedServiceJobs: number,
    workerExecPath: string,
    onRemoved: () => void,
    isDuplicateJobId: (id: string) => boolean,
  ) {
    this.module = module;
    this.moduleVersion = moduleVersion;
    this.workerEntry = workerEntry;
    this.maxJobDurationMs = maxJobDurationMs;
    this.cancellationGraceMs = cancellationGraceMs;
    this.maxConcurrentServiceJobs = maxConcurrentServiceJobs;
    this.maxQueuedServiceJobs = maxQueuedServiceJobs;
    this.workerExecPath = workerExecPath;
    this.onRemoved = onRemoved;
    this.isDuplicateJobId = isDuplicateJobId;
  }

  get pid(): number | undefined { return this.exited ? undefined : this.child?.pid; }
  get activeJobCount(): number { return this.records.size; }
  hasJob(id: string): boolean { return this.records.has(id); }

  onDispose(callback: () => void): void {
    if (this.disposed) callback();
    else this.disposeCallbacks.push(callback);
  }

  async start(): Promise<void> {
    if (this.disposed) throw new ModuleRuntimeError("worker_service_disposed", "Worker service is disposed");
    if (!this.startPromise) this.startPromise = this.startChild();
    return this.startPromise;
  }

  async request<T = unknown>(request: JobRequest, signal?: AbortSignal): Promise<JobOutcome<T>> {
    if (!validRequest(request)) return failure(request as JobRequest, machineError("invalid_job_request", "Job request is invalid")) as JobOutcome<T>;
    if (request.module !== this.module || request.moduleVersion !== this.moduleVersion) {
      return failure<T>(request, machineError("job_identity_mismatch", "Worker service accepts jobs only for its owning module and installed version"));
    }
    if (this.disposed) return failure<T>(request, machineError("worker_service_disposed", "Worker service is disposed", true));
    if (!signal) return failure<T>(request, machineError("job_cancellation_required", "Shared worker requests require the consumer AbortSignal"));
    if (signal?.aborted) return failure<T>(request, machineError("job_cancelled", "Job was cancelled"));
    if (this.isDuplicateJobId(request.id)) return failure<T>(request, machineError("duplicate_job_id", "A job with this ID is already running"));

    let serialized: JobRequest;
    try {
      const encoded = encodeJson(request);
      if (encoded.bytes > MAX_JOB_INPUT_BYTES) return failure<T>(request, machineError("job_input_too_large", `Job request exceeds ${MAX_JOB_INPUT_BYTES} UTF-8 bytes`));
      serialized = JSON.parse(encoded.text) as JobRequest;
    } catch (error) {
      return failure<T>(request, machineError("invalid_job_request", error instanceof Error ? error.message : "Job request is not JSON serializable"));
    }
    const remainingMs = serialized.deadline - Date.now();
    if (remainingMs <= 0) return failure<T>(serialized, machineError("job_deadline_exceeded", "Job deadline has already expired", true));
    if (remainingMs > this.maxJobDurationMs) return failure<T>(serialized, machineError("job_deadline_out_of_bounds", `Job deadline exceeds the ${this.maxJobDurationMs} ms runtime bound`));
    let resolve!: (result: JobOutcome) => void;
    const promise = new Promise<JobOutcome>((done) => { resolve = done; });
    const queued = this.jobs.size >= this.maxConcurrentServiceJobs;
    if (queued && this.jobQueue.length >= this.maxQueuedServiceJobs) {
      return failure<T>(serialized, machineError("worker_overloaded", "Persistent worker service queue is full", true));
    }
    const record: ServiceJobRecord = { request: serialized, promise, resolve, state: queued ? "queued" : "active", dispatched: false };
    this.records.set(serialized.id, record);
    if (!queued) this.jobs.set(serialized.id, record);
    record.deadlineTimer = setTimeout(() => this.stopJob(record, machineError("job_deadline_exceeded", "Job exceeded its deadline", true)), remainingMs);
    record.abortSignal = signal;
    record.abortListener = () => this.stopJob(record, machineError("job_cancelled", "Job was cancelled"));
    signal.addEventListener("abort", record.abortListener, { once: true });
    if (queued) this.jobQueue.push(record);
    else void this.dispatch(record);
    return (await promise) as JobOutcome<T>;
  }

  cancel(jobId: string): boolean {
    const record = this.records.get(jobId);
    if (!record || record.stopError) return false;
    this.stopJob(record, machineError("job_cancelled", "Job was cancelled"));
    return true;
  }

  async cancelAllJobs(message: string): Promise<void> {
    const records = [...this.records.values()];
    for (const record of records) this.stopJob(record, machineError("job_cancelled", message));
    await Promise.all(records.map((record) => record.promise));
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await this.cancelAllJobs("Worker service was released");
      const child = this.child;
      if (!child) {
        this.finishDispose();
        return;
      }
      if (child.connected) {
        try { child.send({ type: "shutdown" }, () => {}); } catch { /* Process exit is awaited below. */ }
      }
      const exited = this.exitPromise ?? Promise.resolve();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.cancellationGraceMs); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!this.exited) {
        child.kill("SIGTERM");
        await Promise.race([
          exited,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, this.cancellationGraceMs); }),
        ]);
        if (timer) clearTimeout(timer);
      }
      if (!this.exited) child.kill("SIGKILL");
      await exited;
      this.finishDispose();
    })();
    return this.disposal;
  }

  private get exited(): boolean { return this.exitSeen; }

  private async startChild(): Promise<void> {
    let workerAvailable = false;
    try { workerAvailable = (await stat(this.workerEntry)).isFile(); } catch { workerAvailable = false; }
    if (!workerAvailable) {
      const error = machineError("worker_entry_missing", "Worker entry point is unavailable", true);
      this.terminalError = error;
      throw new ModuleRuntimeError(error.code, error.message, true);
    }
    if (this.disposed) throw new ModuleRuntimeError("worker_service_disposed", "Worker service is disposed");
    const child = fork(this.workerEntry, [], {
      cwd: path.dirname(this.workerEntry),
      env: workerEnvironment("service"),
      execArgv: [],
      execPath: this.workerExecPath,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => { this.resolveExit = resolve; });
    child.on("message", (message: unknown) => this.receive(message));
    child.once("error", (error) => this.killService(machineError(
      child.pid === undefined ? "worker_start_failed" : "worker_service_failed",
      error.message || "Worker service failed",
      true,
    )));
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exitSeen) return;
      this.exitSeen = true;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      if (this.killTimer) clearTimeout(this.killTimer);
      this.terminalError ??= machineError("worker_service_exited", `Worker service exited (code ${String(code)}, signal ${String(signal)})`, true);
      for (const record of [...this.records.values()]) this.finishJob(record, record.stopError ?? this.terminalError);
      this.resolveExit?.();
      this.finishDispose();
    };
    child.once("exit", finish);
    child.once("close", finish);
    this.readyTimer = setTimeout(() => this.killService(machineError("worker_service_start_timeout", "Worker service did not become ready", true)), Math.min(this.maxJobDurationMs, 30_000));
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.ready) resolve();
        else if (this.terminalError || this.exited) reject(new ModuleRuntimeError(this.terminalError?.code ?? "worker_service_start_failed", this.terminalError?.message ?? "Worker service exited before becoming ready", true));
        else setTimeout(check, 5);
      };
      check();
    });
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private async dispatch(record: ServiceJobRecord): Promise<void> {
    if (this.records.get(record.request.id) !== record || record.state !== "active" || record.dispatched) return;
    try {
      await this.start();
    } catch (error) {
      this.finishJob(record, this.terminalError ?? machineError("worker_start_failed", error instanceof Error ? error.message : "Worker service could not start", true));
      return;
    }
    if (this.records.get(record.request.id) !== record || record.stopError) return;
    if (this.disposed || !this.child?.connected) {
      this.finishJob(record, this.terminalError ?? machineError("worker_service_disposed", "Worker service is unavailable", true));
      return;
    }
    if (record.request.deadline <= Date.now()) {
      this.stopJob(record, machineError("job_deadline_exceeded", "Job deadline expired before the worker started", true));
      return;
    }
    record.dispatched = true;
    try {
      this.child.send({ type: "job", request: record.request }, (error) => {
        if (error && this.records.get(record.request.id) === record) this.killService(machineError("worker_ipc_failed", error.message, true));
      });
    } catch (error) {
      this.killService(machineError("worker_ipc_failed", error instanceof Error ? error.message : "Worker service IPC failed", true));
    }
  }

  private pumpJobs(): void {
    if (this.disposed || this.terminalError || this.exited) return;
    while (this.jobs.size < this.maxConcurrentServiceJobs && this.jobQueue.length > 0) {
      const record = this.jobQueue.shift()!;
      if (this.records.get(record.request.id) !== record || record.state !== "queued") continue;
      record.state = "active";
      this.jobs.set(record.request.id, record);
      void this.dispatch(record);
    }
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object") {
      this.killService(machineError("worker_protocol_error", "Worker service returned an invalid message"));
      return;
    }
    const envelope = message as { type?: unknown; result?: unknown; id?: unknown; snapshot?: unknown; error?: unknown };
    if (envelope.type === "ready") {
      this.ready = true;
      return;
    }
    if (envelope.type === "shutdown_ack") return;
    const responseId = envelope.type === "result" && envelope.result && typeof envelope.result === "object"
      ? (envelope.result as { id?: unknown }).id
      : envelope.id;
    if (typeof responseId !== "string") {
      this.killService(machineError("worker_protocol_error", "Worker service response has no job ID"));
      return;
    }
    const record = this.jobs.get(responseId);
    if (!record) {
      this.killService(machineError("worker_protocol_error", "Worker service returned an unknown job ID"));
      return;
    }
    if (envelope.type === "error") {
      const error = workerError(envelope.error);
      if (!error || !sameSnapshot(envelope.snapshot, record.request.snapshot)) {
        this.killService(machineError("worker_protocol_error", "Worker service returned a mismatched error response"));
        return;
      }
      this.finishJob(record, error);
      return;
    }
    if (envelope.type !== "result" || !envelope.result || typeof envelope.result !== "object") {
      this.killService(machineError("worker_protocol_error", "Worker service returned an invalid result envelope"));
      return;
    }
    const result = envelope.result as JobResult;
    if (result.id !== record.request.id || !sameSnapshot(result.snapshot, record.request.snapshot) ||
        result.model !== record.request.model || result.modelVersion !== record.request.modelVersion ||
        result.moduleVersion !== record.request.moduleVersion) {
      this.killService(machineError("worker_identity_mismatch", "Worker service result does not match the requested snapshot or model version"));
      return;
    }
    try {
      const encoded = encodeJson(result);
      if (encoded.bytes > MAX_JOB_OUTPUT_BYTES) {
        this.finishJob(record, machineError("job_output_too_large", `Job result exceeds ${MAX_JOB_OUTPUT_BYTES} UTF-8 bytes`));
        return;
      }
      this.finishJob(record, undefined, JSON.parse(encoded.text) as JobResult);
    } catch (error) {
      this.finishJob(record, machineError("invalid_job_output", error instanceof Error ? error.message : "Job result is not JSON serializable"));
    }
  }

  private stopJob(record: ServiceJobRecord, error: MachineError): void {
    if (this.records.get(record.request.id) !== record || record.stopError) return;
    record.stopError = error;
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
    record.deadlineTimer = undefined;
    if (record.abortSignal && record.abortListener) record.abortSignal.removeEventListener("abort", record.abortListener);
    if (record.state === "queued" || !record.dispatched) {
      this.finishJob(record, error);
      return;
    }
    if (this.child?.connected) {
      try { this.child.send({ type: "cancel", id: record.request.id }, () => {}); } catch { /* Grace timeout kills a broken service. */ }
      record.graceTimer = setTimeout(() => {
        if (this.jobs.get(record.request.id) === record) this.killService(machineError("worker_cancel_unresponsive", "Worker service did not stop a cancelled job", true));
      }, this.cancellationGraceMs);
    } else {
      this.killService(error);
    }
  }

  private finishJob(record: ServiceJobRecord, error?: MachineError, result?: JobResult): void {
    if (this.records.get(record.request.id) !== record) return;
    this.jobs.delete(record.request.id);
    this.records.delete(record.request.id);
    const queuedIndex = this.jobQueue.indexOf(record);
    if (queuedIndex >= 0) this.jobQueue.splice(queuedIndex, 1);
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
    if (record.graceTimer) clearTimeout(record.graceTimer);
    if (record.abortSignal && record.abortListener) record.abortSignal.removeEventListener("abort", record.abortListener);
    if (record.stopError) record.resolve(failure(record.request, record.stopError));
    else if (error) record.resolve(failure(record.request, error));
    else if (result) record.resolve({ ok: true, result });
    else record.resolve(failure(record.request, machineError("worker_protocol_error", "Worker service returned no result")));
    this.pumpJobs();
  }

  private killService(error: MachineError): void {
    this.terminalError ??= error;
    const child = this.child;
    if (!child || this.exited) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    child.kill("SIGTERM");
    this.killTimer ??= setTimeout(() => { if (!this.exited) child.kill("SIGKILL"); }, this.cancellationGraceMs);
  }

  private finishDispose(): void {
    if (!this.disposed || !this.exited && this.child) return;
    this.onRemoved();
    for (const callback of this.disposeCallbacks.splice(0)) callback();
  }
}

function sameSnapshot(value: unknown, expected: JobRequest["snapshot"]): boolean {
  if (!value || typeof value !== "object") return false;
  try { return snapshotKey(value as JobRequest["snapshot"]) === snapshotKey(expected); }
  catch { return false; }
}

/** Worker-side adapter for the dedicated Node child-process IPC channel. */
export function installWorkerHandler<TInput = unknown, TOutput = unknown>(
  handler: (request: JobRequest<TInput>, signal: AbortSignal) => TOutput | Promise<TOutput>,
): void {
  const active = new Map<string, AbortController>();
  const persistent = process.env.SCRIPTORIUM_WORKER_MODE === "service";
  let shuttingDown = false;
  const finishIfIdle = () => {
    if (shuttingDown && active.size === 0 && process.connected) process.disconnect();
  };
  if (persistent) process.send?.({ type: "ready" });
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const envelope = message as { type?: unknown; request?: unknown; id?: unknown };
    if (envelope.type === "shutdown") {
      shuttingDown = true;
      finishIfIdle();
      return;
    }
    if (envelope.type === "cancel" && typeof envelope.id === "string") {
      active.get(envelope.id)?.abort();
      return;
    }
    if (envelope.type !== "job" || shuttingDown || (!persistent && active.size > 0) || !validRequest(envelope.request)) return;
    const request = envelope.request as JobRequest<TInput>;
    if (active.has(request.id)) return;
    const controller = new AbortController();
    active.set(request.id, controller);
    void Promise.resolve().then(() => handler(request, controller.signal)).then((output) => {
      const result: JobResult = {
        id: request.id,
        snapshot: request.snapshot,
        model: request.model,
        modelVersion: request.modelVersion,
        moduleVersion: request.moduleVersion,
        output,
      };
      const encoded = encodeJson(result);
      if (encoded.bytes > MAX_JOB_OUTPUT_BYTES) throw new ModuleRuntimeError("job_output_too_large", `Job result exceeds ${MAX_JOB_OUTPUT_BYTES} UTF-8 bytes`);
      process.send?.({ type: "result", result: JSON.parse(encoded.text) }, () => {
        active.delete(request.id);
        if (!persistent) process.disconnect();
        else finishIfIdle();
      });
    }).catch((error: unknown) => {
      const err = error as { code?: unknown; message?: unknown; retryable?: unknown };
      const machine = machineError(
        typeof err?.code === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(err.code) ? err.code : "worker_failed",
        typeof err?.message === "string" ? err.message : "Worker job failed",
        typeof err?.retryable === "boolean" ? err.retryable : false,
      );
      process.send?.({ type: "error", id: request.id, snapshot: request.snapshot, error: machine }, () => {
        active.delete(request.id);
        if (!persistent) process.disconnect();
        else finishIfIdle();
      });
    });
  });
}
