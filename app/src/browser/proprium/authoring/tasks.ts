import type { Scope, Snapshot } from "./types.js";

export const SEMANTIC_PROGRESS_KEY = "semantic-task-progress-v1";
const DB_NAME = "proprium-authoring-tasks-v1";
const STALE_OWNER_MS = 30_000;
const phases = new Set(["source_scan", "model_loading", "embedding", "cache_validation", "cache_publish", "query_embedding",
  "vector_scan", "reranking", "term_embedding", "mention_scan", "candidate_scoring", "complete"]);

export type AuthoringTaskState = "queued" | "running" | "paused" | "cancelled" | "failed" | "complete";
export interface HostTaskProgress {
  taskId: string;
  state: AuthoringTaskState;
  phase: string;
  completed: number;
  total: number;
  resumable: boolean;
}
export interface AuthoringTaskUpdate {
  readonly scope: Scope;
  readonly snapshot: Snapshot;
  readonly task: HostTaskProgress;
}
export interface AuthoringTaskIdentity {
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly manifest_digest: string;
  readonly config_digest: string;
  readonly idempotency_key: string;
}
export interface StoredAuthoringTask {
  readonly key: string;
  readonly identity: AuthoringTaskIdentity;
  readonly scope: Scope;
  readonly snapshot: Snapshot;
  readonly activation_epoch: number;
  readonly owner_id: string;
  readonly step_sequence: number;
  readonly progress: HostTaskProgress;
  readonly updated_at: number;
}
export interface AuthoringTaskStore {
  get(key: string): Promise<StoredAuthoringTask | undefined>;
  list(): Promise<StoredAuthoringTask[]>;
  transact<T>(key: string, update: (current?: StoredAuthoringTask) => { next?: StoredAuthoringTask; value: T }): Promise<T>;
}
export type TaskBeginResult =
  | { readonly disposition: "started" | "resumed" | "already_active" | "complete"; readonly task: StoredAuthoringTask };
export interface TaskStepPermit {
  readonly task_key: string;
  readonly task_id: string;
  readonly sequence: number;
  readonly request_id: string;
  readonly idempotency_key: string;
  readonly controller: AbortController;
}
interface ActiveTask {
  startRequestId?: string;
  startController?: AbortController;
  step?: TaskStepPermit & { consumed: boolean };
}
const sameStableScope = (left: Scope, right: Scope) => left.workspace_id === right.workspace_id &&
  left.repository_id === right.repository_id && left.branch === right.branch;
const sameScope = (left: Scope, right: Scope) => sameStableScope(left, right) && left.generation === right.generation;
/** Snapshot IDs are short-lived Host leases; the Git/worktree fields identify the source snapshot across reloads. */
const sameSnapshot = (left: Snapshot, right: Snapshot) => left.local_commit === right.local_commit &&
  left.worktree_generation === right.worktree_generation && left.draft_generation === right.draft_generation &&
  (left.remote_commit ?? null) === (right.remote_commit ?? null);
const keyFor = (pluginId: string, scope: Scope, taskId: string) => "task:" + encodeURIComponent(pluginId) + ":" +
  encodeURIComponent(canonicalJson({ workspace_id: scope.workspace_id, repository_id: scope.repository_id, branch: scope.branch })) + ":" +
  encodeURIComponent(taskId);
const invalid = () => Object.assign(new Error("Task progress does not belong to an authorized Host task invocation"), { code: "invalid_input" });
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

function randomId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
}

/** Test adapter; production service uses IndexedDbAuthoringTaskStore. */
export class MemoryAuthoringTaskStore implements AuthoringTaskStore {
  private readonly rows = new Map<string, StoredAuthoringTask>();
  private queue: Promise<unknown> = Promise.resolve();
  async get(key: string) { const value = this.rows.get(key); return value && structuredClone(value); }
  async list() { return [...this.rows.values()].map(value => structuredClone(value)); }
  transact<T>(key: string, update: (current?: StoredAuthoringTask) => { next?: StoredAuthoringTask; value: T }): Promise<T> {
    const work = async () => {
      const current = this.rows.get(key);
      const result = update(current && structuredClone(current));
      if (result.next) this.rows.set(key, structuredClone(result.next));
      else if (current) this.rows.delete(key);
      return result.value;
    };
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

/** Durable, metadata-only job journal. It never stores manuscript text or guest cursors. */
export class IndexedDbAuthoringTaskStore implements AuthoringTaskStore {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly databaseName = DB_NAME) {}
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(failure("storage_unknown", "IndexedDB is unavailable for Host task recovery"));
        return;
      }
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("tasks")) request.result.createObjectStore("tasks", { keyPath: "key" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(failure("storage_unknown", "Host task journal could not be opened"));
      request.onblocked = () => reject(failure("storage_unknown", "Host task journal upgrade is blocked by another tab"));
    });
    return this.database;
  }
  async get(key: string): Promise<StoredAuthoringTask | undefined> {
    const db = await this.open();
    const result = await this.request<StoredAuthoringTask | undefined>(db.transaction("tasks", "readonly").objectStore("tasks").get(key));
    return result && structuredClone(result);
  }
  async list(): Promise<StoredAuthoringTask[]> {
    const db = await this.open();
    return structuredClone(await this.request<StoredAuthoringTask[]>(db.transaction("tasks", "readonly").objectStore("tasks").getAll()));
  }
  async transact<T>(key: string, update: (current?: StoredAuthoringTask) => { next?: StoredAuthoringTask; value: T }): Promise<T> {
    const db = await this.open();
    let transaction: IDBTransaction;
    try { transaction = db.transaction("tasks", "readwrite", { durability: "strict" }); }
    catch { throw failure("storage_unknown", "This browser cannot provide strict Host task transactions"); }
    const store = transaction.objectStore("tasks");
    const request = store.get(key) as IDBRequest<StoredAuthoringTask | undefined>;
    return new Promise((resolve, reject) => {
      let value: T;
      let callbackFailed = false;
      request.onsuccess = () => {
        try {
          const result = update(request.result && structuredClone(request.result));
          value = result.value;
          if (result.next) store.put(structuredClone(result.next));
          else if (request.result) store.delete(key);
        } catch (error) {
          callbackFailed = true;
          try { transaction.abort(); } catch { /* Transaction already ended. */ }
          reject(error);
        }
      };
      request.onerror = () => reject(failure("storage_unknown", "Host task state could not be read for update"));
      transaction.oncomplete = () => { if (!callbackFailed) resolve(value!); };
      transaction.onerror = () => reject(failure("storage_unknown", "Host task transaction failed"));
      transaction.onabort = () => { if (!callbackFailed) reject(failure("storage_unknown", "Host task transaction was interrupted")); };
    });
  }
  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(failure("storage_unknown", "Host task journal read failed"));
    });
  }
}

/** Task lifecycle and step permits stay in the Host; plugin code only supplies bounded progress. */
export class AuthoringTaskRegistry {
  private readonly active = new Map<string, ActiveTask>();
  private readonly listeners = new Set<(update: AuthoringTaskUpdate) => void>();
  private readonly pendingUpdates = new Map<string, AuthoringTaskUpdate>();
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private beginQueue: Promise<void> = Promise.resolve();
  readonly sessionId: string;
  constructor(private readonly store: AuthoringTaskStore = new MemoryAuthoringTaskStore(),
    private readonly now = () => Date.now(), sessionId = randomId()) {
    this.sessionId = sessionId;
  }

  async begin(requestId: string, epoch: number, scope: Scope, snapshot: Snapshot, taskId: string,
    identity: AuthoringTaskIdentity, controller: AbortController): Promise<TaskBeginResult> {
    const releaseBegin = await this.acquireBegin();
    try {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId) || !identity.idempotency_key ||
        identity.plugin_id !== "proprium.semantic" || !identity.plugin_version || !/^[a-f0-9]{64}$/u.test(identity.manifest_digest) ||
        !identity.config_digest || identity.config_digest.length > 256 || !Number.isSafeInteger(epoch) || epoch < 1) {
      throw failure("invalid_input", "Task identity is invalid");
    }
    const key = keyFor(identity.plugin_id, scope, taskId);
    const conflicting = (await this.store.list()).find(record => record.key !== key && record.identity.plugin_id === identity.plugin_id &&
      sameStableScope(record.scope, scope) && (record.progress.state === "running" ||
        (record.progress.state !== "complete" && record.progress.resumable)));
    if (conflicting) throw failure("capacity", "A resumable Semantic task already exists for this repository and branch");
    const outcome = await this.store.transact<TaskBeginResult>(key, current => {
      if (current) {
        if (!sameStableScope(current.scope, scope) || !sameSnapshot(current.snapshot, snapshot)) {
          throw failure("snapshot_stale", "Task ID belongs to a different Host snapshot");
        }
        if (current.identity.plugin_version !== identity.plugin_version || current.identity.manifest_digest !== identity.manifest_digest ||
            current.identity.config_digest !== identity.config_digest) {
          throw failure("idempotency_conflict", "Task ID belongs to a different plugin, model or configuration");
        }
        const local = this.active.get(key);
        if (local || (current.progress.state === "running" && current.owner_id !== this.sessionId &&
            this.now() - current.updated_at < STALE_OWNER_MS)) {
          return { next: current, value: { disposition: "already_active" as const, task: current } };
        }
        if (current.progress.state === "complete") return { next: current, value: { disposition: "complete" as const, task: current } };
        const resumed: StoredAuthoringTask = {
          ...current, scope: structuredClone(scope), snapshot: structuredClone(snapshot), activation_epoch: epoch, owner_id: this.sessionId,
          progress: { ...current.progress, state: "running", resumable: true,
            ...(current.progress.phase === "model_loading" ? { completed: 0 } : {}) }, updated_at: this.now(),
        };
        return { next: resumed, value: { disposition: "resumed" as const, task: resumed } };
      }
      const created: StoredAuthoringTask = {
        key, identity: structuredClone(identity), scope: structuredClone(scope), snapshot: structuredClone(snapshot),
        activation_epoch: epoch, owner_id: this.sessionId, step_sequence: 0,
        progress: { taskId, state: "running", phase: "cache_validation", completed: 0, total: 1, resumable: true },
        updated_at: this.now(),
      };
      return { next: created, value: { disposition: "started" as const, task: created } };
    });
    if (outcome.disposition === "started" || outcome.disposition === "resumed") {
      this.active.set(key, { startRequestId: requestId, startController: controller });
      this.emit(outcome.task);
    }
    return outcome;
    } finally { releaseBegin(); }
  }

  async status(scope: Scope, snapshot: Snapshot, pluginVersion?: string, manifestDigest?: string): Promise<HostTaskProgress[]> {
    const records = (await this.store.list()).filter(row => row.identity.plugin_id === "proprium.semantic" && sameStableScope(row.scope, scope))
      .sort((left, right) => right.updated_at - left.updated_at);
    const selected=records.find(item=>item.progress.state!=="complete")??records[0];
    for (const record of selected?[selected]:[]) {
      const active = this.active.get(record.key);
      const exactSnapshot = sameSnapshot(record.snapshot, snapshot);
      const compatiblePlugin = (!pluginVersion || record.identity.plugin_version === pluginVersion) &&
        (!manifestDigest || record.identity.manifest_digest === manifestDigest);
      let progress = record.progress;
      if (progress.state === "running" && !active && this.now() - record.updated_at >= STALE_OWNER_MS) {
        progress = { ...progress, state: "paused", resumable: exactSnapshot && compatiblePlugin };
        const updated = await this.store.transact<StoredAuthoringTask | undefined>(record.key, current => current && current.owner_id === record.owner_id &&
          current.progress.state === "running" ? {
            next: { ...current, owner_id: "", progress, updated_at: this.now() },
            value: { ...current, owner_id: "", progress, updated_at: this.now() },
          } : { next: current, value: current });
        if (updated) this.emit(updated);
      } else if ((!exactSnapshot || !compatiblePlugin) && progress.state !== "complete") {
        const stale = await this.store.transact<StoredAuthoringTask | undefined>(record.key, current => {
          if (!current || current.progress.state === "complete") return { next: current, value: current };
          const next = { ...current, owner_id: "", progress: { ...current.progress, state: "paused" as const, resumable: false }, updated_at: this.now() };
          return { next, value: next };
        });
        if (stale) {
          progress = stale.progress;
          const active = this.active.get(record.key);
          active?.startController?.abort(); active?.step?.controller.abort();
          this.active.delete(record.key);
          this.emit(stale);
        } else progress = { ...progress, state: "paused", resumable: false };
      }
      return [{ ...progress }];
    }
    return [];
  }

  async cancel(scope: Scope, epoch: number, taskId: string): Promise<boolean> {
    const key = keyFor("proprium.semantic", scope, taskId);
    const active = this.active.get(key);
    const outcome = await this.store.transact<{ cancelled: boolean; task?: StoredAuthoringTask }>(key, current => {
      if (!current || !sameStableScope(current.scope, scope) || current.progress.taskId !== taskId ||
          current.activation_epoch !== epoch || current.progress.state === "complete" ||
          (current.owner_id && current.owner_id !== this.sessionId)) {
        return { next: current, value: { cancelled: false, ...(current ? { task: current } : {}) } };
      }
      const progress = { ...current.progress, state: "cancelled" as const, resumable: current.progress.resumable };
      const task = { ...current, owner_id: "", progress, updated_at: this.now() };
      return { next: task, value: { cancelled: true, task } };
    });
    if (outcome.cancelled) {
      if (outcome.task) this.emit(outcome.task);
      active?.startController?.abort();
      active?.step?.controller.abort();
      this.active.delete(key);
    }
    return outcome.cancelled;
  }

  async update(requestId: string, epoch: number, scope: Scope, value: unknown): Promise<{ stored: true }> {
    const row = this.progressValue(value);
    const found = await this.findForRequest(requestId, epoch, scope);
    if (!found || found.task.progress.taskId !== row.taskId) throw invalid();
    const progress = { ...found.task.progress, phase: row.phase, completed: row.completed, total: row.total, resumable: true };
    await this.updateRecord(found.task, progress);
    return { stored: true };
  }

  async setStartResult(requestId: string, epoch: number, scope: Scope, value: unknown): Promise<StoredAuthoringTask> {
    const row = this.resultValue(value);
    const found = await this.findForRequest(requestId, epoch, scope, true);
    if (!found || found.task.progress.taskId !== row.taskId) throw invalid();
    const complete = row.state === "complete";
    const progress: HostTaskProgress = { ...found.task.progress, state: row.state, phase: row.phase,
      completed: row.completed, total: row.total, resumable: !complete };
    const updated = await this.updateRecord(found.task, progress);
    const active = this.active.get(found.task.key);
    if (active) {
      active.startRequestId = undefined; active.startController = undefined;
      if (complete) this.active.delete(found.task.key);
    }
    return updated;
  }

  async authorizeStep(scope: Scope, epoch: number, taskId: string, sequence: number, requestId: string,
    idempotencyKey: string, controller: AbortController): Promise<TaskStepPermit> {
    const key = keyFor("proprium.semantic", scope, taskId);
    const record = await this.store.get(key);
    if (!record || record.owner_id !== this.sessionId || record.activation_epoch !== epoch || record.progress.state !== "running" ||
        !sameScope(record.scope, scope)) throw failure("capability_denied", "No Host task owns this step");
    const active = this.active.get(record.key);
    if (!active || active.step || sequence !== record.step_sequence + 1 || !requestId || !idempotencyKey) {
      throw failure("capacity", "Host task step sequence is already active or out of order");
    }
    const permit = { task_key: record.key, task_id: taskId, sequence, request_id: requestId, idempotency_key: idempotencyKey, controller };
    active.step = { ...permit, consumed: false };
    return permit;
  }

  async consumeStepPermit(requestId: string, epoch: number, scope: Scope, taskId: string,
    sequence: number, idempotencyKey?: string): Promise<boolean> {
    const found = await this.findForRequest(requestId, epoch, scope);
    const permit = found && this.active.get(found.task.key)?.step;
    if (!found || !permit || permit.consumed || permit.request_id !== requestId || permit.task_id !== taskId ||
        permit.sequence !== sequence || permit.idempotency_key !== idempotencyKey || found.task.progress.state !== "running") return false;
    permit.consumed = true;
    return true;
  }

  async setStepResult(requestId: string, epoch: number, scope: Scope, value: unknown): Promise<StoredAuthoringTask> {
    const row = this.resultValue(value);
    const found = await this.findForRequest(requestId, epoch, scope);
    const permit = found && this.active.get(found.task.key)?.step;
    if (!found || !permit?.consumed || permit.task_id !== row.taskId || permit.sequence !== found.task.step_sequence + 1) throw invalid();
    const complete = row.state === "complete";
    const progress: HostTaskProgress = { ...found.task.progress, state: row.state, phase: row.phase,
      completed: row.completed, total: row.total, resumable: !complete };
    return this.updateRecord(found.task, progress, permit.sequence);
  }

  async finishStep(requestId: string, error?: unknown): Promise<void> {
    const activeEntry = [...this.active.entries()].find(([, active]) => active.step?.request_id === requestId);
    if (!activeEntry) return;
    const [key, active] = activeEntry;
    active.step = undefined;
    if (error !== undefined) {
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code : "guest_trap";
      const updated = await this.store.transact<StoredAuthoringTask | undefined>(key, current => {
        if (!current || current.progress.state !== "running") return { next: current, value: undefined };
        const progress = { ...current.progress,
          state: code === "cancelled" ? "cancelled" as const : "failed" as const,
          resumable: current.progress.resumable && !["snapshot_stale", "storage_unknown", "capability_denied", "incompatible_abi"].includes(code) };
        const next = { ...current, owner_id: "", progress, updated_at: this.now() };
        return { next, value: next };
      });
      if (updated) this.emit(updated);
      this.active.delete(key);
    } else {
      const task=await this.store.get(key);
      if(task?.progress.state==="complete")this.active.delete(key);
    }
  }

  async finishTask(key: string, state: "failed" | "paused", code?: string): Promise<void> {
    const active = this.active.get(key);
    active?.step?.controller.abort();
    active?.startController?.abort();
    const updated = await this.store.transact<StoredAuthoringTask | undefined>(key, current => {
      if (!current || current.progress.state === "complete" || current.progress.state === "cancelled") return { next: current, value: undefined };
      const resumable = current.progress.resumable && !["snapshot_stale", "storage_unknown", "capability_denied", "incompatible_abi"].includes(code ?? "");
      const progress = { ...current.progress, state, resumable };
      const next = { ...current, owner_id: "", progress, updated_at: this.now() };
      return { next, value: next };
    });
    if (updated) this.emit(updated);
    this.active.delete(key);
  }

  subscribe(listener: (update: AuthoringTaskUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async task(pluginId: string, scope: Scope, taskId: string): Promise<StoredAuthoringTask | undefined> {
    const value = await this.store.get(keyFor(pluginId, scope, taskId));
    return value && structuredClone(value);
  }

  async taskByKey(key: string): Promise<StoredAuthoringTask | undefined> {
    const value = await this.store.get(key);
    return value && structuredClone(value);
  }

  async dispose(): Promise<void> {
    const activeRows = [...this.active.entries()];
    for (const [, active] of activeRows) {
      active.startController?.abort();
      active.step?.controller.abort();
    }
    await Promise.all(activeRows.map(async ([key]) => this.finishTask(key, "paused")));
    this.active.clear();
  }

  private async findForRequest(requestId: string, epoch: number, scope?: Scope, allowStart = false) {
    const rows = await this.store.list();
    const row = rows.find(task => {
      const active = this.active.get(task.key);
      const requestMatches = allowStart ? active?.startRequestId === requestId :
        active?.step?.request_id === requestId || active?.startRequestId === requestId;
      return requestMatches && task.activation_epoch === epoch && (!scope || sameScope(task.scope, scope));
    });
    if (!row) return undefined;
    return { task: row };
  }

  private progressValue(value: unknown): { taskId: string; phase: string; completed: number; total: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !["taskId", "phase", "completed", "total"].includes(key)) ||
        typeof row.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.taskId) ||
        typeof row.phase !== "string" || !phases.has(row.phase) ||
        !Number.isSafeInteger(row.completed) || !Number.isSafeInteger(row.total) ||
        (row.completed as number) < 0 || (row.total as number) < (row.completed as number)) throw invalid();
    return row as { taskId: string; phase: string; completed: number; total: number };
  }

  private resultValue(value: unknown): { taskId: string; state: "running" | "complete"; phase: string; completed: number; total: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (typeof row.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.taskId) ||
        !(row.state === "running" || row.state === "complete") || typeof row.phase !== "string" || !phases.has(row.phase) ||
        !Number.isSafeInteger(row.completed) || !Number.isSafeInteger(row.total) ||
        (row.completed as number) < 0 || (row.total as number) < (row.completed as number)) throw invalid();
    return row as { taskId: string; state: "running" | "complete"; phase: string; completed: number; total: number };
  }

  private async updateRecord(current: StoredAuthoringTask, progress: HostTaskProgress, sequence = current.step_sequence): Promise<StoredAuthoringTask> {
    const updated = await this.store.transact(current.key, saved => {
      if (!saved || saved.owner_id !== this.sessionId || saved.activation_epoch !== current.activation_epoch ||
          !sameScope(saved.scope, current.scope) || !sameSnapshot(saved.snapshot, current.snapshot)) throw invalid();
      if (saved.progress.phase === progress.phase && progress.completed < saved.progress.completed) throw invalid();
      const next: StoredAuthoringTask = { ...saved, step_sequence: sequence, progress: structuredClone(progress), updated_at: this.now() };
      return { next, value: next };
    });
    this.emit(updated);
    return updated;
  }

  private emit(record: StoredAuthoringTask): void {
    if (!this.listeners.size) return;
    this.pendingUpdates.set(record.key, { scope: structuredClone(record.scope), snapshot: structuredClone(record.snapshot),
      task: structuredClone(record.progress) });
    if (this.notificationTimer !== undefined) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      const updates = [...this.pendingUpdates.values()];
      this.pendingUpdates.clear();
      for (const update of updates) for (const listener of this.listeners) listener(update);
    }, 100);
  }

  private async acquireBegin(): Promise<() => void> {
    const previous = this.beginQueue;
    let release!: () => void;
    this.beginQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(row[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
