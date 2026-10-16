import path from "node:path";
import { snapshotKey, type ActionDescriptor, type ActionResult, type CapabilityDefinition, type ChangeOperation, type ChangeProposal, type HttpContribution, type JobOutcome, type JobRequest, type MachineError, type ModuleAction, type ModuleActionContext, type ModuleAvailability, type ModuleContext, type ModuleDefinition, type ModuleId, type ModuleManifest, type ModuleStatus, type SnapshotId, type WorkerService } from "@scriptorium/contracts";
import { CapabilityProvider, SharedCapabilityPool } from "./capability-pool.js";
import { resolveModulePlan, type ResolvedModulePlan } from "./module-plan.js";
import { isModuleId, MODULE_IDS, ModuleRuntimeError } from "./runtime-error.js";
import { WorkerSupervisor, type WorkerJobLifecycleListener, type WorkerSupervisorOptions } from "./worker-supervisor.js";

export type ModuleLoader = (context: ModuleContext) => Promise<ModuleDefinition>;
export type DomainJobProgressSink = (progress: number) => Promise<void>;
export type DomainJobActionExecutor = (reportProgress?: DomainJobProgressSink) => Promise<ActionResult>;

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
  /** Maximum wait for aborted in-process module calls and activation to drain. */
  moduleDrainTimeoutMs?: number;
}

export interface ActionHostContext {
  projectId: string;
  reader: ModuleActionContext["reader"];
  signal: AbortSignal;
  /** Core actions are explicitly supplied by the host and run against this same project and reader. */
  actions?: readonly { module: ModuleId | "core"; action: ModuleAction }[];
  /** Resolves only repositories registered to the same owner; runtime verifies the returned identity. */
  linkedReader?(repositoryId: string): Promise<ModuleActionContext["reader"]>;
  /** Authentication level of the current HTTP caller. Omission grants no owner access. */
  access?: "owner" | "public";
  /** Host-owned durable tracking around a declared module action. `execute` is safe to call once. */
  trackDomainJob?(
    descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> },
    snapshot: SnapshotId,
    signal: AbortSignal,
    execute: DomainJobActionExecutor,
  ): Promise<ActionResult>;
  propose(
    operations: ChangeOperation[],
    evidence?: Parameters<ModuleActionContext["propose"]>[1],
    proposalId?: Parameters<ModuleActionContext["propose"]>[2],
    signal?: Parameters<ModuleActionContext["propose"]>[3],
  ): Promise<ChangeProposal>;
}

export type HttpContributionDescriptor = Omit<HttpContribution, "handle">;

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
  capabilityLeases: Map<string, number>;
  pendingCapabilityIds: Map<string, number>;
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
    optionalRequires: [...(manifest.optionalRequires ?? [])].sort(),
    serverEntry: manifest.serverEntry ?? null,
    browserEntry: manifest.browserEntry ?? null,
    workerEntry: manifest.workerEntry ?? null,
    statePaths: [...manifest.statePaths].sort(),
    locality: manifest.locality,
  });
  return key(left) === key(right);
}

function actionIdFor(module: ModuleId | "core", action: ModuleAction): string {
  return action.id.startsWith(`${module}.`) ? action.id : `${module}.${action.id}`;
}

function safeHttpPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("/") ||
      /[\\\x00-\x20?#%]/.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." &&
    /^[A-Za-z0-9._:-]+$/.test(segment));
}

function httpFailure(status: number, code: string, message: string): Response {
  return Response.json({ error: machineError(code, message) }, { status });
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
  copyActionJobDescriptor(action);
}

function copyActionJobDescriptor(action: ModuleAction): ModuleAction["job"] {
  if (action.job === undefined) return undefined;
  const job = action.job as unknown;
  const typeProperty = job && typeof job === "object" && !Array.isArray(job)
    ? Object.getOwnPropertyDescriptor(job, "type")
    : undefined;
  if (action.effect === "read" || !typeProperty || !("value" in typeProperty) ||
      typeof typeProperty.value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(typeProperty.value)) {
    throw new ModuleRuntimeError("invalid_module_definition", "Module declares an invalid domain job action");
  }
  // Treat ModuleAction as package-owned input: copy only the contract field and
  // never expose any undeclared properties attached by the module.
  return { type: typeProperty.value };
}

function validateDefinition(expected: ModuleManifest, definition: ModuleDefinition): void {
  if (!definition || typeof definition !== "object" || !definition.manifest || !sameManifest(expected, definition.manifest) ||
      !Array.isArray(definition.actions) || !Array.isArray(definition.ui) ||
      (definition.http !== undefined && !Array.isArray(definition.http)) ||
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
  const actionNames = new Set<string>();
  for (const action of definition.actions) {
    invalidAction(action);
    if (actionIds.has(action.id)) throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares duplicate action ${action.id}`);
    if (/^(?:core|story|diagnostics|nlp|semantic|speaker|assistant|publishing|mcp)\./.test(action.id) &&
        !action.id.startsWith(`${expected.id}.`)) {
      throw new ModuleRuntimeError("invalid_module_definition", `Action ${action.id} is not namespaced to ${expected.id}`);
    }
    actionIds.add(action.id);
    const canonical = actionIdFor(expected.id, action);
    if (actionNames.has(canonical)) throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares duplicate action ${canonical}`);
    actionNames.add(canonical);
  }
  const contributionIds = new Set<string>();
  for (const contribution of definition.ui) {
    if (!contribution || contribution.module !== expected.id || !/^[A-Za-z0-9._:-]{1,128}$/.test(contribution.id) ||
        !["editor", "dock", "inspection", "review", "settings"].includes(contribution.slot) ||
        typeof contribution.title !== "string" || contribution.title.length > 256 ||
        !actionIds.has(contribution.action) && !actionNames.has(actionIdFor(expected.id, { id: contribution.action } as ModuleAction)) ||
        contributionIds.has(contribution.id)) {
      throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares an invalid UI contribution`);
    }
    contributionIds.add(contribution.id);
  }
  const httpIds = new Set<string>();
  const httpPaths = new Map<string, Set<string>>();
  for (const contribution of definition.http ?? []) {
    const methods = contribution?.methods;
    if (!contribution || typeof contribution.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(contribution.id) ||
        !safeHttpPath(contribution.path) || !Array.isArray(methods) || methods.length === 0 || methods.length > 4 ||
        methods.some((method) => !["GET", "HEAD", "POST", "DELETE"].includes(method)) || new Set(methods).size !== methods.length ||
        !["owner", "public"].includes(contribution.access) || !["read", "propose"].includes(contribution.effect) ||
        (contribution.access === "public" && contribution.effect !== "read") || typeof contribution.handle !== "function" ||
        httpIds.has(contribution.id)) {
      throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares an invalid HTTP contribution`);
    }
    const routeMethods = httpPaths.get(contribution.path) ?? new Set<string>();
    if (methods.some((method) => routeMethods.has(method))) {
      throw new ModuleRuntimeError("invalid_module_definition", `Module ${expected.id} declares duplicate HTTP method/path pairs`);
    }
    for (const method of methods) routeMethods.add(method);
    httpPaths.set(contribution.path, routeMethods);
    httpIds.add(contribution.id);
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
  private readonly moduleDrainTimeoutMs: number;
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
    this.moduleDrainTimeoutMs = options.moduleDrainTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.moduleDrainTimeoutMs) || this.moduleDrainTimeoutMs < 1 || this.moduleDrainTimeoutMs > 120_000) {
      throw new RangeError("moduleDrainTimeoutMs must be between 1 and 120000 milliseconds");
    }
    this.plan = resolveModulePlan(options.manifests, options.enabled, this.hostCapabilities);
    this.manifests = this.plan.manifests;
    this.requested = new Set(options.enabled as ModuleId[]);
  }

  get workerSupervisor(): WorkerSupervisor { return this.workers; }

  /** Subscribe to host job metadata without activating any module or worker. */
  subscribeJobLifecycle(listener: WorkerJobLifecycleListener): () => void {
    return this.workers.subscribeJobLifecycle(listener);
  }

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
    const optionalCapabilityConsumers = [...this.plan.enabled].filter((consumerId) => consumerId !== id &&
      this.manifests.get(consumerId)!.optionalRequires?.some((capability) => providerCapabilities.has(capability)) &&
      [...providerCapabilities].some((capability) => {
        const consumer = this.sessions.get(consumerId);
        return (consumer?.capabilityLeases.get(capability) ?? 0) > 0 || (consumer?.pendingCapabilityIds.get(capability) ?? 0) > 0;
      }));
    if (optionalCapabilityConsumers.length) {
      throw new ModuleRuntimeError("module_dependency_in_use", `Cannot disable ${id} while enabled modules hold optional capabilities: ${optionalCapabilityConsumers.join(", ")}`);
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
      session = { id: manifest.id, controller: new AbortController(), leases: new Set(), capabilityLeases: new Map(), pendingCapabilityIds: new Map(), workerServices: new Set(), calls: 0, pendingCapabilities: 0 };
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
    return definition?.actions.map((action) => ({ id: actionIdFor(manifest.id, action), effect: action.effect })) ?? [];
  }

  contributions(id: string): ModuleDefinition["ui"] {
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${id}`);
    const manifest = this.manifests.get(id);
    if (!manifest || !this.plan.enabled.has(id)) return [];
    return this.sessions.get(manifest.id)?.definition?.ui ?? [];
  }

  /** HTTP descriptors are visible only after an included, enabled module has been activated and validated. */
  httpContributions(id: string): readonly HttpContributionDescriptor[] {
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${id}`);
    const manifest = this.manifests.get(id);
    if (!manifest || !this.plan.enabled.has(id)) return [];
    const definition = this.sessions.get(manifest.id)?.definition;
    return (definition?.http ?? []).map(({ handle: _handle, ...descriptor }) => ({ ...descriptor, methods: [...descriptor.methods] }));
  }

  /** Activates enabled modules on demand so action discovery never imports absent/disabled packages. */
  async listActions(host?: ActionHostContext): Promise<ActionDescriptor[]> {
    this.assertOpen();
    const actions: ActionDescriptor[] = [];
    for (const id of this.plan.order) {
      try { await this.activate(id); } catch { continue; }
      const definition = this.sessions.get(id)?.definition;
      for (const action of definition?.actions ?? []) {
        const job = copyActionJobDescriptor(action);
        actions.push({
          id: actionIdFor(id, action),
          module: id,
          effect: action.effect,
          ...(job ? { job } : {}),
        });
      }
    }
    for (const entry of host?.actions ?? []) {
      if (entry.module !== "core") throw new ModuleRuntimeError("invalid_host_action", "Host action registry may contain only core-owned actions");
      invalidAction(entry.action);
      actions.push({ id: actionIdFor("core", entry.action), module: "core", effect: entry.action.effect });
    }
    const ids = new Set<string>();
    for (const action of actions) {
      if (ids.has(action.id)) throw new ModuleRuntimeError("duplicate_action_id", `Action ${action.id} is registered more than once`);
      ids.add(action.id);
    }
    return actions;
  }

  async invokeAction(id: string, actionId: string, input: unknown, host: ActionHostContext): Promise<ActionResult> {
    return this.invokeModuleAction(id, actionId, input, host, host.signal, 0);
  }

  async invokeHttp(moduleId: string, contributionId: string, request: Request, host: ActionHostContext): Promise<Response> {
    let manifest: Readonly<ModuleManifest>;
    try {
      manifest = this.requireEnabled(moduleId);
      await this.activate(moduleId);
    } catch (error) {
      const failure = toMachineError(error);
      return httpFailure(failure.code === "module_disabled" || failure.code === "redeployment_required" ? 404 : 503,
        failure.code, failure.message);
    }
    const session = this.sessions.get(manifest.id);
    const contribution = session?.definition?.http?.find((candidate) => candidate.id === contributionId);
    if (!session || session.controller.signal.aborted || !contribution) return httpFailure(404, "http_contribution_not_found", "HTTP contribution is unavailable");
    if (contribution.access === "owner" && host.access !== "owner") return httpFailure(403, "owner_access_required", "This route requires owner access");
    if (!contribution.methods.includes(request.method as HttpContribution["methods"][number])) {
      return httpFailure(405, "http_method_not_allowed", "HTTP method is not allowed for this contribution");
    }
    if (session.calls === 0) session.drain = new Promise<void>((resolve) => { session.finishDrain = resolve; });
    session.calls += 1;
    let deferredDrain = false;
    let callFinished = false;
    const finishCall = () => {
      if (callFinished) return;
      callFinished = true;
      session!.calls -= 1;
      if (session!.calls === 0) {
        session!.finishDrain?.();
        session!.finishDrain = undefined;
        session!.drain = undefined;
      }
    };
    const requestController = new AbortController();
    const signal = AbortSignal.any([session.controller.signal, host.signal, request.signal, requestController.signal]);
    const proposals: ChangeProposal[] = [];
    try {
      const context = this.createActionContext(manifest.id, contribution.effect, contribution.effect, host, signal, proposals, 0, false);
      const response = await contribution.handle(request, context);
      if (signal.aborted) return httpFailure(499, "request_cancelled", "HTTP request was cancelled");
      if (!(response instanceof Response)) return httpFailure(502, "invalid_http_response", "HTTP contribution returned an invalid response");
      if (!response.body || [204, 205, 304].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      const reader = response.body.getReader();
      let abortListener: (() => void) | undefined;
      const finish = () => {
        if (abortListener) signal.removeEventListener("abort", abortListener);
        finishCall();
      };
      const trackedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          abortListener = () => {
            void reader.cancel(signal.reason).finally(() => {
              try { controller.close(); } catch { /* The consumer already closed the stream. */ }
              finish();
            });
          };
          signal.addEventListener("abort", abortListener, { once: true });
        },
        async pull(controller) {
          try {
            if (signal.aborted) {
              await reader.cancel(signal.reason).catch(() => {});
              controller.close();
              finish();
              return;
            }
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              finish();
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(error);
            finish();
          }
        },
        async cancel(reason) {
          requestController.abort(reason);
          await reader.cancel(reason).catch(() => {});
          finish();
        },
      });
      deferredDrain = true;
      return new Response(trackedBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      const failure = toMachineError(error);
      const status = failure.code === "action_effect_denied" ? 403 : failure.code === "module_disabled" ? 503 : 500;
      return httpFailure(status, failure.code, failure.message);
    } finally {
      if (!deferredDrain) finishCall();
    }
  }

  private async invokeModuleAction(
    id: string,
    requestedActionId: string,
    input: unknown,
    host: ActionHostContext,
    parentSignal: AbortSignal,
    depth: number,
    inheritedEffect?: ModuleAction["effect"],
    domainJobTracked = false,
    progressSink?: DomainJobProgressSink,
  ): Promise<ActionResult> {
    const snapshot = host?.reader?.snapshot;
    let session: ModuleSession | undefined;
    let callStarted = false;
    try {
      if (depth > 16) throw new ModuleRuntimeError("action_recursion_limit", "Nested action limit exceeded");
      const manifest = this.requireEnabled(id);
      await this.activate(manifest.id);
      session = this.sessions.get(manifest.id);
      if (!session || session.controller.signal.aborted) throw new ModuleRuntimeError("module_disabled", `Module ${manifest.id} is disabled`);
      const definition = session.definition;
      if (!definition) throw new ModuleRuntimeError("module_disabled", `Module ${manifest.id} is not active`);
      const action = definition.actions.find((candidate) => candidate.id === requestedActionId || actionIdFor(manifest.id, candidate) === requestedActionId);
      if (!action) throw new ModuleRuntimeError("action_not_found", `Action ${manifest.id}.${requestedActionId} is unavailable`);
      const policy = inheritedEffect ?? action.effect;
      if (!this.effectAllowed(policy, action.effect)) throw new ModuleRuntimeError("action_effect_denied", `Action ${actionIdFor(manifest.id, action)} exceeds its caller's effect`);
      const parsed = action.inputSchema.parse(input);
      if (session.calls === 0) session.drain = new Promise<void>((resolve) => { session!.finishDrain = resolve; });
      session.calls += 1;
      callStarted = true;
      const actionSignal = AbortSignal.any([session.controller.signal, host.signal, parentSignal]);
      if (actionSignal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
      const job = copyActionJobDescriptor(action);
      const track = job && !domainJobTracked ? host.trackDomainJob : undefined;
      const trackingActive = domainJobTracked || track !== undefined;
      const executeAction = async (actionProgressSink?: DomainJobProgressSink): Promise<ActionResult> => {
        try {
          if (actionSignal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
          const proposals: ChangeProposal[] = [];
          const context = this.createActionContext(manifest.id, action.effect, policy, host, actionSignal, proposals, depth, trackingActive, actionProgressSink);
          const result = await action.invoke(parsed, context);
          if (actionSignal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
          const validated = this.validateActionResult(action, result, host.reader.snapshot);
          if (validated.ok && proposals.length > 0) return { ...validated, proposals };
          return validated;
        } catch (error) {
          return actionFailure(host.reader.snapshot, toMachineError(error));
        }
      };
      if (track && job) {
        const descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> } = {
          id: actionIdFor(manifest.id, action), module: manifest.id, effect: action.effect, job,
        };
        let execution: Promise<ActionResult> | undefined;
        let trackerSettled = false;
        const execute: DomainJobActionExecutor = (reportProgress) => {
          if (trackerSettled && !execution) return Promise.reject(new ModuleRuntimeError("action_tracking_closed", "Domain job tracking ended before action execution started"));
          return execution ??= executeAction(reportProgress);
        };
        try {
          const trackedResult = await track(descriptor, host.reader.snapshot, actionSignal, execute);
          trackerSettled = true;
          // Keep the module call counted through an execution the host started in the background.
          if (execution) await execution;
          return trackedResult;
        } finally {
          trackerSettled = true;
          // Preserve module drain accounting if a tracking callback fails after starting the action.
          if (execution) await execution.catch(() => {});
        }
      }
      return await executeAction(progressSink);
    } catch (error) {
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

  private async invokeCoreAction(
    requestedActionId: string,
    input: unknown,
    host: ActionHostContext,
    parentSignal: AbortSignal,
    depth: number,
    inheritedEffect?: ModuleAction["effect"],
    domainJobTracked = false,
    progressSink?: DomainJobProgressSink,
  ): Promise<ActionResult> {
    const snapshot = host.reader.snapshot;
    try {
      if (depth > 16) throw new ModuleRuntimeError("action_recursion_limit", "Nested action limit exceeded");
      if (parentSignal.aborted || host.signal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
      const registrations = host.actions ?? [];
      if (registrations.some((entry) => entry.module !== "core")) throw new ModuleRuntimeError("invalid_host_action", "Host action registry may contain only core-owned actions");
      const registryIds = registrations.map((entry) => {
        invalidAction(entry.action);
        return actionIdFor("core", entry.action);
      });
      if (new Set(registryIds).size !== registryIds.length) throw new ModuleRuntimeError("duplicate_action_id", "Host action registry contains duplicate IDs");
      const action = registrations.find((entry) => actionIdFor("core", entry.action) === requestedActionId)?.action;
      if (!action) throw new ModuleRuntimeError("action_not_found", `Core action ${requestedActionId} is unavailable`);
      invalidAction(action);
      const policy = inheritedEffect ?? action.effect;
      if (!this.effectAllowed(policy, action.effect)) throw new ModuleRuntimeError("action_effect_denied", `Core action ${requestedActionId} exceeds its caller's effect`);
      const parsed = action.inputSchema.parse(input);
      const signal = AbortSignal.any([host.signal, parentSignal]);
      const proposals: ChangeProposal[] = [];
      const context = this.createActionContext("core", action.effect, policy, host, signal, proposals, depth, domainJobTracked, progressSink);
      const result = await action.invoke(parsed, context);
      if (signal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
      const validated = this.validateActionResult(action, result, snapshot);
      if (validated.ok && proposals.length > 0) return { ...validated, proposals };
      return validated;
    } catch (error) {
      return actionFailure(snapshot, toMachineError(error));
    }
  }

  private async invokeComposedAction(
    actionId: string,
    input: unknown,
    host: ActionHostContext,
    signal: AbortSignal,
    depth: number,
    inheritedEffect: ModuleAction["effect"],
    domainJobTracked: boolean,
    progressSink?: DomainJobProgressSink,
  ): Promise<ActionResult> {
    const separator = actionId.indexOf(".");
    if (separator < 1 || separator === actionId.length - 1) {
      return actionFailure(host.reader.snapshot, machineError("action_not_found", `Namespaced action ${actionId} is unavailable`));
    }
    const owner = actionId.slice(0, separator);
    if (owner === "core") return this.invokeCoreAction(actionId, input, host, signal, depth, inheritedEffect, domainJobTracked, progressSink);
    if (!isModuleId(owner)) return actionFailure(host.reader.snapshot, machineError("action_not_found", `Namespaced action ${actionId} is unavailable`));
    return this.invokeModuleAction(owner, actionId, input, host, signal, depth, inheritedEffect, domainJobTracked, progressSink);
  }

  private effectAllowed(parent: ModuleAction["effect"], child: ModuleAction["effect"]): boolean {
    if (parent === "read") return child === "read";
    if (parent === "compute") return child !== "propose";
    return true;
  }

  private createActionContext(
    moduleId: ModuleId | "core",
    effect: ModuleAction["effect"],
    inheritedEffect: ModuleAction["effect"],
    host: ActionHostContext,
    signal: AbortSignal,
    proposals: ChangeProposal[],
    depth: number,
    domainJobTracked: boolean,
    progressSink?: DomainJobProgressSink,
  ): ModuleActionContext {
    return {
      projectId: host.projectId,
      reader: host.reader,
      signal,
      ...(progressSink ? { reportProgress: async (progress: number) => {
        if (!Number.isFinite(progress)) throw new ModuleRuntimeError("invalid_job_progress", "Domain job progress must be finite");
        if (signal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
        await progressSink(Math.max(0, Math.min(1, progress)));
        if (signal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
      } } : {}),
      invoke: async (actionId, input, callSignal) => {
        const invocationSignal = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
        if (invocationSignal.aborted) return actionFailure(host.reader.snapshot, machineError("action_cancelled", "Action was cancelled"));
        if (host.access === "public") return actionFailure(host.reader.snapshot, machineError("public_action_unavailable", "Public routes cannot invoke composed actions"));
        const result = await this.invokeComposedAction(actionId, input, host, invocationSignal, depth + 1, inheritedEffect, domainJobTracked, progressSink);
        if (invocationSignal.aborted) return actionFailure(host.reader.snapshot, machineError("action_cancelled", "Action was cancelled"));
        if (result.ok && result.proposals?.length) proposals.push(...result.proposals);
        return result;
      },
      listActions: () => host.access === "public" ? Promise.resolve([]) : this.listActions(host),
      linkedReader: async (repositoryId) => {
        if (signal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
        if (host.access === "public") throw new ModuleRuntimeError("public_access_restricted", "Public routes cannot read linked repositories");
        if (!host.linkedReader) throw new ModuleRuntimeError("linked_repository_unavailable", "No linked repository reader is registered for this host");
        const reader = await host.linkedReader(repositoryId);
        const linked = reader?.snapshot?.repository;
        const current = host.reader.snapshot.repository;
        if (!reader || typeof reader.read !== "function" || typeof reader.list !== "function" ||
            !linked || linked.repositoryId !== repositoryId || linked.ownerScope !== current.ownerScope) {
          throw new ModuleRuntimeError("linked_repository_unavailable", "Linked repository is unavailable for this owner");
        }
        if (signal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
        return reader;
      },
      propose: async (operations, evidence, proposalId, callSignal) => {
        const proposalSignal = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
        if (proposalSignal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
        if (effect !== "propose" || inheritedEffect !== "propose") throw new ModuleRuntimeError("action_effect_denied", `Action ${moduleId} is not allowed to propose changes`);
        for (const operation of operations) this.assertOperationSnapshot(operation, host.reader.snapshot);
        const proposal = await host.propose(operations, evidence, proposalId, proposalSignal);
        if (proposalSignal.aborted) throw new ModuleRuntimeError("action_cancelled", "Action was cancelled");
        if (!sameSnapshot(proposal.snapshot, host.reader.snapshot)) throw new ModuleRuntimeError("action_snapshot_mismatch", "Proposal coordinator returned a different snapshot");
        proposals.push(proposal);
        return proposal;
      },
      runJob: async <T>(request: JobRequest, requestSignal?: AbortSignal): Promise<JobOutcome<T>> => {
        if (effect === "read" || inheritedEffect === "read") return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("action_effect_denied", `Action ${moduleId} is not allowed to run jobs`) };
        if (moduleId === "core" || request.module !== moduleId || !sameSnapshot(request.snapshot, host.reader.snapshot)) {
          return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("job_identity_mismatch", "Job module or snapshot does not match the active action") };
        }
        const jobSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
        if (jobSignal.aborted) return { ok: false, id: request.id, snapshot: request.snapshot, error: machineError("job_cancelled", "Job was cancelled") };
        return this.runJob<T>(request, jobSignal);
      },
    };
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
    const optional = manifest.optionalRequires?.includes(id) ?? false;
    if (!manifest.requires.includes(id) && !manifest.provides.includes(id) && !optional) {
      throw new ModuleRuntimeError("undeclared_capability", `Module ${session.id} did not declare required capability ${id}`);
    }
    const owner = this.providerFor(id);
    if (optional && (!owner && !this.hostCapabilities.includes(id) || owner && !this.plan.enabled.has(owner))) {
      throw new ModuleRuntimeError("optional_capability_unavailable", `Optional capability ${id} is not enabled in this profile`);
    }
    if (session.loaderPromise && !session.definition) {
      throw new ModuleRuntimeError("module_initialization_capability_acquire", `Module ${session.id} cannot acquire capabilities while its definition is loading`);
    }
    session.pendingCapabilities += 1;
    session.pendingCapabilityIds.set(id, (session.pendingCapabilityIds.get(id) ?? 0) + 1);
    if (session.pendingCapabilities === 1) {
      session.capabilityDrain = new Promise<void>((resolve) => { session.finishCapabilityDrain = resolve; });
    }
    let lease;
    try {
      if (owner && owner !== session.id) await this.activate(owner);
      lease = await this.capabilityPool.acquire<T>(id, session.controller.signal);
    } finally {
      session.pendingCapabilities -= 1;
      const pendingCount = (session.pendingCapabilityIds.get(id) ?? 1) - 1;
      if (pendingCount <= 0) session.pendingCapabilityIds.delete(id);
      else session.pendingCapabilityIds.set(id, pendingCount);
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
      const leaseCount = (session.capabilityLeases.get(id) ?? 1) - 1;
      if (leaseCount <= 0) session.capabilityLeases.delete(id);
      else session.capabilityLeases.set(id, leaseCount);
      await lease.release();
    };
    if (session.controller.signal.aborted || !this.plan.enabled.has(session.id)) {
      await release();
      throw new ModuleRuntimeError("module_disabled", `Module ${session.id} was disabled while acquiring ${id}`);
    }
    session.leases.add(release);
    session.capabilityLeases.set(id, (session.capabilityLeases.get(id) ?? 0) + 1);
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
      const drains: Promise<unknown>[] = [];
      if (session.loaderPromise) drains.push(session.loaderPromise.catch(() => undefined));
      if (session.calls > 0 && session.drain) drains.push(session.drain);
      if (session.pendingCapabilities > 0 && session.capabilityDrain) drains.push(session.capabilityDrain);
      if (drains.length) {
        let timer: NodeJS.Timeout | undefined;
        const drained = await Promise.race([
          Promise.all(drains).then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.moduleDrainTimeoutMs); }),
        ]);
        if (timer) clearTimeout(timer);
        if (!drained) errors.push(new ModuleRuntimeError("module_drain_timeout", `Module ${id} did not drain within ${this.moduleDrainTimeoutMs} ms`, true));
      }
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
