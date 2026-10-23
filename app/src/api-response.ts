import { assertChangeOperation, type ActionResult, type ChangeProposal, type CheckpointReceipt, type ModuleStatus, type PublishReceipt, type ProposalStatus, type RecentActivityResponse, type ReconcileResult, type RemoteObservation, type RepositoryIdentity, type SnapshotId, type UiContribution } from "@scriptorium/contracts";
import type { Commit, FileDocument, InboxItem, InboxListResponse, ManuscriptSnapshot, ManuscriptSnapshotList, ManuscriptSnapshotMeta, ManuscriptSnapshotRead, Project, ProjectDetails, PublicJob, RuntimeVersion, Scene, SceneRead, Session, SnapshotRead, SyncStatus, Tree, TreeRead } from "./api";
import { ApiError } from "./api-error";

export type ResponseGuard<T> = (value: unknown) => value is T;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullableText = (v: unknown): v is string | null => v === null || text(v);
const nullableInteger = (v: unknown): v is number | null => v === null || integer(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const oneOf = (v: unknown, values: readonly string[]): boolean => text(v) && values.includes(v);
const optional = <T>(v: unknown, guard: ResponseGuard<T>): v is T | undefined => v === undefined || guard(v);
const array = <T>(guard: ResponseGuard<T>): ResponseGuard<T[]> => (v): v is T[] => Array.isArray(v) && v.every(guard);
const modules = ["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp", "search"] as const;

const repository: ResponseGuard<RepositoryIdentity> = (v): v is RepositoryIdentity => record(v) && oneOf(v.provider, ["github", "local"]) && [v.repositoryId, v.defaultBranch, v.ownerScope, v.url].every(text);
const snapshot: ResponseGuard<SnapshotId> = (v): v is SnapshotId => record(v) && repository(v.repository) && text(v.remoteCommit) && optional(v.overlayCommit, text);
const fileRevision = (v: unknown): boolean => record(v) && text(v.path) && nullableText(v.revision);
const checkpoint: ResponseGuard<CheckpointReceipt> = (v): v is CheckpointReceipt => record(v) && text(v.operationId) && integer(v.generation) && text(v.localCommit) && text(v.remoteBase) && Array.isArray(v.revisions) && v.revisions.every(fileRevision);
const proposal: ResponseGuard<ChangeProposal> = (v): v is ChangeProposal => {
  if (!record(v) || !text(v.id) || !snapshot(v.snapshot) || !oneOf(v.source, ["author", "module", "mcp"]) || !Array.isArray(v.operations)) return false;
  try { for (const operation of v.operations) assertChangeOperation(operation); } catch { return false; }
  return v.evidence === undefined || (Array.isArray(v.evidence) && v.evidence.every(e => record(e) && text(e.id) && snapshot(e.snapshot) && oneOf(e.module, modules) && text(e.kind) && Array.isArray(e.paths) && e.paths.every(fileRevision)));
};
const proposalStatus: ResponseGuard<ProposalStatus> = (v): v is ProposalStatus => record(v) && proposal(v.proposal) && oneOf(v.state, ["proposed", "partially_approved", "approved", "checkpointed"]) && strings(v.approvedOperationIds) && array(checkpoint)(v.checkpoints) && strings(v.publishedOperationIds) && bool(v.stale) && optional(v.payloadComplete, bool) && optional(v.originalDigest, text) && optional(v.operationIds, strings);
const project: ResponseGuard<Project> = (v): v is Project => record(v) && [v.id, v.url, v.branch].every(text);
const scene: ResponseGuard<Scene> = (v): v is Scene => record(v) && [v.id, v.title, v.text, v.revision].every(text);
const document: ResponseGuard<FileDocument> = (v): v is FileDocument => record(v) && text(v.path) && text(v.content) && nullableText(v.revision);
const tree: ResponseGuard<Tree> = (v): v is Tree => record(v) && text(v.title) && Array.isArray(v.volumes) && v.volumes.every(volume => record(volume) && text(volume.id) && text(volume.title) && Array.isArray(volume.chapters) && volume.chapters.every(chapter => record(chapter) && text(chapter.id) && text(chapter.title) && Array.isArray(chapter.scenes) && chapter.scenes.every(item => record(item) && text(item.id) && text(item.title))));
const sceneRead: ResponseGuard<SceneRead> = (v): v is SceneRead => record(v) && snapshot(v.snapshot) && scene(v.scene) && document(v.document) && document(v.metadata);
const observation: ResponseGuard<RemoteObservation> = (v): v is RemoteObservation => record(v) && snapshot(v.snapshot) && text(v.checkpointHead) && text(v.observedAt) && oneOf(v.state, ["fresh", "failed", "unknown"]) && array(checkpoint)(v.pending);
const manuscriptMeta: ResponseGuard<ManuscriptSnapshotMeta> = (v): v is ManuscriptSnapshotMeta => record(v) && [v.id, v.sceneId, v.manuscriptId].every(text) && integer(v.createdAt) && integer(v.charCount) && v.source === "git" && optional(v.branch, text) && optional(v.label, text) && (v.trigger === undefined || oneOf(v.trigger, ["manual", "submit", "idle"]));
const manuscript: ResponseGuard<ManuscriptSnapshot> = (v): v is ManuscriptSnapshot => manuscriptMeta(v) && record(v) && text(v.body) && document(v.document);
const job: ResponseGuard<PublicJob> = (v): v is PublicJob => record(v) && [v.id, v.type, v.createdAt, v.updatedAt].every(text) && oneOf(v.status, ["queued", "running", "done", "error"]) && (v.progress === null || (typeof v.progress === "number" && Number.isFinite(v.progress) && v.progress >= 0 && v.progress <= 1)) && nullableText(v.error) && nullableText(v.finishedAt) && optional(v.errorCode, text) && optional(v.retryable, bool);
const inbox: ResponseGuard<InboxItem> = (v): v is InboxItem => record(v) && [v.id, v.jobId, v.jobType, v.title, v.body, v.projectKey, v.createdAt].every(text) && v.kind === "job-complete" && oneOf(v.status, ["done", "error"]) && bool(v.read) && nullableText(v.userId);
const moduleStatus: ResponseGuard<ModuleStatus> = (v): v is ModuleStatus => record(v) && oneOf(v.id, modules) && oneOf(v.availability, ["not-included", "disabled", "enabled-idle", "active"]) && integer(v.activeJobs) && optional(v.version, text);
const contribution: ResponseGuard<UiContribution> = (v): v is UiContribution => record(v) && [v.id, v.title, v.action].every(text) && oneOf(v.module, modules) && oneOf(v.slot, ["editor", "dock", "inspection", "review", "settings"]) && (v.contractVersion === undefined || v.contractVersion === 1) && (v.kind === undefined || oneOf(v.kind, ["panel", "editor-adornment", "context-action"])) && (v.contexts === undefined || (Array.isArray(v.contexts) && v.contexts.every(c => oneOf(c, ["workspace", "editor", "reading"])))) && optional(v.multipleInstances, bool);

/** The guards follow the public DTOs; additive fields are retained, not silently stripped. */
export const responseContracts = {
  empty: (v: unknown): v is void => v === undefined,
  version: (v: unknown): v is RuntimeVersion => record(v) && [v.name, v.version, v.profile].every(text) && bool(v.hosted),
  loggedIn: (v: unknown): v is { authenticated: true } => record(v) && v.authenticated === true,
  loggedOut: (v: unknown): v is { authenticated: false } => record(v) && v.authenticated === false,
  session: (v: unknown): v is Session => record(v) && v.authenticated === true && text(v.authorScope) && (v.permissions === undefined || (Array.isArray(v.permissions) && v.permissions.every(p => oneOf(p, ["read", "write", "maintain", "admin"])))),
  project, projects: array(project),
  projectDetails: (v: unknown): v is ProjectDetails => record(v) && project(v.project) && observation(v.observation),
  projectEnvelope: (v: unknown): v is { project: Project } => record(v) && project(v.project),
  tree, treeRead: (v: unknown): v is TreeRead => record(v) && snapshot(v.snapshot) && tree(v.tree),
  scene, sceneRead,
  sceneViews: (v: unknown): v is { remote: SceneRead; effective: SceneRead } => record(v) && sceneRead(v.remote) && sceneRead(v.effective),
  snapshotRead: (v: unknown): v is SnapshotRead => record(v) && snapshot(v.snapshot) && array(document)(v.files),
  history: (v: unknown): v is Commit[] => Array.isArray(v) && v.every(c => record(c) && [c.hash, c.date, c.message].every(text)),
  manuscriptList: (v: unknown): v is ManuscriptSnapshotList => record(v) && snapshot(v.snapshot) && array(manuscriptMeta)(v.snapshots),
  manuscriptRead: (v: unknown): v is ManuscriptSnapshotRead => record(v) && snapshot(v.snapshot) && manuscript(v.manuscript),
  sync: (v: unknown): v is SyncStatus => record(v) && text(v.branch) && text(v.head) && integer(v.ahead) && integer(v.behind) && bool(v.dirty),
  observation,
  recentActivity: (v: unknown): v is RecentActivityResponse => record(v) && Array.isArray(v.items) && v.items.every(i => record(i) && text(i.sceneId) && nullableInteger(i.sentenceOffset) && optional(i.pageIndex, nullableInteger) && oneOf(i.deviceType, ["desktop", "mobile"]) && text(i.updatedAt)),
  proposal, checkpoint,
  proposals: (v: unknown): v is { proposals: ProposalStatus[] } => record(v) && array(proposalStatus)(v.proposals),
  reconcile: (v: unknown): v is ReconcileResult => record(v) && snapshot(v.snapshot) && Array.isArray(v.operations) && v.operations.every(o => record(o) && text(o.operationId) && oneOf(o.state, ["unchanged", "replayed", "conflict"]) && optional(o.receipt, checkpoint) && strings(o.paths)),
  publish: (v: unknown): v is PublishReceipt => record(v) && text(v.batchId) && oneOf(v.state, ["confirmed", "publication_unknown", "conflict"]) && text(v.remoteCommit) && array(checkpoint)(v.acknowledged),
  jobs: array(job), job,
  inbox: (v: unknown): v is InboxListResponse => record(v) && array(inbox)(v.items) && integer(v.unreadCount),
  inboxItem: (v: unknown): v is { item: InboxItem } => record(v) && inbox(v.item),
  marked: (v: unknown): v is { marked: number } => record(v) && integer(v.marked),
  modules: array(moduleStatus), contributions: array(contribution),
  action: (v: unknown): v is ActionResult => record(v) && snapshot(v.snapshot) && (v.ok === true ? optional(v.proposals, array(proposal)) : v.ok === false && record(v.error) && text(v.error.code) && text(v.error.message) && bool(v.error.retryable)),
};

export function decodeResponse<T>(value: unknown, guard: ResponseGuard<T>): T {
  if (!guard(value)) throw new ApiError("The server returned an invalid response", 502, "INVALID_RESPONSE");
  return value;
}

export async function readApiResponse<T>(response: Response, guard: ResponseGuard<T>): Promise<T> {
  if (response.status === 204) return decodeResponse(undefined, guard);
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (response.ok) throw new ApiError("The server returned invalid JSON", 502, "INVALID_RESPONSE");
  }
  if (!response.ok) {
    const details = record(body) ? body : {};
    throw new ApiError(text(details.error) ? details.error : `Request failed (${response.status})`, response.status, text(details.code) ? details.code : "REQUEST_FAILED");
  }
  return decodeResponse(body, guard);
}
