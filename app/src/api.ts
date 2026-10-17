import type {
  ActionResult,
  Approval,
  ChangeOperation,
  ChangeProposal,
  CheckpointReceipt,
  ModuleStatus,
  PublishReceipt,
  ProposalStatus,
  RemoteObservation,
  RepositoryIdentity,
  ReconcileResult,
  SnapshotId,
  UiContribution,
} from "@scriptorium/contracts";

export interface Project {
  id: string;
  url: string;
  branch: string;
}

export type JobStatus = "queued" | "running" | "done" | "error";

export interface PublicJob {
  id: string;
  type: string;
  status: JobStatus;
  /** Progress is a source-compatible 0–1 hint; null means unavailable. */
  progress: number | null;
  result: unknown | null;
  error: string | null;
  errorCode?: string;
  retryable?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type JobEvent = {
  type: "job-status" | "job-progress";
  jobId: string;
  jobType: string;
  status: JobStatus;
  progress: number | null;
  error?: string;
  at: string;
};

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

export interface InboxListResponse {
  items: InboxItem[];
  unreadCount: number;
}

export interface ProjectDetails {
  project: Project;
  observation: RemoteObservation;
}

export interface Tree {
  title: string;
  volumes: Array<{
    id: string;
    title: string;
    chapters: Array<{
      id: string;
      title: string;
      scenes: Array<{ id: string; title: string }>;
    }>;
  }>;
}

export interface Scene {
  id: string;
  title: string;
  text: string;
  /** Legacy combined YAML + manuscript revision. File preconditions use SceneRead.document.revision. */
  revision: string;
}

export interface FileDocument {
  path: string;
  content: string;
  /** null distinguishes an absent file from an existing empty file. */
  revision: string | null;
}

export interface SceneRead {
  snapshot: SnapshotId;
  scene: Scene;
  /** Full manuscript bytes decoded as UTF-8, including Markdown frontmatter. */
  document: FileDocument;
  /** Exact scene YAML, used only when the manuscript link needs to be added. */
  metadata: FileDocument;
}

export interface TreeRead {
  snapshot: SnapshotId;
  tree: Tree;
}

export interface SnapshotRead {
  snapshot: SnapshotId;
  files: FileDocument[];
}

export interface Commit {
  hash: string;
  date: string;
  message: string;
}

export interface ManuscriptSnapshotMeta {
  id: string;
  sceneId: string;
  manuscriptId: string;
  createdAt: number;
  charCount: number;
  source: "git";
  branch?: string;
  label?: string;
  trigger?: "manual" | "submit" | "idle";
}

export interface ManuscriptSnapshot {
  id: string;
  sceneId: string;
  manuscriptId: string;
  createdAt: number;
  charCount: number;
  source: "git";
  branch?: string;
  label?: string;
  trigger?: "manual" | "submit" | "idle";
  body: string;
  document: FileDocument;
}

export interface ManuscriptSnapshotList {
  snapshot: SnapshotId;
  snapshots: ManuscriptSnapshotMeta[];
}

export interface ManuscriptSnapshotRead {
  snapshot: SnapshotId;
  manuscript: ManuscriptSnapshot;
}

export interface SyncStatus {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface Session {
  authenticated: true;
  authorScope: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new ApiError(
      typeof details.error === "string" ? details.error : `Request failed (${response.status})`,
      response.status,
      typeof details.code === "string" ? details.code : "REQUEST_FAILED",
    );
  }
  return body as T;
}

async function requestEventStream(path: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(path, {
    headers: { Accept: "text/event-stream" },
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const details = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new ApiError(
      typeof details.error === "string" ? details.error : `Request failed (${response.status})`,
      response.status,
      typeof details.code === "string" ? details.code : "REQUEST_FAILED",
    );
  }
  if (!response.body) throw new ApiError("Job event stream is unavailable", response.status, "STREAM_UNAVAILABLE");
  return response;
}

function projectPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/${suffix}`;
}

function pinnedQuery(view: "remote" | "checkpoint", pinned?: SnapshotId): string {
  const query = new URLSearchParams({ view });
  if (pinned) query.set("snapshot", pinned.remoteCommit);
  return `?${query.toString()}`;
}

/** The browser talks only to the public HTTP adapter and the shared contracts. */
export const api = {
  login: (token: string) => request<{ authenticated: true }>("/api/login", { method: "POST", body: JSON.stringify({ token }) }),
  session: () => request<Session>("/api/session"),
  logout: () => request<{ authenticated: false }>("/api/logout", { method: "POST", body: "{}" }),
  jobs: (signal?: AbortSignal) => request<PublicJob[]>("/api/jobs", { signal }),
  job: (jobId: string, signal?: AbortSignal) =>
    request<PublicJob>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal }),
  inbox: (unreadOnly = false, signal?: AbortSignal) => {
    const query = unreadOnly ? "?unread=1" : "";
    return request<InboxListResponse>(`/api/inbox${query}`, { signal });
  },
  markInboxRead: async (id: string, signal?: AbortSignal) => {
    const response = await request<{ item: InboxItem }>(`/api/inbox/${encodeURIComponent(id)}/read`, {
      method: "POST",
      signal,
    });
    return response.item;
  },
  markAllInboxRead: (signal?: AbortSignal) =>
    request<{ marked: number }>("/api/inbox/read-all", { method: "POST", signal }),
  jobEventStream: (signal: AbortSignal) => requestEventStream("/api/jobs/events", signal),
  projects: () => request<Project[]>("/api/projects"),
  projectDetails: (projectId: string) => request<ProjectDetails>(`/api/projects/${encodeURIComponent(projectId)}`),
  registerProject: (url: string, branch?: string) => request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ url, ...(branch ? { branch } : {}) }),
  }),
  reconstructProject: (projectId: string) => request<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PUT",
  }),
  detachProject: (projectId: string) => request<void>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  }),
  tree: (projectId: string) => request<Tree>(projectPath(projectId, "tree")),
  readTree: (projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId) =>
    request<TreeRead>(projectPath(projectId, `tree${pinnedQuery(view, pinned)}`)),
  scene: (projectId: string, sceneId: string) => request<Scene>(projectPath(projectId, `scenes/${encodeURIComponent(sceneId)}`)),
  readScene: (projectId: string, sceneId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId) =>
    request<SceneRead>(projectPath(projectId, `scenes/${encodeURIComponent(sceneId)}${pinnedQuery(view, pinned)}`)),
  snapshot: (projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId) =>
    request<SnapshotRead>(projectPath(projectId, `snapshot${pinnedQuery(view, pinned)}`)),
  history: (projectId: string) => request<Commit[]>(projectPath(projectId, "history")),
  manuscriptSnapshots: (projectId: string, manuscriptId: string, sceneId: string, pinned: SnapshotId) => {
    const query = new URLSearchParams({ sceneId, view: "remote", snapshot: pinned.remoteCommit });
    return request<ManuscriptSnapshotList>(projectPath(projectId,
      `manuscripts/${encodeURIComponent(manuscriptId)}/snapshots?${query.toString()}`));
  },
  manuscriptSnapshot: (projectId: string, manuscriptId: string, snapshotId: string, pinned: SnapshotId) => {
    const query = new URLSearchParams({ view: "remote", snapshot: pinned.remoteCommit });
    return request<ManuscriptSnapshotRead>(projectPath(projectId,
      `manuscripts/${encodeURIComponent(manuscriptId)}/snapshots/${encodeURIComponent(snapshotId)}?${query.toString()}`));
  },
  status: (projectId: string) => request<SyncStatus>(projectPath(projectId, "status")),
  observation: (projectId: string) => request<RemoteObservation>(projectPath(projectId, "observation")),
  proposalStatuses: (projectId: string) => request<{ proposals: ProposalStatus[] }>(projectPath(projectId, "proposals")),
  propose: (projectId: string, proposal: ChangeProposal) => request<ChangeProposal>(projectPath(projectId, "proposals"), {
    method: "POST",
    body: JSON.stringify(proposal),
  }),
  approve: (projectId: string, approval: Approval) => request<void>(projectPath(projectId, "approvals"), {
    method: "POST",
    body: JSON.stringify(approval),
  }),
  checkpoint: (projectId: string, operation: ChangeOperation) => request<CheckpointReceipt>(projectPath(projectId, "checkpoints"), {
    method: "POST",
    body: JSON.stringify(operation),
  }),
  reconcile: (projectId: string) => request<ReconcileResult>(projectPath(projectId, "reconcile"), {
    method: "POST",
    body: "{}",
  }),
  publish: (projectId: string, batchId: string) => request<PublishReceipt>(projectPath(projectId, "publish"), {
    method: "POST",
    body: JSON.stringify({ batchId }),
  }),
  modules: (projectId: string) => request<ModuleStatus[]>(projectPath(projectId, "modules")),
  contributions: (projectId: string) => request<UiContribution[]>(projectPath(projectId, "contributions")),
  action: (projectId: string, actionId: string, input: unknown, signal?: AbortSignal) => request<ActionResult>(
    projectPath(projectId, `actions/${encodeURIComponent(actionId)}`),
    { method: "POST", body: JSON.stringify({ input }), signal },
  ),
};

export type { RepositoryIdentity };
