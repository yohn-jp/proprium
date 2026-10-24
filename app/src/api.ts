import { ApiError } from "./api-error";
export { ApiError } from "./api-error";
import { responseContracts as dto, readApiResponse, decodeResponse, type ResponseGuard } from "./api-response";
import type {
  ActionResult,
  Approval,
  ChangeOperation,
  ChangeProposal,
  CheckpointReceipt,
  ModuleStatus,
  PublishReceipt,
  ProposalStatus,
  RecentActivityInput,
  RecentActivityResponse,
  RemoteObservation,
  RepositoryIdentity,
  ReconcileResult,
  SnapshotId,
  UiContribution,
} from "@scriptorium/contracts";

export class DocumentDepartureError extends DOMException {
  constructor() {
    super("The document is leaving.", "AbortError");
  }
}

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
  permissions?: Array<"read" | "write" | "maintain" | "admin">;
}

export interface RuntimeVersion {
  name: string;
  version: string;
  hosted: boolean;
  profile: string;
}

let hostedMode: boolean | undefined;
type HostedRefreshResult = { status: number; ok: boolean; error?: string; code?: string };
let hostedRefresh: Promise<HostedRefreshResult> | undefined;
let documentDeparting = false;
let documentLifecycle = 0;
let reauthRedirectedLifecycle: number | undefined;

function markDocumentDeparting(): void {
  if (documentDeparting) return;
  documentDeparting = true;
  documentLifecycle += 1;
}

function resumeDocument(): void {
  // pageshow also fires on the first load. Only a real departure invalidates
  // in-flight work and advances the lifecycle generation.
  if (!documentDeparting) return;
  documentDeparting = false;
  documentLifecycle += 1;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    // Wait until every beforeunload handler has had a chance to cancel the
    // departure before closing the browser API to new ordinary requests.
    queueMicrotask(() => {
      if (!event.defaultPrevented) markDocumentDeparting();
    });
  }, { capture: true });
  window.addEventListener("pagehide", markDocumentDeparting, { capture: true });
  window.addEventListener("pageshow", resumeDocument, { capture: true });
}

function assertDocumentCanStartRequest(init?: RequestInit): void {
  if (documentDeparting && init?.keepalive !== true) {
    throw new DocumentDepartureError();
  }
}

function hasLeftDocumentLifecycle(lifecycle: number): boolean {
  return documentDeparting || documentLifecycle !== lifecycle;
}

async function withDocumentDepartureClassification<T>(
  lifecycle: number,
  init: RequestInit,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    if (hasLeftDocumentLifecycle(lifecycle) && init.keepalive !== true) throw new DocumentDepartureError();
    return result;
  } catch (error) {
    if (hasLeftDocumentLifecycle(lifecycle) && init.keepalive !== true) throw new DocumentDepartureError();
    throw error;
  }
}

function returnOrAbortAfterDeparture(response: Response, lifecycle: number, init: RequestInit): Response {
  if (!hasLeftDocumentLifecycle(lifecycle)) return response;
  if (init.keepalive === true) return response;
  throw new DocumentDepartureError();
}

function csrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = "__Host-praetorium_csrf=";
  const item = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!item) return undefined;
  try { return decodeURIComponent(item.slice(prefix.length)); }
  catch { return undefined; }
}

function refreshHostedGrant(): Promise<HostedRefreshResult> {
  // The Gateway rotates the refresh secret atomically. Parallel API requests
  // must share one exchange so a losing refresh cannot trigger reauthentication.
  hostedRefresh ??= performHostedRefresh().finally(() => { hostedRefresh = undefined; });
  return hostedRefresh;
}

async function isHostedGrantRejection(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const body: unknown = await response.clone().json().catch(() => null);
  return body !== null && typeof body === "object" && (body as Record<string, unknown>).code === "UNAUTHORIZED";
}

async function performHostedRefresh(): Promise<HostedRefreshResult> {
  assertDocumentCanStartRequest();
  const headers = new Headers();
  const csrf = csrfToken();
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const response = await fetch("/_platform/refresh", { method: "POST", headers, credentials: "same-origin" });
  if (response.ok || response.status === 401) return { status: response.status, ok: response.ok };
  const body: unknown = await response.json().catch(() => null);
  const details = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    status: response.status,
    ok: false,
    error: typeof details.error === "string" ? details.error : `Session refresh failed (${response.status})`,
    code: typeof details.code === "string" ? details.code : "SESSION_REFRESH_FAILED",
  };
}

async function refreshHostedGrantForLifecycle(lifecycle: number): Promise<boolean> {
  let result: HostedRefreshResult;
  try {
    result = await refreshHostedGrant();
  } catch (error) {
    if (hasLeftDocumentLifecycle(lifecycle)) throw new DocumentDepartureError();
    throw error;
  }
  if (hasLeftDocumentLifecycle(lifecycle)) throw new DocumentDepartureError();
  if (result.status === 401) {
    if (reauthRedirectedLifecycle !== lifecycle) {
      reauthRedirectedLifecycle = lifecycle;
      window.location.assign("/_platform/reauth");
    }
    return false;
  }
  if (!result.ok) {
    throw new ApiError(result.error ?? `Session refresh failed (${result.status})`, result.status,
      result.code ?? "SESSION_REFRESH_FAILED");
  }
  return true;
}

async function fetchHostedRequest(path: string, init: RequestInit): Promise<Response> {
  assertDocumentCanStartRequest(init);
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const csrf = csrfToken();
  const method = (init.method ?? "GET").toUpperCase();
  if (csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-CSRF-Token", csrf);
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

async function fetchHostedResponseForLifecycle(path: string, init: RequestInit, lifecycle: number): Promise<Response> {
  const response = await fetchHostedRequest(path, init);
  // A response already in flight may settle while this document is leaving.
  // Do not start a refresh exchange or retry after the departure fence closes.
  if (hasLeftDocumentLifecycle(lifecycle)) return returnOrAbortAfterDeparture(response, lifecycle, init);
  if (hostedMode !== true || path.startsWith("/_platform/")) return response;
  const grantRejected = await isHostedGrantRejection(response);
  if (hasLeftDocumentLifecycle(lifecycle)) return returnOrAbortAfterDeparture(response, lifecycle, init);
  if (!grantRejected) return response;

  // Web Locks serialize refresh-cookie rotation across tabs. Once inside the
  // lock, retry the rejected request with the current cookies first: another
  // tab may already have refreshed while this request waited.
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks) {
    return locks.request("scriptorium-hosted-grant-refresh", async () => {
      if (hasLeftDocumentLifecycle(lifecycle)) return returnOrAbortAfterDeparture(response, lifecycle, init);
      const current = await fetchHostedRequest(path, init);
      if (hasLeftDocumentLifecycle(lifecycle)) return returnOrAbortAfterDeparture(current, lifecycle, init);
      if (!(await isHostedGrantRejection(current))) return current;
      if (hasLeftDocumentLifecycle(lifecycle)) return returnOrAbortAfterDeparture(current, lifecycle, init);
      const refreshed = await refreshHostedGrantForLifecycle(lifecycle);
      if (hasLeftDocumentLifecycle(lifecycle)) return returnOrAbortAfterDeparture(current, lifecycle, init);
      if (refreshed) {
        const retried = await fetchHostedRequest(path, init);
        return returnOrAbortAfterDeparture(retried, lifecycle, init);
      }
      return current;
    });
  }

  // Browsers without Web Locks retain same-tab single-flight refresh.
  const refreshed = await refreshHostedGrantForLifecycle(lifecycle);
  if (hasLeftDocumentLifecycle(lifecycle)) return returnOrAbortAfterDeparture(response, lifecycle, init);
  if (refreshed) {
    const retried = await fetchHostedRequest(path, init);
    return returnOrAbortAfterDeparture(retried, lifecycle, init);
  }
  return response;
}

async function fetchWithHostedRefresh(path: string, init: RequestInit): Promise<Response> {
  const lifecycle = documentLifecycle;
  return withDocumentDepartureClassification(lifecycle, init, () => fetchHostedResponseForLifecycle(path, init, lifecycle));
}

async function request<T>(guard: ResponseGuard<T>, path: string, init: RequestInit = {}): Promise<T> {
  const lifecycle = documentLifecycle;
  return withDocumentDepartureClassification(lifecycle, init, async () => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return readApiResponse(await fetchWithHostedRefresh(path, { ...init, headers }), guard);
  });
}

async function requestEventStream(path: string, signal: AbortSignal): Promise<Response> {
  const init = { headers: { Accept: "text/event-stream" }, signal };
  const lifecycle = documentLifecycle;
  return withDocumentDepartureClassification(lifecycle, init, async () => {
    const response = await fetchWithHostedRefresh(path, init);
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
  });
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
  version: async () => {
    const version = await request(dto.version, "/api/version");
    hostedMode = version.hosted;
    return version;
  },
  login: (token: string) => request(dto.loggedIn, "/api/login", { method: "POST", body: JSON.stringify({ token }) }),
  session: () => request(dto.session, "/api/session"),
  logout: async () => {
    const lifecycle = documentLifecycle;
    const init = { method: "POST" };
    return withDocumentDepartureClassification(lifecycle, init, async () => {
      if (hostedMode === true) {
        const response = await fetchWithHostedRefresh("/_platform/logout", init);
        if (response.status === 204) return { authenticated: false as const };
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const details = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
          throw new ApiError(typeof details.error === "string" ? details.error : `Logout failed (${response.status})`, response.status,
            typeof details.code === "string" ? details.code : "LOGOUT_FAILED");
        }
        return decodeResponse(body, dto.loggedOut);
      }
      return request(dto.loggedOut, "/api/logout", { method: "POST", body: "{}" });
    });
  },
  jobs: (signal?: AbortSignal) => request(dto.jobs, "/api/jobs", { ...(signal ? { signal } : {}) }),
  job: (jobId: string, signal?: AbortSignal) =>
    request(dto.job, `/api/jobs/${encodeURIComponent(jobId)}`, { ...(signal ? { signal } : {}) }),
  inbox: (unreadOnly = false, signal?: AbortSignal) => {
    const query = unreadOnly ? "?unread=1" : "";
    return request(dto.inbox, `/api/inbox${query}`, { ...(signal ? { signal } : {}) });
  },
  markInboxRead: async (id: string, signal?: AbortSignal) => {
    const response = await request(dto.inboxItem, `/api/inbox/${encodeURIComponent(id)}/read`, {
      method: "POST",
      ...(signal ? { signal } : {}),
    });
    return response.item;
  },
  markAllInboxRead: (signal?: AbortSignal) =>
    request(dto.marked, "/api/inbox/read-all", { method: "POST", ...(signal ? { signal } : {}) }),
  jobEventStream: (signal: AbortSignal) => requestEventStream("/api/jobs/events", signal),
  projects: () => request(dto.projects, "/api/projects"),
  projectDetails: (projectId: string) => request(dto.projectDetails, `/api/projects/${encodeURIComponent(projectId)}`),
  registerProject: (url: string, branch?: string) => request(dto.project, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ url, ...(branch ? { branch } : {}) }),
  }),
  reconstructProject: (projectId: string) => request(dto.projectEnvelope, `/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PUT",
  }),
  detachProject: (projectId: string) => request(dto.empty, `/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  }),
  tree: (projectId: string) => request(dto.tree, projectPath(projectId, "tree")),
  readTree: (projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId) =>
    request(dto.treeRead, projectPath(projectId, `tree${pinnedQuery(view, pinned)}`)),
  scene: (projectId: string, sceneId: string) => request(dto.scene, projectPath(projectId, `scenes/${encodeURIComponent(sceneId)}`)),
  readScene: (projectId: string, sceneId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId) =>
    request(dto.sceneRead, projectPath(projectId, `scenes/${encodeURIComponent(sceneId)}${pinnedQuery(view, pinned)}`)),
  readSceneViews: (projectId: string, sceneId: string, pinned: SnapshotId) =>
    request(dto.sceneViews, projectPath(projectId,
      `scenes/${encodeURIComponent(sceneId)}/views?snapshot=${encodeURIComponent(pinned.remoteCommit)}`)),
  snapshot: (projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId) =>
    request(dto.snapshotRead, projectPath(projectId, `snapshot${pinnedQuery(view, pinned)}`)),
  history: (projectId: string) => request(dto.history, projectPath(projectId, "history")),
  manuscriptSnapshots: (projectId: string, manuscriptId: string, sceneId: string, pinned: SnapshotId) => {
    const query = new URLSearchParams({ sceneId, view: "remote", snapshot: pinned.remoteCommit });
    return request(dto.manuscriptList, projectPath(projectId,
      `manuscripts/${encodeURIComponent(manuscriptId)}/snapshots?${query.toString()}`));
  },
  manuscriptSnapshot: (projectId: string, manuscriptId: string, snapshotId: string, pinned: SnapshotId) => {
    const query = new URLSearchParams({ view: "remote", snapshot: pinned.remoteCommit });
    return request(dto.manuscriptRead, projectPath(projectId,
      `manuscripts/${encodeURIComponent(manuscriptId)}/snapshots/${encodeURIComponent(snapshotId)}?${query.toString()}`));
  },
  status: (projectId: string) => request(dto.sync, projectPath(projectId, "status")),
  observation: (projectId: string) => request(dto.observation, projectPath(projectId, "observation")),
  recentActivity: (projectId: string, signal?: AbortSignal) =>
    request(dto.recentActivity, projectPath(projectId, "recent-activity"), { ...(signal ? { signal } : {}) }),
  putRecentActivity: (projectId: string, input: RecentActivityInput, options: { signal?: AbortSignal; keepalive?: boolean } = {}) =>
    request(dto.recentActivity, projectPath(projectId, "recent-activity"), {
      method: "PUT",
      body: JSON.stringify(input),
      ...options,
    }),
  proposalStatuses: (projectId: string) => request(dto.proposals, projectPath(projectId, "proposals")),
  propose: (projectId: string, proposal: ChangeProposal, signal?: AbortSignal) => request(dto.proposal, projectPath(projectId, "proposals"), {
    method: "POST",
    body: JSON.stringify(proposal),
    ...(signal ? { ...(signal ? { signal } : {}) } : {}),
  }),
  approve: (projectId: string, approval: Approval, signal?: AbortSignal) => request(dto.empty, projectPath(projectId, "approvals"), {
    method: "POST",
    body: JSON.stringify(approval),
    ...(signal ? { signal } : {}),
  }),
  checkpoint: (projectId: string, operation: ChangeOperation, signal?: AbortSignal) => request(dto.checkpoint, projectPath(projectId, "checkpoints"), {
    method: "POST",
    body: JSON.stringify(operation),
    ...(signal ? { signal } : {}),
  }),
  reconcile: (projectId: string, signal?: AbortSignal) => request(dto.reconcile, projectPath(projectId, "reconcile"), {
    ...(signal ? { signal } : {}),
    method: "POST",
    body: "{}",
  }),
  publish: (projectId: string, batchId: string) => request(dto.publish, projectPath(projectId, "publish"), {
    method: "POST",
    body: JSON.stringify({ batchId }),
  }),
  modules: (projectId: string) => request(dto.modules, projectPath(projectId, "modules")),
  contributions: (projectId: string) => request(dto.contributions, projectPath(projectId, "contributions")),
  action: (projectId: string, actionId: string, input: unknown, signal?: AbortSignal, snapshot?: SnapshotId) => request(dto.action,
    projectPath(projectId, `actions/${encodeURIComponent(actionId)}`),
    { method: "POST", body: JSON.stringify({ input, ...(snapshot ? { snapshot } : {}) }), ...(signal ? { signal } : {}) },
  ),
};

export type { RepositoryIdentity };
