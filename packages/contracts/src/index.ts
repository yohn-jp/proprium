/** Public, transport-neutral campaign contract v1. No platform or domain dependencies. */
export const CONTRACT_VERSION = 1 as const;
export const MAX_JOB_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_PROPOSAL_EVIDENCE_BYTES = 1024 * 1024;
export type ModuleId = "story" | "diagnostics" | "nlp" | "semantic" | "speaker" | "assistant" | "publishing" | "mcp";
export interface RepositoryIdentity {
  provider: "github" | "local";
  repositoryId: string;
  defaultBranch: string;
  ownerScope: string;
  url: string;
}
export interface SnapshotId {
  repository: RepositoryIdentity;
  remoteCommit: string;
  overlayCommit?: string;
}
/** Optional host-owned historical records; never a project mutation or disposable model cache. */
export const MODEL_USAGE_CAPABILITY = "host.model-usage";
export interface ModelUsageEvent {
  id: string;
  repository: RepositoryIdentity;
  feature: string;
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string;
  state: "completed" | "aborted" | "failed";
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  cacheHit?: boolean;
  promptVersion?: string;
  durationMs?: number;
  queueWaitMs?: number;
  errorCode?: string;
}
export interface ModelUsageStore {
  append(event: ModelUsageEvent): Promise<void>;
  list(repository: RepositoryIdentity, query?: { from?: string; to?: string; limit?: number; cursor?: string }): Promise<{
    events: ModelUsageEvent[];
    nextCursor?: string;
  }>;
}
export interface FileRevision { path: string; revision: string | null }
/** Binds a directory membership and every listed file revision, including absent members. */
export interface ScopeRevision { prefix: string; revision: string }
/** Contents are full UTF-8 or base64; null is an explicit deletion. */
export interface FileChange extends FileRevision { content: string | null; encoding?: "utf8" | "base64" }
export type EffectClass = "manuscript" | "structure" | "metadata" | "settings" | "migration";
export interface ChangeOperation {
  id: string;
  generation: number;
  repository: RepositoryIdentity;
  baseRemoteCommit: string;
  effect: EffectClass;
  reads: FileRevision[];
  readScopes?: ScopeRevision[];
  writes: FileChange[];
  message: string;
  evidenceIds?: string[];
}
export interface CheckpointReceipt {
  operationId: string;
  generation: number;
  localCommit: string;
  remoteBase: string;
  revisions: FileRevision[];
}
export interface PublishReceipt {
  batchId: string;
  state: "confirmed" | "publication_unknown" | "conflict";
  remoteCommit: string;
  acknowledged: CheckpointReceipt[];
}
export interface RemoteObservation {
  snapshot: SnapshotId;
  checkpointHead: string;
  observedAt: string;
  state: "fresh" | "failed" | "unknown";
  pending: CheckpointReceipt[];
}
export interface SnapshotReader {
  snapshot: SnapshotId;
  read(path: string, encoding?: "utf8" | "base64"): Promise<{ content: string; revision: string } | null>;
  list(prefix: string): Promise<string[]>;
}
export interface ProposalEvidence {
  id: string;
  snapshot: SnapshotId;
  module: ModuleId;
  kind: string;
  paths: FileRevision[];
  /** Bounded module-owned JSON, never credentials or executable code. */
  details: unknown;
}
export interface ChangeProposal {
  id: string;
  snapshot: SnapshotId;
  operations: ChangeOperation[];
  source: "author" | "module" | "mcp";
  evidence?: ProposalEvidence[];
}
/** Author review state. Unaccepted payload remains in private/browser recovery. */
export interface ProposalStatus {
  proposal: ChangeProposal;
  /** False when Git recovery contains only accepted operations, without provisional evidence. */
  payloadComplete?: boolean;
  /** Digest binding of the original complete normalized proposal, including provisional data. */
  originalDigest?: string;
  /** Original proposal operation IDs in order, including privately retained operations. */
  operationIds?: string[];
  state: "proposed" | "partially_approved" | "approved" | "checkpointed";
  approvedOperationIds: string[];
  checkpoints: CheckpointReceipt[];
  /** Confirmed in the currently observed canonical remote history. */
  publishedOperationIds: string[];
  stale: boolean;
}
export interface Approval { proposalId: string; operationIds: string[]; authorScope: string }
/** Port shared by module and external callers: no author authority. */
export interface ProposalCoordinator {
  observe(projectId: string): Promise<RemoteObservation>;
  reader(projectId: string, view?: "remote" | "checkpoint"): Promise<SnapshotReader>;
  propose(projectId: string, proposal: ChangeProposal): Promise<ChangeProposal>;
}
export interface ReconcileResult {
  snapshot: SnapshotId;
  operations: Array<{ operationId: string; state: "unchanged" | "replayed" | "conflict"; receipt?: CheckpointReceipt; paths: string[] }>;
}
/** Host-only port. Authenticated author adapters must never expose it to modules/MCP.
 * Proposal source is assigned by the authenticated transport, not accepted from request JSON. */
export interface MutationCoordinator extends ProposalCoordinator {
  observe(projectId: string): Promise<RemoteObservation>;
  reader(projectId: string, view?: "remote" | "checkpoint"): Promise<SnapshotReader>;
  propose(projectId: string, proposal: ChangeProposal): Promise<ChangeProposal>;
  approve(projectId: string, approval: Approval): Promise<void>;
  checkpoint(projectId: string, operation: ChangeOperation): Promise<CheckpointReceipt>;
  reconcile(projectId: string): Promise<ReconcileResult>;
  publish(projectId: string, batchId: string): Promise<PublishReceipt>;
}
export interface JobRequest<T = unknown> {
  id: string;
  module: ModuleId;
  task: string;
  snapshot: SnapshotId;
  model: string;
  modelVersion: string;
  moduleVersion: string;
  deadline: number;
  input: T;
}
export interface JobResult<T = unknown> {
  id: string;
  snapshot: SnapshotId;
  model: string;
  modelVersion: string;
  moduleVersion: string;
  output: T;
}
export interface MachineError { code: string; message: string; retryable: boolean }
export type JobOutcome<T = unknown> = { ok: true; result: JobResult<T> } | { ok: false; id: string; snapshot: SnapshotId; error: MachineError };
export interface ValueSchema<T = unknown> { parse(value: unknown): T }
export type ActionResult<T = unknown> = { ok: true; snapshot: SnapshotId; data: T; proposals?: ChangeProposal[] } | { ok: false; snapshot: SnapshotId; error: MachineError };
/** Optional host-owned history for a source domain task; never grants author approval. */
export interface DomainJobDescriptor { type: string }
export interface ActionDescriptor { id: string; module: ModuleId | "core"; effect: "read" | "propose" | "compute"; job?: DomainJobDescriptor }
export interface ModuleActionContext {
  projectId: string;
  reader: SnapshotReader;
  /** Same authenticated project/snapshot; never exposes author mutation ports. */
  invoke(actionId: string, input: unknown, signal?: AbortSignal): Promise<ActionResult>;
  listActions(): Promise<ActionDescriptor[]>;
  /** Explicit read-only composition with another registered repository of this owner. */
  linkedReader(repositoryId: string): Promise<SnapshotReader>;
  signal: AbortSignal;
  /** Only proposes; approval remains an authenticated author action. */
  propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, signal?: AbortSignal): Promise<ChangeProposal>;
  runJob<T = unknown>(request: JobRequest, signal?: AbortSignal): Promise<JobOutcome<T>>;
}
export interface ModuleAction {
  id: string;
  effect: "read" | "propose" | "compute";
  /** Declared by the owning module; the host records the exact outer action result privately. */
  job?: DomainJobDescriptor;
  inputSchema: ValueSchema;
  outputSchema: ValueSchema;
  invoke(input: unknown, context: ModuleActionContext): Promise<ActionResult>;
}
export interface UiContribution {
  id: string;
  module: ModuleId;
  slot: "editor" | "dock" | "inspection" | "review" | "settings";
  title: string;
  action: string;
}
export interface ModuleManifest {
  id: ModuleId;
  version: string;
  contractVersion: number;
  dependencies: ModuleId[];
  provides: string[];
  requires: string[];
  /** Availability-gated source features do not force the optional provider into a profile. */
  optionalRequires?: string[];
  serverEntry?: string;
  browserEntry?: string;
  workerEntry?: string;
  statePaths: string[];
  locality: "local" | "optional-external";
}
export interface WorkerService {
  request<T = unknown>(request: JobRequest, signal: AbortSignal): Promise<JobOutcome<T>>;
  cancel(jobId: string): boolean;
  dispose(): Promise<void>;
}
export interface CapabilityDefinition<T = unknown> {
  id: string;
  version: string;
  /** Called only on first lease; registering a factory allocates no heavy resource. */
  create(context: ModuleContext): Promise<T>;
  dispose?(value: T): Promise<void>;
}
export interface ModuleContext {
  cacheDirectory: string;
  signal: AbortSignal;
  acquireCapability<T>(id: string): Promise<{ value: T; release(): Promise<void> }>;
  /** Resolves this installed module's declared worker, with bounded supervised IPC. */
  createWorkerService(): Promise<WorkerService>;
}
export interface HttpContribution {
  id: string;
  /** Relative path template under the host-owned project or stable-repository prefix. */
  path: string;
  methods: Array<"GET" | "HEAD" | "POST" | "DELETE">;
  access: "owner" | "public";
  effect: "read" | "propose";
  handle(request: Request, context: ModuleActionContext): Promise<Response>;
}
export interface ModuleDefinition {
  manifest: ModuleManifest;
  capabilities?: CapabilityDefinition[];
  http?: HttpContribution[];
  actions: ModuleAction[];
  ui: UiContribution[];
  dispose(): Promise<void>;
}
export type ModuleAvailability = "not-included" | "disabled" | "enabled-idle" | "active";
export interface ModuleStatus { id: ModuleId; availability: ModuleAvailability; version?: string; activeJobs: number }

export class ContractError extends Error {
  readonly code = "invalid_contract";
  constructor(message: string) { super(message); this.name = "ContractError"; }
}
export function assertProjectPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 1024 || /[\\\x00-\x1f]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ContractError("Unsafe project path");
  }
}
export function snapshotKey(snapshot: SnapshotId): string {
  return JSON.stringify([snapshot.repository.provider, snapshot.repository.ownerScope,
    snapshot.repository.repositoryId, snapshot.repository.defaultBranch, snapshot.remoteCommit, snapshot.overlayCommit ?? null]);
}
/** Content-neutral semantic read-set guard; callers choose the relevant project subtree. */
export async function snapshotScopeRevision(reader: SnapshotReader, prefix: string): Promise<string> {
  assertProjectPath(prefix);
  const paths = await reader.list(prefix);
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const path of paths) {
    assertProjectPath(path);
    if ((path !== prefix && !path.startsWith(`${prefix}/`)) || seen.has(path)) {
      throw new ContractError("Invalid snapshot scope listing");
    }
    seen.add(path);
    const file = await reader.read(path);
    if (!file || !/^[a-f0-9]{64}$/.test(file.revision)) throw new ContractError("Snapshot scope contains an unavailable file");
    entries.push([path, file.revision]);
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entries)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
/** Runtime boundary, also used for recovered browser payloads. Symlink checks remain Core-owned. */
export function assertChangeOperation(value: unknown): asserts value is ChangeOperation {
  const v = value as ChangeOperation | null;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.id) ||
      !Number.isSafeInteger(v.generation) || v.generation < 0 || typeof v.message !== "string" ||
      !v.message.trim() || v.message.length > 1024 || typeof v.baseRemoteCommit !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64}|)$/.test(v.baseRemoteCommit) ||
      !["manuscript", "structure", "metadata", "settings", "migration"].includes(v.effect) ||
      !v.repository || !["github", "local"].includes(v.repository.provider) ||
      [v.repository.repositoryId, v.repository.defaultBranch, v.repository.ownerScope, v.repository.url].some(x => typeof x !== "string" || !x) ||
      !Array.isArray(v.reads) || !Array.isArray(v.writes) || v.reads.length > 512 || !v.writes.length || v.writes.length > 256) {
    throw new ContractError("Invalid change operation");
  }
  if (v.readScopes !== undefined) {
    if (!Array.isArray(v.readScopes) || v.readScopes.length > 32) throw new ContractError("Invalid scope preconditions");
    const prefixes = new Set<string>();
    for (const scope of v.readScopes) {
      if (!scope || typeof scope !== "object") throw new ContractError("Invalid scope precondition");
      assertProjectPath(scope.prefix);
      if (prefixes.has(scope.prefix) || typeof scope.revision !== "string" || !/^[a-f0-9]{64}$/.test(scope.revision)) {
        throw new ContractError("Invalid scope revision");
      }
      prefixes.add(scope.prefix);
    }
  }
  const seen = new Set<string>();
  let size = 0;
  for (const item of [...v.reads, ...v.writes]) {
    if (!item || typeof item !== "object") throw new ContractError("Invalid file precondition");
    assertProjectPath(item.path);
    if (item.revision !== null && (typeof item.revision !== "string" || !/^[a-f0-9]{64}$/.test(item.revision))) {
      throw new ContractError("Invalid file revision");
    }
  }
  for (const item of v.writes) {
    if (seen.has(item.path)) throw new ContractError("Duplicate write path");
    seen.add(item.path);
    if (item.content !== null && typeof item.content !== "string") throw new ContractError("Invalid recoverable content");
    if (item.encoding !== undefined && item.encoding !== "utf8" && item.encoding !== "base64") throw new ContractError("Invalid encoding");
    size += item.content?.length ?? 0;
    if (size > 8 * 1024 * 1024) throw new ContractError("Operation payload exceeds limit");
  }
}

/** Browser modules mount real domain UI into shared slots without author approval authority. */
export interface BrowserModuleContext {
  projectId: string;
  snapshot: SnapshotId;
  signal: AbortSignal;
  invoke(actionId: string, input: unknown): Promise<ActionResult>;
  /** The shell journals the complete proposal before acknowledging it to the module UI. */
  propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string): Promise<ChangeProposal>;
  refresh(): Promise<void>;
}
export interface BrowserModuleDefinition {
  mount(contributionId: string, element: HTMLElement, context: BrowserModuleContext): Promise<() => void>;
  /** Public read-only source views receive no author or private-work capability. */
  mountPublic?(viewId: string, element: HTMLElement, request: Request): Promise<() => void>;
}
