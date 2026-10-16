import path from "node:path";
import { snapshotKey, type ActionResult, type CapabilityDefinition, type ChangeOperation, type ChangeProposal, type JobOutcome, type JobRequest, type MachineError, type ModuleAction, type ModuleActionContext, type ModuleAvailability, type ModuleContext, type ModuleDefinition, type ModuleId, type ModuleManifest, type ModuleStatus, type SnapshotId, type WorkerService } from "@scriptorium/contracts";
import { CapabilityProvider, SharedCapabilityPool } from "./capability-pool.js";
import { resolveModulePlan, type ResolvedModulePlan } from "./module-plan.js";
import { isModuleId, MODULE_IDS, ModuleRuntimeError } from "./runtime-error.js";
import { WorkerSupervisor, type WorkerSupervisorOptions } from "./worker-supervisor.js";

export type ModuleLoader = (context: ModuleContext) => Promise<ModuleDefinition>;

export interface ModuleRuntimeOptions {
  manifests: readonly ModuleManifest[];
  enabled: readonly string[];
  /** Imported only after an included module is enabled and explicitly activated. */
  loaders?: Readonly<Partial<Record<ModuleId, ModuleLoader>>>;
  hostCapabilities?: readonly string[];
  capabilityProviders?: Readonly<Record<string, CapabilityProvider>>;
  cacheDirectory: string;
  /** Absolute installed worker paths generated from the trusted profile package. */
  workerEntries?: Readonly<Partial<Record<ModuleId, string>>>;
  /** Base directory for manifest-relative worker entry paths. */
  moduleDirectories?: Readonly<Partial<Record<ModuleId, string>>>;
  workerOptions?: WorkerSupervisorOptions;
}

export interface ActionHostContext {
  projectId: string;
  reader: ModuleActionContext["reader"];
  signal: AbortSignal;
  propose(operations: ChangeOperation[], evidence?: Parameters<ModuleActionContext["propose"]>[1]): Promise<ChangeProposal>;
}

export interface ModuleActionRegistration {
  id: string;
  effect: ModuleAction["effect"];
}

interface ModuleSession {
  id: ModuleId;
  controller: AbortController;
  loaderPromise?: Promise<ModuleDefinition>;
  definition?: ModuleDefinition;
  context?: ModuleContext;
  leases: Set<() => Promise<void>>;
  workerServices: Set<WorkerService>;
  calls: number;
  pendingCapabilities: number;
  capabilityDrain?: Promise<void>;
  finishCapabilityDrain?: () => void;
  drain?: Promise<void>;
  finishDrain?: () => void;
  deactivating?: Promise<void>;
}

function machineError(code: string, message: string, retryable = false): MachineError {
  return { code, message: message.slice(0, 512), retryable };
}

function toMachineError(error: unknown): MachineError {
  if (error instanceof ModuleRuntimeError) return machineError(error.code, error.message, error.retryable);
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return machineError(candidate.code, candidate.message, candidate.retryable === true);
    }
  }
  return machineError("module_action_failed", error instanceof Error ? error.message : "Module action failed");
}

function sameManifest(left: ModuleManifest, right: ModuleManifest): boolean {
  const key = (manifest: ModuleManifest) => JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    dependencies: [...manifest.dependencies].sort(),
    provides: [...manifest.provides].sort(),
    requires: [...manifest.requires].sort(),
    serverEntry: manifest.serverEntry ?? null,
    browserEntry: manifest.browserEntry ?? null,
    workerEntry: manifest.workerEntry ?? null,
    statePaths: [...manifest.statePaths].sort(),
    locality: manifest.locality,
  });
  return key(left) === key(right);
}

function sameSnapshot(left: SnapshotId, right: SnapshotId): boolean {
  try { return snapshotKey(left) === snapshotKey(right); }
  catch { return false; }
}

function actionFailure(snapshot: SnapshotId, error: MachineError): ActionResult {
  return { ok: false, snapshot, error };
}

function invalidAction(action: ModuleAction): void {
  if (!action || typeof action !== "object" || typeof action.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(action.id) ||
      !["read", "propose", "compute"].includes(action.effect) || typeof action.inputSchema?.parse !== "function" ||
      typeof action.outputSchema?.parse !== "function" || typeof action.invoke !== "function") {
    throw new ModuleRuntimeError("invalid_module_definition", "Module declares an invalid action");
  }
}

function validateDefinition(expected: ModuleManifest, definition: ModuleDefinition): void {
  if (!definition || typeof definition !== "object" || !definition.manifest || !sameManifest(expected, definition.manifest) ||
      !Array.isArray(definition.actions) || !Array.isArray(definition.ui) ||
      (definition.capabilities !== undefined && !Array.isArray(definition.capabilities)) || typeof definition.dispose !== "function") {
    throw new ModuleRuntimeError("module_version_mismatch", `Loaded module ${expected.id} does not match installed manifest version ${expected.version}`);
  }
  const declaredCapabilities = new Set(expected.provides);
  const providedCapabilities = new Set<string>();
  for (const capability of definition.capabilities ?? []) {
    if (!capability || typeof capability.id !== "string" || !declaredCapabilities.has(capability.id) ||
        typeof capability.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(capability.version) ||
        typeof capability.create !== "function" || (capability.dispose !== undefined && typeof capability.dispose !== "function") ||
        providedCapabilities.has(capability.id)) {
      throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares an invalid capability provider`);
    }
    providedCapabilities.add(capability.id);
  }
  if (providedCapabilities.size !== declaredCapabilities.size) {
    throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} did not register every capability in its manifest`);
  }
  const actionIds = new Set<string>();
  for (const action of definition.actions) {
    invalidAction(action);
    if (actionIds.has(action.id)) throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares duplicate action ${action.id}`);
    actionIds.add(action.id);
  }
  const contributionIds = new Set<string>();
  for (const contribution of definition.ui) {
    if (!contribution || contribution.module !== expected.id || !/^[A-Za-z0-9._:-]{1,128}$/.test(contribution.id) ||
        !["editor", "dock", "inspection", "review", "settings"].includes(contribution.slot) ||
        typeof contribution.title !== "string" || contribution.title.length > 256 || !actionIds.has(contribution.action) ||
        contributionIds.has(contribution.id)) {
      throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares an invalid UI contribution`);
    }
    contributionIds.add(contribution.id);
  }
}

/** Metadata-first lifecycle host for trusted installed modules. */
export class ModuleRuntime {
  private readonly manifests: ReadonlyMap<ModuleId, Readonly<ModuleManifest>>;
  private readonly loaders: Readonly<Partial<Record<ModuleId, ModuleLoader>>>;
  private readonly workerEntries: Readonly<Partial<Record<ModuleId, string>>>;
  private readonly moduleDirectories: Readonly<Partial<Record<ModuleId, string>>>;
  private readonly cacheDirectory: string;
  private readonly hostCapabilities: readonly string[];
  private readonly capabilityPool: SharedCapabilityPool;
  private readonly workers: WorkerSupervisor;
  private readonly sessions = new Map<ModuleId, ModuleSession>();
  private requested = new Set<ModuleId>();
  private plan: ResolvedModulePlan;
  private shuttingDown = false;

  constructor(options: ModuleRuntimeOptions) {
    this.loaders = options.loaders ?? {};
    this.workerEntries = options.workerEntries ?? {};
    this.moduleDirectories = options.moduleDirectories ?? {};
    this.cacheDirectory = path.resolve(options.cacheDirectory);
    this.hostCapabilities = options.hostCapabilities ?? Object.keys(options.capabilityProviders ?? {});
    this.capabilityPool = new SharedCapabilityPool(options.capabilityProviders ?? {});
    this.workers = new WorkerSupervisor(options.workerOptions);
    this.plan = resolveModulePlan(options.manifests, options.enabled, this.hostCapabilities);
    this.manifests = this.plan.manifests;
    this.requested = new Set(options.enabled as ModuleId[]);
  }

  get workerSupervisor(): WorkerSupervisor { return this.workers; }

  status(id: string): ModuleStatus {
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${id}`);
    const manifest = this.manifests.get(id);
    if (!manifest) return { id, availability: "not-included", activeJobs: 0 };
    if (!this.plan.enabled.has(id)) return { id, availability: "disabled", version: manifest.version, activeJobs: 0 };
    const activeJobs = this.workers.activeJobCountFor(id);
    const session = this.sessions.get(id);
    const activeResources = session ? session.leases.size + session.pendingCapabilities + session.workerServices.size : 0;
    const activeCalls = session?.calls ?? 0;
    const availability: ModuleAvailability = activeJobs > 0 || activeResources > 0 || activeCalls > 0 ? "active" : "enabled-idle";
    return { id, availability, version: manifest.version, activeJobs };
  }

  statuses(): ModuleStatus[] { return MODULE_IDS.map((id) => this.status(id)); }

  /** Enables an included module and its declared dependency closure without importing code. */
  enable(id: string): void {
    this.assertOpen();
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${id}`);
    if (!this.manifests.has(id)) throw new ModuleRuntimeError("redeployment_required", `Module ${id} is not included in this profile; redeployment is required`);
    const requested = new Set(this.requested);
    requested.add(id);
    const next = resolveModulePlan([...this.manifests.values()], [...requested], this.hostCapabilityIds());
    this.requested = requested;
    this.plan = next;
  }

  /** Cancels and drains a module before removing its actions, hooks, and capability leases. */
  async disable(id: string): Promise<void> {
    this.assertOpen();
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${id}`);
    if (!this.manifests.has(id)) return;
    if (!this.plan.enabled.has(id)) return;
    const requested = new Set(this.requested);
    requested.delete(id);
    const providerCapabilities = new Set(this.manifests.get(id)!.provides);
    const capabilityConsumers = [...this.plan.enabled].filter((consumerId) => consumerId !== id &&
      this.manifests.get(consumerId)!.requires.some((capability) => providerCapabilities.has(capability)));
    if (capabilityConsumers.length) {
      throw new ModuleRuntimeError("module_dependency_in_use", `Cannot disable ${id} while enabled modules require its capabilities: ${capabilityConsumers.join(", ")}`);
    }
    const next = resolveModulePlan([...this.manifests.values()], [...requested], this.hostCapabilityIds());
    if (next.enabled.has(id)) throw new ModuleRuntimeError("module_dependency_in_use", `Cannot disable ${id} while an enabled module depends on it`);
    const disabled = [...this.plan.enabled].filter((moduleId) => !next.enabled.has(moduleId));
    const previousOrder = [...this.plan.order];
    this.requested = requested;
    this.plan = next;
    const errors: unknown[] = [];
    for (const moduleId of previousOrder.reverse().filter((moduleId) => disabled.includes(moduleId))) {
      try { await this.deactivate(moduleId); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }

  /** Imports enabled module code on demand and validates it against metadata. */
  async activate(id: string): Promise<void> {
    this.assertOpen();
    const manifest = this.requireEnabled(id);
    let session = this.sessions.get(manifest.id);
    if (!session) {
      session = { id: manifest.id, controller: new AbortController(), leases: new Set(), workerServices: new Set(), calls: 0, pendingCapabilities: 0 };
      this.sessions.set(manifest.id, session);
    }
    if (!session.loaderPromise) {
      const loader = this.loaders[manifest.id];
      if (!loader) {
        if (!session.definition) this.sessions.delete(manifest.id);
        throw new ModuleRuntimeError("module_loader_missing", `No server loader is available for installed module ${manifest.id}`);
      }
      const target = session;
      session.loaderPromise = Promise.resolve().then(async () => {
        const context: ModuleContext = {
          cacheDirectory: path.join(this.cacheDirectory, manifest.id),
          signal: target.controller.signal,
          acquireCapability: <T>(capabilityId: string) => this.acquireForModule<T>(target, capabilityId),
          createWorkerService: () => this.createWorkerService(target),
        };
        target.context = context;
        const definition = await loader(context);
        if (target.controller.signal.aborted || !this.plan.enabled.has(manifest.id)) {
          await definition?.dispose?.();
          throw new ModuleRuntimeError("module_disabled", `Module ${manifest.id} was disabled during activation`);
        }
        try {
          validateDefinition(manifest, definition);
          this.registerCapabilities(target, definition.capabilities ?? []);
        } catch (error) {
          await this.capabilityPool.unregisterOwner(manifest.id).catch(() => {});
          await definition?.dispose?.();
          throw error;
        }
        target.definition = definition;
        return definition;
      });
    }
    try {
      await session.loaderPromise;
    } catch (error) {
      if (this.sessions.get(manifest.id) === session) {
        await this.releaseCapabilities(session);
        this.sessions.delete(manifest.id);
      }
      throw error;
    }
  }

  actions(id: string): readonly ModuleActionRegistration[] {
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${id}`);
    const manifest = this.manifests.get(id);
    if (!manifest || !this.plan.enabled.has(id)) return [];
    const definition = this.sessions.get(manifest.id)?.definition;
    return definition?.actions.map(({ id: actionId, effect }) => ({ id: actionId, effect })) ?? [];
  }

  contributions(id: string): ModuleDefinition["ui"] {
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${id}`);
    const manifest = this.manifests.get(id);
    if (!manifest || !this.plan.enabled.has(id)) return [];
    return this.sessions.get(manifest.id)?.definition?.ui ?? [];
  }

  async invokeAction(id: string, actionId: string, input: unknown, host: ActionHostContext): Promise<ActionResult> {
    let manifest: Readonly<ModuleManifest>;
    let session: ModuleSession | undefined;
    let callStarted = false;
    try {
      manifest = this.requireEnabled(id);
      await this.activate(manifest.id);
      session = this.sessions.get(manifest.id);
      if (!session || session.controller.signal.aborted) throw new ModuleRuntimeError("module_disabled", `Module ${manifest.id} is disabled`);
      const definition = session.definition;
      if (!definition) throw new ModuleRuntimeError("module_disabled", `Module ${manifest.id} is not active`);
      const action = definition.actions.find((candidate) => candidate.id === actionId);
      if (!action) throw new ModuleRuntimeError("action_not_found", `Action ${manifest.id}.${actionId} is unavailable`);
      const parsed = action.inputSchema.parse(input);
      if (session.calls === 0) session.drain = new Promise<void>((resolve) => { session!.finishDrain = resolve; });
      session.calls += 1;
      callStarted = true;
      const actionSignal = AbortSignal.any([session.controller.signal, host.signal]);
      const proposals: ChangeProposal[] = [];
      const actionContext: ModuleActionContext = {
        projectId: host.projectId,
        reader: host.reader,
        signal: actionSignal,
        propose: async (operations, evidence) => {
          if (action.effect !== "propose") throw new ModuleRuntimeError("action_effect_denied", `Action ${action.id} is not allowed to propose changes`);
          for (const operation of operations) this.assertOperationSnapshot(operation, host.reader.snapshot);
          const proposal = await host.propose(operations, evidence);
          if (!sameSnapshot(proposal.snapshot, host.reader.snapshot)) throw new ModuleRuntimeError("action_snapshot_mismatch", "Proposal coordinator returned a different snapshot");
          proposals.push(proposal);
          return proposal;
        },
        runJob: async <T>(request: JobRequest, signal?: AbortSignal): Promise<JobOutcome<T>> => {
          if (action.effect === "read") return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("action_effect_denied", `Action ${action.id} is not allowed to run jobs`) };
          if (request.module !== manifest.id || !sameSnapshot(request.snapshot, host.reader.snapshot)) {
            return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("job_identity_mismatch", "Job module or snapshot does not match the active action") };
          }
          return this.runJob<T>(request, signal ?? actionSignal);
        },
      };
      const result = await action.invoke(parsed, actionContext);
      const validated = this.validateActionResult(action, result, host.reader.snapshot);
      if (validated.ok && proposals.length > 0) return { ...validated, proposals };
      return validated;
    } catch (error) {
      const snapshot = host?.reader?.snapshot;
      if (!snapshot) throw error;
      return actionFailure(snapshot, toMachineError(error));
    } finally {
      if (callStarted && session) {
        session.calls -= 1;
        if (session.calls === 0) {
          session.finishDrain?.();
          session.finishDrain = undefined;
          session.drain = undefined;
        }
      }
    }
  }

  async runJob<T = unknown>(request: JobRequest, signal?: AbortSignal): Promise<JobOutcome<T>> {
    let manifest: Readonly<ModuleManifest>;
    try {
      manifest = this.requireEnabled(request.module);
    } catch (error) {
      return { ok: false, id: request.id, snapshot: request.snapshot,
        error: toMachineError(error) };
    }
    if (request.moduleVersion !== manifest.version) {
      return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("module_version_mismatch", `Job requests module ${request.moduleVersion}; installed version is ${manifest.version}`) };
    }
    const workerEntry = this.workerEntries[manifest.id] ?? this.resolveWorkerEntry(manifest);
    if (!workerEntry) return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("worker_unavailable", `Module ${manifest.id} has no installed worker entry`) };
    try {
      await this.activate(manifest.id);
    } catch (error) {
      return { ok: false, id: request.id, snapshot: request.snapshot, error: toMachineError(error) };
    }
    const session = this.sessions.get(manifest.id);
    if (!session || session.controller.signal.aborted || !this.plan.enabled.has(manifest.id)) {
      return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("module_disabled", `Module ${manifest.id} was disabled before the job started`) };
    }
    const jobSignal = signal ? AbortSignal.any([session.controller.signal, signal]) : session.controller.signal;
    return this.workers.run<T>(request, workerEntry, jobSignal);
  }

  async cancel(id: string): Promise<boolean> { return this.workers.cancel(id); }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.requested.clear();
    const previousOrder = [...this.plan.order].reverse();
    this.plan = resolveModulePlan([...this.manifests.values()], [], this.hostCapabilities);
    const errors: unknown[] = [];
    for (const id of previousOrder) {
      try { await this.deactivate(id); } catch (error) { errors.push(error); }
    }
    for (const id of this.sessions.keys()) {
      try { await this.deactivate(id); } catch (error) { errors.push(error); }
    }
    try { await this.workers.shutdown(); } catch (error) { errors.push(error); }
    try { await this.capabilityPool.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw errors[0];
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new ModuleRuntimeError("runtime_shutdown", "Module runtime is shut down", true);
  }

  private requireEnabled(value: string): Readonly<ModuleManifest> {
    if (!isModuleId(value)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${value}`);
    const manifest = this.manifests.get(value);
    if (!manifest) throw new ModuleRuntimeError("redeployment_required", `Module ${value} is not included in this profile; redeployment is required`);
    if (!this.plan.enabled.has(value)) throw new ModuleRuntimeError("module_disabled", `Module ${value} is disabled`);
    return manifest;
  }

  private hostCapabilityIds(): readonly string[] { return this.hostCapabilities; }

  private async acquireForModule<T>(session: ModuleSession, id: string): Promise<{ value: T; release(): Promise<void> }> {
    if (session.controller.signal.aborted || !this.plan.enabled.has(session.id)) {
      throw new ModuleRuntimeError("module_disabled", `Module ${session.id} is disabled`);
    }
    const manifest = this.manifests.get(session.id)!;
    if (!manifest.requires.includes(id) && !manifest.provides.includes(id)) {
      throw new ModuleRuntimeError("undeclared_capability", `Module ${session.id} did not declare required capability ${id}`);
    }
    if (session.loaderPromise && !session.definition) {
      throw new ModuleRuntimeError("module_initialization_capability_acquire", `Module ${session.id} cannot acquire capabilities while its definition is loading`);
    }
    session.pendingCapabilities += 1;
    if (session.pendingCapabilities === 1) {
      session.capabilityDrain = new Promise<void>((resolve) => { session.finishCapabilityDrain = resolve; });
    }
    let lease;
    try {
      const owner = this.providerFor(id);
      if (owner && owner !== session.id) await this.activate(owner);
      lease = await this.capabilityPool.acquire<T>(id, session.controller.signal);
    } finally {
      session.pendingCapabilities -= 1;
      if (session.pendingCapabilities === 0) {
        session.finishCapabilityDrain?.();
        session.finishCapabilityDrain = undefined;
        session.capabilityDrain = undefined;
      }
    }
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      session.leases.delete(release);
      await lease.release();
    };
    if (session.controller.signal.aborted || !this.plan.enabled.has(session.id)) {
      await release();
      throw new ModuleRuntimeError("module_disabled", `Module ${session.id} was disabled while acquiring ${id}`);
    }
    session.leases.add(release);
    return { value: lease.value, release };
  }

  private async releaseCapabilities(session: ModuleSession): Promise<void> {
    await Promise.all([...session.leases].map((release) => release()));
  }

  private providerFor(id: string): ModuleId | undefined {
    for (const manifest of this.manifests.values()) if (manifest.provides.includes(id)) return manifest.id;
    return undefined;
  }

  private registerCapabilities(session: ModuleSession, definitions: readonly CapabilityDefinition[]): void {
    const context = session.context;
    if (!context) throw new ModuleRuntimeError("invalid_module_definition", `Module ${session.id} has no activation context`);
    for (const capability of definitions) {
      this.capabilityPool.register(capability.id, capability.version, {
        create: () => capability.create(context),
        dispose: (value) => capability.dispose?.(value),
      }, session.id);
    }
  }

  private async createWorkerService(session: ModuleSession): Promise<WorkerService> {
    if (session.controller.signal.aborted || !this.plan.enabled.has(session.id)) {
      throw new ModuleRuntimeError("module_disabled", `Module ${session.id} is disabled`);
    }
    const manifest = this.manifests.get(session.id)!;
    const workerEntry = this.workerEntries[session.id] ?? this.resolveWorkerEntry(manifest);
    if (!workerEntry) throw new ModuleRuntimeError("worker_unavailable", `Module ${session.id} has no installed worker entry`);
    const service = await this.workers.createService(session.id, manifest.version, workerEntry, session.controller.signal);
    if (session.controller.signal.aborted || !this.plan.enabled.has(session.id)) {
      await service.dispose();
      throw new ModuleRuntimeError("module_disabled", `Module ${session.id} was disabled while starting its worker service`);
    }
    let released = false;
    const tracked: WorkerService = {
      request: (request, signal) => service.request(request, signal),
      cancel: (jobId) => service.cancel(jobId),
      dispose: async () => {
        if (released) return;
        released = true;
        session.workerServices.delete(tracked);
        await service.dispose();
      },
    };
    session.workerServices.add(tracked);
    return tracked;
  }

  private async deactivate(id: ModuleId): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.deactivating) return session.deactivating;
    session.deactivating = (async () => {
      session.controller.abort();
      const errors: unknown[] = [];
      try { await this.workers.cancelModule(id); } catch (error) { errors.push(error); }
      if (session.loaderPromise) {
        try { await session.loaderPromise; } catch { /* Activation failure is already reported to its caller. */ }
      }
      if (session.calls > 0 && session.drain) await session.drain;
      if (session.pendingCapabilities > 0 && session.capabilityDrain) await session.capabilityDrain;
      try { await this.releaseCapabilities(session); } catch (error) { errors.push(error); }
      for (const service of [...session.workerServices]) {
        try { await service.dispose(); } catch (error) { errors.push(error); }
      }
      try { await this.capabilityPool.unregisterOwner(id); } catch (error) { errors.push(error); }
      try { await session.definition?.dispose(); } catch (error) { errors.push(error); }
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      if (errors.length) throw errors[0];
    })();
    return session.deactivating;
  }

  private resolveWorkerEntry(manifest: Readonly<ModuleManifest>): string | undefined {
    if (!manifest.workerEntry) return undefined;
    const root = this.moduleDirectories[manifest.id] ?? process.cwd();
    return path.resolve(root, manifest.workerEntry);
  }

  private assertOperationSnapshot(operation: ChangeOperation, snapshot: SnapshotId): void {
    if (!operation || operation.baseRemoteCommit !== snapshot.remoteCommit ||
        operation.repository.provider !== snapshot.repository.provider || operation.repository.repositoryId !== snapshot.repository.repositoryId ||
        operation.repository.ownerScope !== snapshot.repository.ownerScope || operation.repository.defaultBranch !== snapshot.repository.defaultBranch) {
      throw new ModuleRuntimeError("action_snapshot_mismatch", "Proposed operation does not belong to the action snapshot");
    }
  }

  private validateActionResult(action: ModuleAction, value: unknown, snapshot: SnapshotId): ActionResult {
    if (!value || typeof value !== "object" || typeof (value as ActionResult).ok !== "boolean" ||
        !sameSnapshot((value as ActionResult).snapshot, snapshot)) {
      return actionFailure(snapshot, machineError("action_snapshot_mismatch", `Action ${action.id} returned an invalid or different snapshot`));
    }
    const result = value as ActionResult;
    if (!result.ok) {
      const error = result.error;
      if (!error || typeof error.code !== "string" || typeof error.message !== "string" || typeof error.retryable !== "boolean") {
        return actionFailure(snapshot, machineError("invalid_action_result", `Action ${action.id} returned an invalid error`));
      }
      return { ok: false, snapshot, error: machineError(error.code, error.message, error.retryable) };
    }
    try {
      return { ok: true, snapshot, data: action.outputSchema.parse(result.data) };
    } catch (error) {
      return actionFailure(snapshot, machineError("invalid_action_output", error instanceof Error ? error.message : `Action ${action.id} returned invalid output`));
    }
  }
}
