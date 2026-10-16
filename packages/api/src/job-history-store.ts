import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ModuleId, RepositoryIdentity } from "@scriptorium/contracts";
import type { WorkerJobLifecycleSnapshot } from "@scriptorium/module-runtime";

const MAX_RETAINED_JOBS = 500;
const MAX_RETAINED_INBOX = 200;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_LEGACY_ARCHIVE_BYTES = 128 * 1024 * 1024;
const JOB_STATUSES = new Set(["queued", "running", "done", "error"]);
const MODULES = new Set(["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"]);
const PUBLIC_JOB_FIELDS = new Set(["id", "type", "status", "progress", "result", "error", "createdAt", "updatedAt", "finishedAt"]);
const LEGACY_JOB_FIELDS = new Set([...PUBLIC_JOB_FIELDS, "projectKey", "userId"]);
const INBOX_FIELDS = new Set(["id", "kind", "jobId", "jobType", "title", "body", "status", "read", "userId", "projectKey", "createdAt"]);

/** Minimal internal metadata emitted by the runtime; request and result data never enter host history. */
export type WorkerJobLifecycle = WorkerJobLifecycleSnapshot;

export type PublicJobStatus = "queued" | "running" | "done" | "error";

export interface PublicJob {
  id: string;
  type: string;
  status: PublicJobStatus;
  progress: number | null;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface JobEvent {
  type: "job-status";
  jobId: string;
  jobType: string;
  status: PublicJobStatus;
  progress: number | null;
  error?: string;
  at: string;
}

export interface InboxItem {
  id: string;
  kind: "job-complete";
  jobId: string;
  jobType: string;
  title: string;
  body: string;
  status: "done" | "error";
  read: boolean;
  userId: string | null;
  projectKey: string;
  createdAt: string;
}

interface StoredJob {
  ownerKey: string;
  projectKey: string;
  job: PublicJob;
}

interface PersistedState {
  version: 2;
  jobs: StoredJob[];
  inbox: InboxItem[];
  legacySources: string[];
}

export interface LegacyJobHistoryImportOptions {
  workspaceDataRoot: string;
  usageDirectory: string;
  /** Explicit source project key to host-verified stable repository identity mapping. */
  legacyRepositoryMappings: Readonly<Record<string, RepositoryIdentity>>;
  /** Only source-user to the single current API owner can be adopted. */
  legacyUserMappings: Readonly<Record<string, "owner">>;
}

export interface LegacyJobHistoryImportReport {
  sourceHash: string;
  bytes: number;
  archived: true;
  adoptedJobs: number;
  adoptedInbox: number;
  mappingRequired: Array<{ projectKey: string | null; userId: string | null; jobCount: number; inboxCount: number }>;
  adoptionBlocked?: "adoption_size_limit" | "invalid_json" | "invalid_shape" | "invalid_record" | "history_full";
}

export class JobHistoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JobHistoryError";
  }
}

/** Durable owner-host history for real module-runtime jobs. Construction performs no I/O. */
export class JobHistoryStore {
  private readonly root: string;
  private readonly directory: string;
  private readonly filePath: string;
  private loaded = false;
  private state: PersistedState = { version: 2, jobs: [], inbox: [], legacySources: [] };
  private serial = Promise.resolve();

  constructor(usageDirectory: string) {
    if (typeof usageDirectory !== "string" || !usageDirectory.trim()) {
      throw new JobHistoryError("job_history_path_invalid", "A host history directory is required");
    }
    this.root = resolve(usageDirectory);
    this.directory = join(this.root, "jobs");
    this.filePath = join(this.directory, "jobs-state.json");
  }

  async record(lifecycle: WorkerJobLifecycle): Promise<JobEvent> {
    return this.exclusive(async () => {
      await this.load();
      const normalized = normalizeLifecycle(lifecycle);
      const ownerKey = hash("owner");
      const projectKey = repositoryKey({ provider: normalized.provider, ownerScope: normalized.ownerScope, repositoryId: normalized.repositoryId });
      const job = publicJob(normalized);
      const index = this.state.jobs.findIndex((entry) => entry.job.id === job.id);
      const current = index < 0 ? undefined : this.state.jobs[index];
      if (current && (current.ownerKey !== ownerKey || current.projectKey !== projectKey || current.job.type !== job.type)) {
        throw new JobHistoryError("job_identity_conflict", "A worker job ID was reused for another owner, repository, or task");
      }
      if (current && isFinalStatus(current.job.status)) {
        if (JSON.stringify(current.job) !== JSON.stringify(job)) {
          throw new JobHistoryError("job_lifecycle_conflict", "A terminal worker job lifecycle cannot be changed");
        }
        return jobEvent(current.job);
      }
      if (current && !canAdvance(current.job.status, job.status)) {
        throw new JobHistoryError("job_lifecycle_conflict", "Worker job lifecycle moved backwards");
      }
      if (current && Date.parse(job.updatedAt) < Date.parse(current.job.updatedAt)) {
        throw new JobHistoryError("job_lifecycle_conflict", "Worker job lifecycle timestamp moved backwards");
      }
      const next = cloneState(this.state);
      const nextIndex = next.jobs.findIndex((entry) => entry.job.id === job.id);
      if (nextIndex >= 0 && nextIndex < next.jobs.length) next.jobs[nextIndex] = { ownerKey, projectKey, job };
      else next.jobs.push({ ownerKey, projectKey, job });
      pruneJobs(next.jobs);
      if (next.jobs.length > MAX_RETAINED_JOBS) throw new JobHistoryError("job_history_full", "Host job history cannot retain another active worker job");
      if (isTerminal(normalized.state) && current?.job.finishedAt == null) addInboxItem(next, job, ownerKey, projectKey);
      await this.persist(next);
      this.state = next;
      return jobEvent(job);
    });
  }

  async listJobs(): Promise<PublicJob[]> {
    return this.exclusive(async () => {
      await this.load();
      const next = cloneState(this.state);
      if (orphanRunningJobs(next)) {
        await this.persist(next);
        this.state = next;
      }
      return this.state.jobs.map(({ job }) => clonePublicJob(job)).sort(newestFirst);
    });
  }

  async getJob(id: string): Promise<PublicJob | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const next = cloneState(this.state);
      if (orphanRunningJobs(next)) {
        await this.persist(next);
        this.state = next;
      }
      const record = this.state.jobs.find(({ job }) => job.id === id);
      return record ? clonePublicJob(record.job) : undefined;
    });
  }

  async listInbox(options: { unreadOnly?: boolean } = {}): Promise<{ items: InboxItem[]; unreadCount: number }> {
    return this.exclusive(async () => {
      await this.load();
      const items = this.state.inbox.filter((item) => !options.unreadOnly || !item.read)
        .map((item) => ({ ...item })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const unreadCount = this.state.inbox.reduce((count, item) => count + Number(!item.read), 0);
      return { items, unreadCount };
    });
  }

  async markInboxRead(id: string): Promise<InboxItem | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const index = this.state.inbox.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const next = cloneState(this.state);
      const item = next.inbox[index]!;
      item.read = true;
      await this.persist(next);
      this.state = next;
      return { ...item };
    });
  }

  async markAllInboxRead(): Promise<number> {
    return this.exclusive(async () => {
      await this.load();
      const next = cloneState(this.state);
      let marked = 0;
      for (const item of next.inbox) {
        if (!item.read) { item.read = true; marked += 1; }
      }
      if (marked > 0) {
        await this.persist(next);
        this.state = next;
      }
      return marked;
    });
  }

  async adoptArchivedLegacyState(
    sourceHash: string,
    legacyRepositoryMappings: Readonly<Record<string, RepositoryIdentity>>,
    legacyUserMappings: Readonly<Record<string, "owner">>,
  ): Promise<LegacyJobHistoryImportReport> {
    return this.exclusive(async () => {
      await this.load();
      if (!/^[a-f0-9]{64}$/u.test(sourceHash)) throw new JobHistoryError("legacy_jobs_source_invalid", "Legacy job archive identity is invalid");
      const archivePath = join(this.directory, "legacy", `${sourceHash}.json`);
      const raw = await readPrivateFile(archivePath, MAX_LEGACY_ARCHIVE_BYTES);
      if (hashBytes(raw) !== sourceHash) throw new JobHistoryError("legacy_jobs_archive_corrupt", "Legacy job archive integrity check failed");
      const report: LegacyJobHistoryImportReport = {
        sourceHash, bytes: raw.byteLength, archived: true, adoptedJobs: 0, adoptedInbox: 0, mappingRequired: [],
      };
      if (raw.byteLength > MAX_STATE_BYTES) return { ...report, adoptionBlocked: "adoption_size_limit" };
      let decoded: unknown;
      try { decoded = JSON.parse(raw.toString("utf8")) as unknown; }
      catch { return { ...report, adoptionBlocked: "invalid_json" }; }
      if (!isRecord(decoded) || !hasOnlyKeys(decoded, new Set(["jobs", "inbox"])) ||
          !Array.isArray(decoded.jobs) || !Array.isArray(decoded.inbox) ||
          decoded.jobs.length > MAX_RETAINED_JOBS || decoded.inbox.length > MAX_RETAINED_INBOX) {
        return { ...report, adoptionBlocked: "invalid_shape" };
      }

      const plannedJobs: StoredJob[] = [];
      const plannedInbox: InboxItem[] = [];
      const required = new Map<string, { projectKey: string | null; userId: string | null; jobCount: number; inboxCount: number }>();
      let invalidRecords = 0;
      const mapPair = (entry: unknown): { projectKey: string | null; userId: string | null; ownerKey: string; targetProjectKey: string } | undefined => {
        const projectKey = isRecord(entry) && typeof entry.projectKey === "string" && entry.projectKey.length <= 1024 ? entry.projectKey : null;
        const userId = isRecord(entry) && typeof entry.userId === "string" && entry.userId.length <= 512 ? entry.userId : null;
        const repository = projectKey === null ? undefined : ownValue(legacyRepositoryMappings, projectKey);
        const ownerMapping = userId === null ? undefined : ownValue(legacyUserMappings, userId);
        if (!isRepositoryIdentity(repository) || ownerMapping !== "owner") {
          const key = JSON.stringify([projectKey, userId]);
          const row = required.get(key) ?? { projectKey, userId, jobCount: 0, inboxCount: 0 };
          if (isRecord(entry) && "kind" in entry) row.inboxCount += 1;
          else row.jobCount += 1;
          required.set(key, row);
          return undefined;
        }
        return {
          projectKey, userId, ownerKey: hash("owner"),
          targetProjectKey: repositoryKey({ provider: repository.provider, ownerScope: repository.ownerScope, repositoryId: repository.repositoryId }),
        };
      };

      const allJobIds = decoded.jobs.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []);
      const ambiguousJobIds = new Set(allJobIds.filter((id, index) => allJobIds.indexOf(id) !== index));
      const seenJobIds = new Set<string>();
      for (const entry of decoded.jobs) {
        if (isRecord(entry) && typeof entry.id === "string" && ambiguousJobIds.has(entry.id)) {
          invalidRecords += 1;
          continue;
        }
        const mapping = mapPair(entry);
        if (!mapping) continue;
        try {
          const job = normalizeLegacyJob(entry);
          if (seenJobIds.has(job.id)) throw new JobHistoryError("legacy_job_invalid", "Legacy job IDs must be unique");
          seenJobIds.add(job.id);
          const existing = this.state.jobs.find((record) => record.job.id === job.id);
          const planned = plannedJobs.find((record) => record.job.id === job.id);
          const duplicate = existing ?? planned;
          if (duplicate) {
            if (duplicate.ownerKey !== mapping.ownerKey || duplicate.projectKey !== mapping.targetProjectKey ||
                JSON.stringify(duplicate.job) !== JSON.stringify(job)) throw new JobHistoryError("legacy_job_conflict", "Legacy job ID conflicts with retained host history");
          } else plannedJobs.push({ ownerKey: mapping.ownerKey, projectKey: mapping.targetProjectKey, job });
        } catch { invalidRecords += 1; }
      }
      const allInboxIds = decoded.inbox.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []);
      const ambiguousInboxIds = new Set(allInboxIds.filter((id, index) => allInboxIds.indexOf(id) !== index));
      const seenInboxIds = new Set<string>();
      for (const entry of decoded.inbox) {
        if (isRecord(entry) && typeof entry.id === "string" && ambiguousInboxIds.has(entry.id)) {
          invalidRecords += 1;
          continue;
        }
        const mapping = mapPair(entry);
        if (!mapping) continue;
        try {
          const item = normalizeLegacyInboxItem(entry, mapping.targetProjectKey);
          if (seenInboxIds.has(item.id)) throw new JobHistoryError("legacy_inbox_invalid", "Legacy inbox IDs must be unique");
          seenInboxIds.add(item.id);
          const existing = this.state.inbox.find(({ id }) => id === item.id);
          const planned = plannedInbox.find(({ id }) => id === item.id);
          const duplicate = existing ?? planned;
          if (duplicate) {
            if (JSON.stringify(duplicate) !== JSON.stringify(item)) throw new JobHistoryError("legacy_inbox_conflict", "Legacy inbox ID conflicts with retained host history");
          } else plannedInbox.push(item);
        } catch { invalidRecords += 1; }
      }
      report.mappingRequired = [...required.values()].sort((a, b) =>
        (a.projectKey ?? "").localeCompare(b.projectKey ?? "") || (a.userId ?? "").localeCompare(b.userId ?? ""));
      if (invalidRecords > 0) return { ...report, adoptionBlocked: "invalid_record" };
      const next = cloneState(this.state);
      next.jobs.push(...plannedJobs);
      next.inbox.push(...plannedInbox);
      pruneJobs(next.jobs);
      if (next.jobs.length > MAX_RETAINED_JOBS || next.inbox.length > MAX_RETAINED_INBOX) {
        return { ...report, adoptionBlocked: "history_full" };
      }
      if (!next.legacySources.includes(sourceHash)) next.legacySources.push(sourceHash);
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_STATE_BYTES) return { ...report, adoptionBlocked: "history_full" };
      if (plannedJobs.length || plannedInbox.length || next.legacySources.length !== this.state.legacySources.length) {
        await this.persist(next);
        this.state = next;
      }
      return { ...report, adoptedJobs: plannedJobs.length, adoptedInbox: plannedInbox.length };
    });
  }

  /** Wait for callbacks already accepted by the store. */
  async flush(): Promise<void> {
    await this.serial;
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let rootExists = false;
    try { await assertPrivateDirectory(this.root); rootExists = true; }
    catch (error) { if (!isCode(error, "ENOENT")) throw error; }
    if (!rootExists) { this.loaded = true; return; }
    try { await assertPrivateDirectory(this.directory); }
    catch (error) { if (isCode(error, "ENOENT")) { this.loaded = true; return; } throw error; }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_STATE_BYTES || (info.mode & 0o077) !== 0) historyCorrupt();
      const decoded: unknown = JSON.parse(await handle.readFile("utf8"));
      this.state = normalizeState(decoded);
      this.loaded = true;
    } catch (error) {
      if (isCode(error, "ENOENT")) { this.loaded = true; return; }
      if (error instanceof JobHistoryError) throw error;
      throw new JobHistoryError("job_history_corrupt", "Host job history cannot be read safely");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async persist(next: PersistedState): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.root);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.directory);
    await syncDirectory(this.root);
    const serialized = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new JobHistoryError("job_history_full", "Host job history exceeds its storage limit");
    }
    const temporary = join(this.directory, `.tmp-${randomBytes(16).toString("hex")}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await rename(temporary, this.filePath);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        throw new JobHistoryError("job_history_write_failed", "Host job history could not be atomically replaced");
      }
      await syncDirectory(this.directory);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}

/** Archive and selectively adopt the legacy job file without modifying its source. */
export async function importLegacyJobHistory(options: LegacyJobHistoryImportOptions): Promise<LegacyJobHistoryImportReport> {
  if (!options.workspaceDataRoot?.trim() || !options.usageDirectory?.trim()) {
    throw new JobHistoryError("legacy_jobs_path_invalid", "Legacy and host history directories are required");
  }
  if (!isRecord(options.legacyRepositoryMappings) || !isRecord(options.legacyUserMappings)) {
    throw new JobHistoryError("legacy_jobs_mapping_invalid", "Explicit legacy repository and owner mappings are required");
  }
  const workspaceDataRoot = resolve(options.workspaceDataRoot);
  const usageDirectory = resolve(options.usageDirectory);
  if (isWithin(workspaceDataRoot, usageDirectory) || isWithin(usageDirectory, workspaceDataRoot)) {
    throw new JobHistoryError("legacy_jobs_path_invalid", "Legacy jobs must be archived outside the disposable workspace data root");
  }
  const workspaceInfo = await lstat(workspaceDataRoot);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
    throw new JobHistoryError("legacy_jobs_path_invalid", "Legacy workspace data root must be a real directory");
  }
  const sourceDirectory = join(workspaceDataRoot, "app-state");
  await assertPrivateDirectory(sourceDirectory);
  const sourceBytes = await readPrivateFile(join(sourceDirectory, "jobs-state.json"), MAX_LEGACY_ARCHIVE_BYTES);
  const sourceHash = hashBytes(sourceBytes);
  const historyRoot = usageDirectory;
  const jobsDirectory = join(historyRoot, "jobs");
  const legacyDirectory = join(jobsDirectory, "legacy");
  await mkdir(historyRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(historyRoot);
  await mkdir(jobsDirectory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(jobsDirectory);
  await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(legacyDirectory);
  await syncDirectory(historyRoot);
  await syncDirectory(jobsDirectory);
  const targetPath = join(legacyDirectory, `${sourceHash}.json`);
  await archiveImmutable(targetPath, legacyDirectory, sourceBytes);
  return new JobHistoryStore(historyRoot).adoptArchivedLegacyState(
    sourceHash, options.legacyRepositoryMappings, options.legacyUserMappings,
  );
}

function normalizeLifecycle(value: unknown): WorkerJobLifecycle & { ownerScope: string; provider: RepositoryIdentity["provider"]; repositoryId: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["jobId", "module", "task", "snapshot", "state", "createdAt", "updatedAt", "startedAt", "finishedAt", "errorCode"]))) {
    throw new JobHistoryError("job_event_invalid", "Worker lifecycle metadata is invalid");
  }
  const jobId = boundedText(value.jobId, 1, 128, /^[A-Za-z0-9_-]+$/u, "job ID");
  const module = boundedText(value.module, 1, 32, /^[a-z][a-z0-9-]*$/u, "module") as ModuleId;
  if (!MODULES.has(module)) throw new JobHistoryError("job_event_invalid", "Worker module is invalid");
  const task = boundedText(value.task, 1, 128, /^[A-Za-z0-9._:-]+$/u, "task");
  const snapshot = value.snapshot;
  if (!isRecord(snapshot) || !isRecord(snapshot.repository)) throw new JobHistoryError("job_event_invalid", "Worker snapshot identity is invalid");
  const repository = snapshot.repository;
  const provider = repository.provider;
  if (provider !== "github" && provider !== "local") throw new JobHistoryError("job_event_invalid", "Worker repository provider is invalid");
  const ownerScope = boundedText(repository.ownerScope, 1, 256, /^[^\x00-\x1f\x7f]+$/u, "owner scope");
  const repositoryId = boundedText(repository.repositoryId, 1, 256, /^[A-Za-z0-9._:-]+$/u, "repository ID");
  if (value.state !== "queued" && value.state !== "running" && value.state !== "succeeded" && value.state !== "failed" && value.state !== "cancelled") {
    throw new JobHistoryError("job_event_invalid", "Worker state is invalid");
  }
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  const startedAt = value.startedAt === null ? null : timestamp(value.startedAt, "startedAt");
  const finishedAt = value.finishedAt === null ? null : timestamp(value.finishedAt, "finishedAt");
  const errorCode = value.errorCode === undefined ? undefined : boundedText(value.errorCode, 1, 128, /^[A-Za-z0-9_.-]+$/u, "error code");
  const normalizedSnapshot = snapshot as unknown as WorkerJobLifecycle["snapshot"];
  return {
    jobId, module, task, snapshot: normalizedSnapshot, state: value.state, createdAt, updatedAt, startedAt, finishedAt,
    ...(errorCode ? { errorCode } : {}), ownerScope, provider, repositoryId,
  };
}

function normalizeLegacyJob(value: unknown): PublicJob {
  if (!isRecord(value) || !hasOnlyKeys(value, LEGACY_JOB_FIELDS) ||
      (value.userId !== null && (typeof value.userId !== "string" || value.userId.length > 512)) ||
      typeof value.projectKey !== "string" || value.projectKey.length > 1024) historyCorrupt();
  const { projectKey: _projectKey, userId: _userId, ...publicFields } = value;
  const job = normalizePublicJob(publicFields);
  if (job.status === "queued" || job.status === "running") {
    job.status = "error";
    job.error ??= "プロセス再起動により中断されました";
    job.updatedAt = new Date().toISOString();
    job.finishedAt = job.updatedAt;
  }
  return job;
}

function normalizeLegacyInboxItem(value: unknown, projectKey: string): InboxItem {
  if (!isRecord(value) || !hasOnlyKeys(value, INBOX_FIELDS) || value.kind !== "job-complete" ||
      (value.status !== "done" && value.status !== "error") || typeof value.read !== "boolean" ||
      (value.userId !== null && (typeof value.userId !== "string" || value.userId.length > 512)) ||
      typeof value.projectKey !== "string" || value.projectKey.length > 1024) historyCorrupt();
  return {
    id: boundedText(value.id, 1, 128, /^[A-Za-z0-9_-]+$/u, "legacy inbox ID"),
    kind: "job-complete",
    jobId: boundedText(value.jobId, 1, 128, /^[A-Za-z0-9_-]+$/u, "legacy inbox job ID"),
    jobType: boundedText(value.jobType, 1, 160, /^[A-Za-z0-9._:-]+$/u, "legacy inbox job type"),
    title: boundedString(value.title, 1, 4_096, "legacy inbox title"),
    body: boundedString(value.body, 0, 16_384, "legacy inbox body"),
    status: value.status,
    read: value.read,
    userId: "owner",
    projectKey,
    createdAt: timestamp(value.createdAt, "legacy inbox createdAt"),
  };
}

function publicJob(event: ReturnType<typeof normalizeLifecycle>): PublicJob {
  const status: PublicJobStatus = event.state === "succeeded" ? "done" : event.state === "failed" || event.state === "cancelled" ? "error" : event.state;
  const terminal = isTerminal(event.state);
  return {
    id: event.jobId,
    type: `${event.module}.${event.task}`,
    status,
    progress: null,
    result: null,
    error: status === "error" ? event.errorCode ?? (event.state === "cancelled" ? "job_cancelled" : "job_failed") : null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    finishedAt: terminal ? event.finishedAt ?? event.updatedAt : null,
  };
}

function jobEvent(job: PublicJob): JobEvent {
  return {
    type: "job-status", jobId: job.id, jobType: job.type, status: job.status, progress: null,
    ...(job.error ? { error: job.error } : {}), at: job.updatedAt,
  };
}

function addInboxItem(state: PersistedState, job: PublicJob, ownerKey: string, projectKey: string): void {
  if (job.status !== "done" && job.status !== "error") return;
  state.inbox = state.inbox.filter((item) => item.read || item.jobType !== job.type || item.projectKey !== projectKey);
  const createdAt = job.finishedAt ?? job.updatedAt;
  const id = `job-${hash(`${ownerKey}\0${projectKey}\0${job.id}`).slice(0, 40)}`;
  const failure = job.status === "error";
  state.inbox.unshift({
    id, kind: "job-complete", jobId: job.id, jobType: job.type,
    title: `${job.type} ${failure ? "failed" : "completed"}`,
    body: failure ? `The job failed (${job.error ?? "job_failed"}).` : "The job completed.",
    status: job.status, read: false, userId: "owner", projectKey, createdAt,
  });
  if (state.inbox.length > MAX_RETAINED_INBOX) state.inbox.length = MAX_RETAINED_INBOX;
}

function pruneJobs(jobs: StoredJob[]): void {
  const overflow = jobs.length - MAX_RETAINED_JOBS;
  if (overflow <= 0) return;
  const finished = jobs.filter(({ job }) => job.status === "done" || job.status === "error")
    .sort((left, right) => (left.job.finishedAt ?? "").localeCompare(right.job.finishedAt ?? ""));
  const remove = new Set(finished.slice(0, overflow).map(({ job }) => job.id));
  for (let index = jobs.length - 1; index >= 0; index--) if (remove.has(jobs[index]!.job.id)) jobs.splice(index, 1);
}

function normalizeState(value: unknown): PersistedState {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["version", "jobs", "inbox", "legacySources"])) ||
      (value.version !== 1 && value.version !== 2) || !Array.isArray(value.jobs) || !Array.isArray(value.inbox) ||
      value.jobs.length > MAX_RETAINED_JOBS || value.inbox.length > MAX_RETAINED_INBOX ||
      (value.version === 2 && !Array.isArray(value.legacySources))) historyCorrupt();
  const jobs: StoredJob[] = value.jobs.map((entry) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, new Set(["ownerKey", "projectKey", "job"])) ||
        typeof entry.ownerKey !== "string" || !/^[a-f0-9]{64}$/u.test(entry.ownerKey) ||
        typeof entry.projectKey !== "string" || !/^[a-f0-9]{64}$/u.test(entry.projectKey) || !isRecord(entry.job) ||
        !hasOnlyKeys(entry.job, PUBLIC_JOB_FIELDS)) historyCorrupt();
    const job = normalizePublicJob(entry.job);
    return { ownerKey: entry.ownerKey, projectKey: entry.projectKey, job };
  });
  const ids = new Set<string>();
  for (const record of jobs) {
    if (ids.has(record.job.id)) historyCorrupt();
    ids.add(record.job.id);
  }
  const inbox = value.inbox.map((entry) => normalizeInboxItem(entry));
  if (new Set(inbox.map(({ id }) => id)).size !== inbox.length) historyCorrupt();
  const legacySourcesRaw: unknown[] = value.version === 2 && Array.isArray(value.legacySources) ? value.legacySources : [];
  const legacySources = value.version === 2 ? legacySourcesRaw.map((source) => {
    if (typeof source !== "string" || !/^[a-f0-9]{64}$/u.test(source)) historyCorrupt();
    return source;
  }) : [];
  if (new Set(legacySources).size !== legacySources.length) historyCorrupt();
  return { version: 2, jobs, inbox, legacySources };
}

function normalizePublicJob(value: Record<string, unknown>): PublicJob {
  if (typeof value.status !== "string" || !JOB_STATUSES.has(value.status) ||
      (value.progress !== null && (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1)) ||
      (value.error !== null && (typeof value.error !== "string" || value.error.length > 16_384))) historyCorrupt();
  const status = value.status as PublicJobStatus;
  if ((status === "done" || status === "error") !== (value.finishedAt !== null)) historyCorrupt();
  return {
    id: boundedText(value.id, 1, 128, /^[A-Za-z0-9_-]+$/u, "job ID"),
    type: boundedText(value.type, 1, 160, /^[A-Za-z0-9._:-]+$/u, "job type"),
    status,
    progress: value.progress as number | null,
    result: boundedJson(value.result),
    error: value.error as string | null,
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
    finishedAt: value.finishedAt === null ? null : timestamp(value.finishedAt, "finishedAt"),
  };
}

function normalizeInboxItem(value: unknown): InboxItem {
  if (!isRecord(value) || !hasOnlyKeys(value, INBOX_FIELDS) || value.kind !== "job-complete" ||
      (value.status !== "done" && value.status !== "error") || typeof value.read !== "boolean" ||
      (value.userId !== null && value.userId !== "owner") || typeof value.projectKey !== "string" || !/^[a-f0-9]{64}$/u.test(value.projectKey)) historyCorrupt();
  const status = value.status;
  const jobType = boundedText(value.jobType, 1, 160, /^[A-Za-z0-9._:-]+$/u, "job type");
  return {
    id: boundedText(value.id, 1, 64, /^[A-Za-z0-9_-]+$/u, "inbox ID"),
    kind: "job-complete",
    jobId: boundedText(value.jobId, 1, 128, /^[A-Za-z0-9_-]+$/u, "job ID"),
    jobType,
    title: boundedText(value.title, 1, 4_096, /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/u, "inbox title"),
    body: boundedText(value.body, 0, 16_384, /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/u, "inbox body"),
    status,
    read: value.read,
    userId: value.userId as string | null,
    projectKey: value.projectKey,
    createdAt: timestamp(value.createdAt, "inbox createdAt"),
  };
}

function cloneState(state: PersistedState): PersistedState {
  return {
    version: 2, jobs: state.jobs.map((entry) => ({ ...entry, job: { ...entry.job } })),
    inbox: state.inbox.map((item) => ({ ...item })), legacySources: state.legacySources.slice(),
  };
}

function clonePublicJob(job: PublicJob): PublicJob {
  return normalizePublicJob(job as unknown as Record<string, unknown>);
}

function newestFirst(left: PublicJob, right: PublicJob): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function isFinalStatus(status: PublicJobStatus): boolean {
  return status === "done" || status === "error";
}

function canAdvance(current: PublicJobStatus, next: PublicJobStatus): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "running" || next === "done" || next === "error";
  if (current === "running") return next === "done" || next === "error";
  return false;
}

function orphanRunningJobs(state: PersistedState): boolean {
  const now = new Date().toISOString();
  let changed = false;
  for (const record of state.jobs) {
    if (record.job.status !== "queued" && record.job.status !== "running") continue;
    record.job.status = "error";
    record.job.error = "worker_interrupted";
    record.job.updatedAt = now;
    record.job.finishedAt = now;
    changed = true;
  }
  return changed;
}

function isTerminal(state: WorkerJobLifecycle["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new JobHistoryError("job_event_invalid", `Job ${field} timestamp is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new JobHistoryError("job_event_invalid", `Job ${field} timestamp is invalid`);
  return parsed.toISOString();
}

function boundedText(value: unknown, min: number, max: number, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !pattern.test(value)) {
    throw new JobHistoryError("job_event_invalid", `Job ${field} is invalid`);
  }
  return value;
}

function boundedString(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new JobHistoryError("legacy_job_invalid", `Legacy ${field} is invalid`);
  }
  return value;
}

function boundedJson(value: unknown): unknown {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { historyCorrupt(); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) historyCorrupt();
  try { return JSON.parse(encoded) as unknown; }
  catch { historyCorrupt(); }
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  return isRecord(value) && (value.provider === "github" || value.provider === "local") &&
    typeof value.repositoryId === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value.repositoryId) &&
    typeof value.ownerScope === "string" && /^[^\x00-\x1f\x7f]{1,256}$/u.test(value.ownerScope) &&
    typeof value.defaultBranch === "string" && value.defaultBranch.length > 0 && value.defaultBranch.length <= 256 &&
    typeof value.url === "string" && value.url.length > 0 && value.url.length <= 512;
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function repositoryKey(repository: Pick<RepositoryIdentity, "provider" | "ownerScope" | "repositoryId">): string {
  return hash(`${repository.provider}\0${repository.ownerScope}\0${repository.repositoryId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.has(key));
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function hashBytes(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function isWithin(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !/^[A-Za-z]:/u.test(path));
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0) {
      throw new JobHistoryError("legacy_jobs_file_invalid", "Job history file must be a private, bounded regular file");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof JobHistoryError) throw error;
    throw new JobHistoryError("legacy_jobs_file_unavailable", "Job history file cannot be read safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function archiveImmutable(targetPath: string, directory: string, bytes: Buffer): Promise<void> {
  const temporary = join(directory, `.legacy-${randomBytes(16).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, targetPath);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const retained = await readPrivateFile(targetPath, MAX_LEGACY_ARCHIVE_BYTES);
      if (!retained.equals(bytes)) throw new JobHistoryError("legacy_jobs_archive_conflict", "Immutable job archive identity already contains different bytes");
    }
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function historyCorrupt(): never {
  throw new JobHistoryError("job_history_corrupt", "Host job history contains invalid metadata");
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new JobHistoryError("job_history_path_invalid", "Host job history must use real directories");
  if ((info.mode & 0o077) !== 0) throw new JobHistoryError("job_history_path_permissions", "Host job history directories must be private");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
