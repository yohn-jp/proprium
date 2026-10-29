import type { Scope, Snapshot } from "./types.js";

export const SEMANTIC_PROGRESS_KEY = "semantic-task-progress-v1";
const DB_NAME = "proprium-authoring-tasks-v1";
const STALE_OWNER_MS = 30_000;
export interface AuthoringTaskProfile {
  readonly profile_id: string;
  readonly plugin_id: string;
  readonly start_action_id: string;
  readonly step_action_id: string;
  readonly status_action_id: string;
  readonly cancel_action_id: string;
  readonly initial_phase: string;
  readonly phases: ReadonlySet<string>;
  /** The source count is unknown until Research finishes paging through the Git tree. */
  readonly allow_indeterminate_progress?: boolean;
  /** Guest cursors may live only in a Worker. Restart the bounded job after a Host reload. */
  readonly restart_on_new_session?: boolean;
}
const semanticProfile: AuthoringTaskProfile = Object.freeze({
  profile_id: "semantic-index-v1", plugin_id: "proprium.semantic", start_action_id: "proprium.semantic.index.rebuild", step_action_id: "proprium.semantic.index.step",
  status_action_id: "proprium.semantic.task.status", cancel_action_id: "proprium.semantic.task.cancel", initial_phase: "cache_validation",
  phases: new Set(["source_scan", "model_loading", "embedding", "cache_validation", "cache_publish", "query_embedding",
    "vector_scan", "reranking", "term_embedding", "mention_scan", "candidate_scoring", "complete"]),
});
const researchProfile: AuthoringTaskProfile = Object.freeze({
  profile_id: "research-index-v1", plugin_id: "proprium.research", start_action_id: "research.index.rebuild", step_action_id: "research.index.step",
  status_action_id: "research.task.status", cancel_action_id: "research.task.cancel", initial_phase: "source_scan",
  restart_on_new_session: true,
  allow_indeterminate_progress: true,
  phases: new Set(["source_scan", "index_build", "cache_publish", "complete"]),
});
const semanticRerankerProfile: AuthoringTaskProfile = Object.freeze({
  profile_id: "semantic-reranker-v1", plugin_id: "proprium.semantic", start_action_id: "proprium.semantic.reranker.prepare",
  step_action_id: "proprium.semantic.reranker.prepare.step", status_action_id: "proprium.semantic.reranker.task.status",
  cancel_action_id: "proprium.semantic.reranker.task.cancel", initial_phase: "inspect_graph",
  restart_on_new_session: true,
  phases: new Set(["inspect_graph", "load_tensors", "load_tokenizer", "compile", "complete"]),
});
const taskProfiles = new Map([
  [semanticProfile.plugin_id, semanticProfile], [researchProfile.plugin_id, researchProfile],
  ...[semanticRerankerProfile.start_action_id, semanticRerankerProfile.step_action_id,
    semanticRerankerProfile.status_action_id, semanticRerankerProfile.cancel_action_id]
    .map(actionId => [semanticRerankerProfile.plugin_id + ":" + actionId, semanticRerankerProfile] as const),
]);
const defaultTaskProfiles = new Map([[semanticProfile.plugin_id, semanticProfile], [researchProfile.plugin_id, researchProfile]]);
const profilesById = new Map([semanticProfile, researchProfile, semanticRerankerProfile].map(profile => [profile.profile_id, profile]));
export function getAuthoringTaskProfile(pluginId: string): AuthoringTaskProfile | undefined { return defaultTaskProfiles.get(pluginId); }
export function getAuthoringTaskProfileById(profileId: string): AuthoringTaskProfile | undefined { return profilesById.get(profileId); }
export function getAuthoringTaskProfileForAction(pluginId: string, actionId: string): AuthoringTaskProfile | undefined {
  const profile = getAuthoringTaskProfile(pluginId);
  if (profile && [profile.start_action_id, profile.step_action_id, profile.status_action_id, profile.cancel_action_id].includes(actionId)) return profile;
  const qualified = taskProfiles.get(pluginId + ":" + actionId);
  return qualified && [qualified.start_action_id, qualified.step_action_id, qualified.status_action_id, qualified.cancel_action_id].includes(actionId)
    ? qualified : undefined;
}

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
  readonly pluginId: string;
  readonly scope: Scope;
  readonly snapshot: Snapshot;
  readonly task: HostTaskProgress;
}
export interface AuthoringTaskIdentity {
  readonly plugin_id: string;
  /** Missing only on schema-v1 durable records, which belong to the default profile for that plugin. */
  readonly profile_id?: string;
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
function profileForIdentity(identity: AuthoringTaskIdentity): AuthoringTaskProfile | undefined {
  if (identity.profile_id) {
    const profile = getAuthoringTaskProfileById(identity.profile_id);
    return profile?.plugin_id === identity.plugin_id ? profile : undefined;
  }
  return getAuthoringTaskProfile(identity.plugin_id);
}
const phaseFor = (profile: AuthoringTaskProfile | undefined, phase: unknown): phase is string => profile?.phases.has(String(phase)) === true;
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
        !profileForIdentity(identity) || !identity.plugin_version || !/^[a-f0-9]{64}$/u.test(identity.manifest_digest) ||
        !/^[a-f0-9]{64}$/u.test(identity.config_digest) || !Number.isSafeInteger(epoch) || epoch < 1) {
      throw failure("invalid_input", "Task identity is invalid");
    }
    const key = keyFor(identity.plugin_id, scope, taskId);
    const conflicting = (await this.store.list()).find(record => record.key !== key && record.identity.plugin_id === identity.plugin_id &&
      record.identity.config_digest === identity.config_digest &&
      sameStableScope(record.scope, scope) && (record.progress.state === "running" ||
        (record.progress.state !== "complete" && record.progress.resumable)));
    if (conflicting) throw failure("capacity", "A resumable authoring task already exists for this repository and branch");
    const outcome = await this.store.transact<TaskBeginResult>(key, current => {
      if (current) {
        if (!sameStableScope(current.scope, scope) || !sameSnapshot(current.snapshot, snapshot)) {
          throw failure("snapshot_stale", "Task ID belongs to a different Host snapshot");
        }
        if (profileForIdentity(current.identity)?.profile_id !== profileForIdentity(identity)?.profile_id ||
            current.identity.plugin_version !== identity.plugin_version || current.identity.manifest_digest !== identity.manifest_digest ||
            current.identity.config_digest !== identity.config_digest) {
          throw failure("idempotency_conflict", "Task ID belongs to a different plugin, model or configuration");
        }
        const local = this.active.get(key);
        if (local || (current.progress.state === "running" && current.owner_id !== this.sessionId &&
            this.now() - current.updated_at < STALE_OWNER_MS)) {
          return { next: current, value: { disposition: "already_active" as const, task: current } };
        }
        if (current.progress.state === "complete") return { next: current, value: { disposition: "complete" as const, task: current } };
        const restartFromSource = current.owner_id !== this.sessionId && profileForIdentity(identity)?.restart_on_new_session === true;
        const resumed: StoredAuthoringTask = {
          ...current, scope: structuredClone(scope), snapshot: structuredClone(snapshot), activation_epoch: epoch, owner_id: this.sessionId,
          ...(restartFromSource ? { step_sequence: 0 } : {}),
          progress: restartFromSource
            ? { ...current.progress, state: "running", phase: profileForIdentity(identity)!.initial_phase, completed: 0, total: 1, resumable: true }
            : { ...current.progress, state: "running", resumable: true,
              ...(current.progress.phase === "model_loading" ? { completed: 0 } : {}) },
          updated_at: this.now(),
        };
        return { next: resumed, value: { disposition: "resumed" as const, task: resumed } };
      }
      const created: StoredAuthoringTask = {
        key, identity: structuredClone(identity), scope: structuredClone(scope), snapshot: structuredClone(snapshot),
        activation_epoch: epoch, owner_id: this.sessionId, step_sequence: 0,
        progress: { taskId, state: "running", phase: profileForIdentity(identity)!.initial_phase, completed: 0, total: 1, resumable: true },
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

  async status(pluginId: string, scope: Scope, snapshot: Snapshot, pluginVersion?: string, manifestDigest?: string,
    profileId = defaultTaskProfiles.get(pluginId)?.profile_id, taskId?: string): Promise<HostTaskProgress[]> {
    const profile = profileId ? getAuthoringTaskProfileById(profileId) : undefined;
    if (profile?.plugin_id !== pluginId) return [];
    const records = (await this.store.list()).filter(row => row.identity.plugin_id === pluginId && sameStableScope(row.scope, scope))
      .sort((left, right) => right.updated_at - left.updated_at);
    const scopedRecords = records.filter(item => profileForIdentity(item.identity)?.profile_id === profileId && (!taskId || item.progress.taskId === taskId));
    const selected=scopedRecords.find(item=>item.progress.state!=="complete")??scopedRecords[0];
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

  async cancel(pluginId: string, scope: Scope, epoch: number, taskId: string, profileId?: string): Promise<boolean> {
    const profile = profileId ? getAuthoringTaskProfileById(profileId) : getAuthoringTaskProfile(pluginId);
    if (profile?.plugin_id !== pluginId) return false;
    const key = keyFor(pluginId, scope, taskId);
    const active = this.active.get(key);
    const outcome = await this.store.transact<{ cancelled: boolean; task?: StoredAuthoringTask }>(key, current => {
      if (!current || profileForIdentity(current.identity)?.profile_id !== profile.profile_id || !sameStableScope(current.scope, scope) || current.progress.taskId !== taskId ||
          current.activation_epoch !== epoch || current.progress.state === "complete" ||
          (current.owner_id && current.owner_id !== this.sessionId)) {
        return { next: current, value: { cancelled: false, ...(current ? { task: current } : {}) } };
      }
      const progress = { ...current.progress, state: "cancelled" as const, resumable: current.progress.resumable };
      // Keep the last runner session on resumable tasks so same-session restarts can retain a Worker cursor.
      const task = { ...current, owner_id: current.owner_id || this.sessionId, progress, updated_at: this.now() };
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
    const found = await this.findForRequest(requestId, epoch, scope);
    const row = this.progressValue(value, found?.task.identity);
    if (!found || found.task.progress.taskId !== row.taskId) throw invalid();
    const progress = { ...found.task.progress, phase: row.phase, completed: row.completed, total: row.total, resumable: true };
    await this.updateRecord(found.task, progress);
    return { stored: true };
  }

  async setStartResult(requestId: string, epoch: number, scope: Scope, value: unknown): Promise<StoredAuthoringTask> {
    const found = await this.findForRequest(requestId, epoch, scope, true);
    const row = this.resultValue(value, found?.task.identity);
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

  async authorizeStep(pluginId: string, scope: Scope, epoch: number, taskId: string, sequence: number, requestId: string,
    idempotencyKey: string, controller: AbortController, profileId = defaultTaskProfiles.get(pluginId)?.profile_id): Promise<TaskStepPermit> {
    if (!profileId) throw failure("capability_denied", "No Host task profile permits this step");
    const profile = getAuthoringTaskProfileById(profileId);
    if (profile?.plugin_id !== pluginId) throw failure("capability_denied", "No Host task profile permits this step");
    const key = keyFor(pluginId, scope, taskId);
    const record = await this.store.get(key);
    if (!record || profileForIdentity(record.identity)?.profile_id !== profileId || record.owner_id !== this.sessionId || record.activation_epoch !== epoch || record.progress.state !== "running" ||
        !sameScope(record.scope, scope)) throw failure("capability_denied", "No Host task owns this step");
    const active = this.active.get(record.key);
    if (!active || active.step || sequence !== record.step_sequence + 1 || !requestId || !idempotencyKey) {
      throw failure("capacity", "Host task step sequence is already active or out of order");
    }
    const permit = { task_key: record.key, task_id: taskId, sequence, request_id: requestId, idempotency_key: idempotencyKey, controller };
    active.step = { ...permit, consumed: false };
    return permit;
  }

  async consumeStepPermit(pluginId: string, requestId: string, epoch: number, scope: Scope, taskId: string,
    sequence: number, idempotencyKey?: string, profileId = defaultTaskProfiles.get(pluginId)?.profile_id): Promise<boolean> {
    const found = await this.findForRequest(requestId, epoch, scope);
    const permit = found && this.active.get(found.task.key)?.step;
    if (!found || found.task.identity.plugin_id !== pluginId || profileForIdentity(found.task.identity)?.profile_id !== profileId || !permit || permit.consumed || permit.request_id !== requestId || permit.task_id !== taskId ||
        permit.sequence !== sequence || permit.idempotency_key !== idempotencyKey || found.task.progress.state !== "running") return false;
    permit.consumed = true;
    return true;
  }

  async setStepResult(requestId: string, epoch: number, scope: Scope, value: unknown): Promise<StoredAuthoringTask> {
    const found = await this.findForRequest(requestId, epoch, scope);
    const row = this.resultValue(value, found?.task.identity);
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
        const next = { ...current, owner_id: this.sessionId, progress, updated_at: this.now() };
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
      const next = { ...current, owner_id: this.sessionId, progress, updated_at: this.now() };
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

  private progressValue(value: unknown, identity?: AuthoringTaskIdentity): { taskId: string; phase: string; completed: number; total: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    const profile = identity ? profileForIdentity(identity) : undefined;
    const validCounts = Number.isSafeInteger(row.completed) && Number.isSafeInteger(row.total) &&
      (row.total as number) >= 0 && ((row.completed as number) <= (row.total as number) ||
        (profile?.allow_indeterminate_progress === true && row.total === 0 && row.phase === "source_scan"));
    if (Object.keys(row).some(key => !["taskId", "phase", "completed", "total"].includes(key)) ||
        typeof row.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.taskId) ||
        typeof row.phase !== "string" || !phaseFor(profile, row.phase) || !validCounts ||
        (row.completed as number) < 0) throw invalid();
    return row as { taskId: string; phase: string; completed: number; total: number };
  }

  private resultValue(value: unknown, identity?: AuthoringTaskIdentity): { taskId: string; state: "running" | "complete"; phase: string; completed: number; total: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    const profile = identity ? profileForIdentity(identity) : undefined;
    const validCounts = Number.isSafeInteger(row.completed) && Number.isSafeInteger(row.total) &&
      (row.total as number) >= 0 && ((row.completed as number) <= (row.total as number) ||
        (profile?.allow_indeterminate_progress === true && row.total === 0 && row.phase === "source_scan"));
    if (typeof row.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.taskId) ||
        !(row.state === "running" || row.state === "complete") || typeof row.phase !== "string" || !phaseFor(profile, row.phase) || !validCounts ||
        (row.completed as number) < 0) throw invalid();
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
    this.pendingUpdates.set(record.key, { pluginId: record.identity.plugin_id, scope: structuredClone(record.scope), snapshot: structuredClone(record.snapshot),
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
