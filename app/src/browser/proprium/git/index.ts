import type {
  CommitAuthor,
  CommitReview,
  CommitReviewSnapshot,
  CommitDiff,
  CommitFileChange,
  CommitSummary,
  FileRevision,
  FileRevisionExpectation,
  WorkspaceChange,
  AppliedWorkspaceChange,
  LocalGitError,
  LocalGitErrorCode,
  LocalGitRequest,
  LocalGitResponse,
  StatusEntry,
  WorkspaceFile,
  AuthoringSnapshotMetadata,
  AuthoringSnapshotFile,
  AuthoringSnapshotPage,
  AuthoringSnapshotRange,
  RemoteConfirmedFiles,
  DiffChange,
  GitHubWorkspaceIdentity,
  LocalWorkspaceIdentity,
  WorkspaceIdentity,
} from "./protocol.js";
import {
  MAX_WORKSPACE_CHANGE_BYTES,
  MAX_WORKSPACE_CHANGE_COUNT,
  MAX_WORKSPACE_READ_SET_COUNT,
  isGitHubWorkspaceIdentity,
  validateGitPath,
  validateWorkspaceIdentity,
} from "./protocol.js";
import { createGitHubAccountSession, GitHubSyncError } from "./github-sync.js";
import type { GitHubAccount, GitHubAccountSession, GitHubDevicePrompt, GitHubFetchResult, GitHubPullResult, GitHubPublishResult, GitHubRemoteHead, GitHubRepository, GitHubSyncClient, GitHubRemoteOperation } from "./github-sync.js";

export { isGitHubWorkspaceIdentity, isValidGitBranchName, validateGitPath, validateWorkspaceIdentity } from "./protocol.js";
export type { AppliedWorkspaceChange, AuthoringSnapshotFile, AuthoringSnapshotMetadata, AuthoringSnapshotPage, AuthoringSnapshotRange, CommitAuthor, CommitDiff, CommitFileChange, CommitSummary, DiffChange, FileRevision, FileRevisionExpectation, GitHubWorkspaceIdentity, LocalGitError, LocalGitErrorCode, LocalWorkspaceIdentity, RemoteConfirmedFiles, StatusEntry, WorkspaceChange, WorkspaceFile, WorkspaceIdentity };
export { GitHubSyncError } from "./github-sync.js";
export { createGitHubAccountSession } from "./github-sync.js";
export type { GitHubAccount, GitHubAccountSession, GitHubDevicePrompt, GitHubFetchResult, GitHubPullResult, GitHubPublishResult, GitHubRemoteHead, GitHubRepository, GitHubSyncClient } from "./github-sync.js";

type LocalGitCommand = LocalGitRequest extends infer Request
  ? Request extends { id: string; workspace: WorkspaceIdentity } ? Omit<Request, "id" | "workspace"> : never
  : never;

export class BrowserLocalGitError extends Error {
  constructor(readonly code: LocalGitErrorCode, message: string) {
    super(message);
    this.name = "BrowserLocalGitError";
  }
}

export interface LocalGitStatus {
  head: string | null;
  entries: StatusEntry[];
  localState: "draft" | "local-committed";
}

interface ReadResult { data: Uint8Array | null; oid: string | null; }

/** Host-only browser Git client. It never exposes the Worker filesystem or Git API. */
export class BrowserLocalGit {
  private worker: Worker;
  private readonly pending = new Map<string, { workspaceId: string; operation: LocalGitCommand["operation"]; resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private uncertain: boolean;
  private readonly uncertaintyKey: string;
  private readonly writerBlockKey: string;
  private readonly githubSessions = new Set<GitHubSyncClient>();

  constructor(private readonly workspace: WorkspaceIdentity) {
    validateWorkspaceIdentity(workspace);
    this.uncertaintyKey = `proprium.git.storage-unknown.${workspace.localWorkspaceId}`;
    this.writerBlockKey = `proprium.git.authoring-writes-blocked.${workspace.localWorkspaceId}`;
    this.uncertain = this.readUncertaintyMarker();
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("./git.worker.ts", import.meta.url), { type: "module", name: "proprium-local-git" });
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    return worker;
  }

  private readUncertaintyMarker(): boolean {
    try { return localStorage.getItem(this.uncertaintyKey) === "1"; }
    catch { return true; }
  }

  private markUncertain(): void {
    this.uncertain = true;
    try { localStorage.setItem(this.uncertaintyKey, "1"); }
    catch { /* Keep this instance fail-closed if local uncertainty cannot be persisted. */ }
  }

  private readonly onMessage = (event: MessageEvent<LocalGitResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.workspaceId !== response.workspaceId) {
      if (isWorkspaceMutation(pending.operation)) this.markUncertain();
      pending.reject(new BrowserLocalGitError("identity_mismatch", "Git worker response did not match the requested workspace."));
    } else if (response.error) {
      if (response.error.code === "storage_unknown") this.markUncertain();
      pending.reject(new BrowserLocalGitError(response.error.code, response.error.message));
    } else pending.resolve(response.result);
  };

  private readonly onError = (event: ErrorEvent): void => {
    const message = event.message || "Browser Git worker stopped unexpectedly.";
    const mutation = [...this.pending.values()].some(entry => isWorkspaceMutation(entry.operation));
    if (mutation) this.markUncertain();
    for (const entry of this.pending.values()) entry.reject(new BrowserLocalGitError(mutation ? "storage_unknown" : "git_error", message));
    this.pending.clear();
  };

  private call<T>(command: LocalGitCommand, recoveryWrite = false): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserLocalGitError("git_error", "This Browser Git session has been closed."));
    this.uncertain ||= this.readUncertaintyMarker();
    if (this.uncertain && command.operation !== "verify") {
      return Promise.reject(new BrowserLocalGitError("storage_unknown", "A previous local Git operation has an uncertain result. Verify browser storage before continuing."));
    }
    if (isWorkspaceMutation(command.operation) && !recoveryWrite) {
      try {
        if (localStorage.getItem(this.writerBlockKey) === "1") {
          return Promise.reject(new BrowserLocalGitError("storage_unknown", "Workspace writes are blocked until the retained authoring receipt is recovered."));
        }
      } catch {
        return Promise.reject(new BrowserLocalGitError("storage_unknown", "Workspace write status could not be checked safely."));
      }
    }
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        workspaceId: this.workspace.localWorkspaceId,
        operation: command.operation,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ ...command, id, workspace: this.workspace } as LocalGitRequest);
    });
  }

  init(): Promise<{ head: string | null; branch: string; localState: "draft" | "local-committed" }> {
    return this.call({ operation: "init" });
  }

  async read(path: string): Promise<{ data: Uint8Array | null; revision: FileRevision }> {
    validateGitPath(path);
    const result = await this.call<ReadResult>({ operation: "read", path });
    return { data: result.data, revision: { oid: result.oid } };
  }

  async write(path: string, data: Uint8Array, expected: FileRevision): Promise<FileRevision> {
    validateGitPath(path);
    const result = await this.call<{ oid: string }>({ operation: "write", path, data, expected });
    return { oid: result.oid };
  }

  async delete(path: string, expected: FileRevision): Promise<void> {
    validateGitPath(path);
    await this.call({ operation: "delete", path, expected });
  }

  applyChanges(changes: readonly WorkspaceChange[], readSet: readonly FileRevisionExpectation[] = [], expectedAuthoringSnapshotId?: string, recovery = false, authoringWriter = false): Promise<AppliedWorkspaceChange[]> {
    if (!Array.isArray(changes) || changes.length > MAX_WORKSPACE_CHANGE_COUNT ||
        !Array.isArray(readSet) || readSet.length > MAX_WORKSPACE_READ_SET_COUNT) {
      return Promise.reject(new BrowserLocalGitError("invalid_path", "The approved change set exceeds browser workspace limits."));
    }
    let totalBytes = 0;
    for (const change of changes) {
      validateGitPath(change.path);
      if (!(change.content === null || change.content instanceof Uint8Array)) {
        return Promise.reject(new BrowserLocalGitError("invalid_path", "The approved change set contains invalid file content."));
      }
      if (change.content) totalBytes += change.content.byteLength;
      if (totalBytes > MAX_WORKSPACE_CHANGE_BYTES) {
        return Promise.reject(new BrowserLocalGitError("invalid_path", "The approved change content exceeds browser workspace limits."));
      }
    }
    for (const expected of readSet) validateGitPath(expected.path);
    if (expectedAuthoringSnapshotId !== undefined) validateSnapshotId(expectedAuthoringSnapshotId);
    if (recovery && !expectedAuthoringSnapshotId) return Promise.reject(new BrowserLocalGitError("invalid_input", "Recovery writes require an authoring snapshot assertion."));
    return this.call({ operation: "apply-changes", changes: [...changes], readSet: [...readSet], expectedAuthoringSnapshotId, recovery }, recovery || authoringWriter);
  }

  /** Fail closed across BrowserLocalGit instances while H0 storage recovery is unresolved. */
  blockWrites(): void {
    try { localStorage.setItem(this.writerBlockKey, "1"); }
    catch {
      this.markUncertain();
      throw new BrowserLocalGitError("storage_unknown", "The workspace write block could not be persisted safely.");
    }
  }

  /** Called only after the H0 receipt and Browser Git storage have both been verified. */
  unblockWrites(): void {
    try {
      localStorage.removeItem(this.writerBlockKey);
      if (localStorage.getItem(this.writerBlockKey) === "1") throw new Error("write block remains");
    } catch { throw new BrowserLocalGitError("storage_unknown", "The workspace write block could not be cleared safely."); }
  }

  listFiles(): Promise<WorkspaceFile[]> { return this.call({ operation: "list-files" }); }

  /** Pin the current worktree directory membership and stat metadata in the Git worker. */
  pinAuthoringSnapshot(): Promise<AuthoringSnapshotMetadata> {
    return this.call({ operation: "authoring-snapshot-pin" });
  }

  assertAuthoringSnapshot(snapshotId: string): Promise<void> {
    validateSnapshotId(snapshotId);
    return this.call({ operation: "authoring-snapshot-assert", snapshotId });
  }

  listAuthoringSnapshot(snapshotId: string, prefix = "", cursor: string | null = null, limit = 128): Promise<AuthoringSnapshotPage> {
    validateSnapshotId(snapshotId);
    validateSnapshotPrefix(prefix);
    if (!(cursor === null || (typeof cursor === "string" && cursor.length > 0 && cursor.length <= 128)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      return Promise.reject(new BrowserLocalGitError("invalid_input", "Snapshot page cursor or limit is invalid."));
    }
    return this.call({ operation: "authoring-snapshot-list", snapshotId, prefix, cursor, limit });
  }

  statAuthoringSnapshot(snapshotId: string, path: string, originalBytes = false): Promise<AuthoringSnapshotFile | null> {
    validateSnapshotId(snapshotId);
    validateGitPath(path);
    return this.call({ operation: "authoring-snapshot-stat", snapshotId, path, ...(originalBytes ? { originalBytes: true as const } : {}) });
  }

  readAuthoringSnapshotRange(snapshotId: string, path: string, offset: number, length: number, originalBytes = false): Promise<AuthoringSnapshotRange> {
    validateSnapshotId(snapshotId);
    validateGitPath(path);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024) {
      return Promise.reject(new BrowserLocalGitError("invalid_input", "Snapshot read range is invalid."));
    }
    return this.call({ operation: "authoring-snapshot-read-range", snapshotId, path, offset, length, ...(originalBytes ? { originalBytes: true as const } : {}) });
  }

  releaseAuthoringSnapshot(snapshotId: string): Promise<void> {
    validateSnapshotId(snapshotId);
    return this.call({ operation: "authoring-snapshot-release", snapshotId });
  }

  /** Apply, stage and commit a clean Scratch as one exclusive workspace operation. */
  checkpointScratch(changes: readonly WorkspaceChange[], expectedHead: string | null, message: string, author: CommitAuthor):
    Promise<{ oid: string; head: string; localState: "draft" | "local-committed" }> {
    if (!Array.isArray(changes) || !changes.length || changes.length > MAX_WORKSPACE_CHANGE_COUNT ||
        changes.some(change => !change.path.startsWith("meta/scratch/") || !(change.content instanceof Uint8Array)) ||
        changes.reduce((size, change) => size + (change.content?.byteLength ?? 0), 0) > MAX_WORKSPACE_CHANGE_BYTES) {
      return Promise.reject(new BrowserLocalGitError("invalid_input", "Scratch checkpoint contains invalid paths or bytes."));
    }
    for (const change of changes) validateGitPath(change.path);
    return this.call({ operation: "scratch-checkpoint", changes: [...changes], expectedHead, message, author });
  }

  /** Atomic fail-closed move: executable files cannot silently lose Git mode. */
  renameFile(from: string, to: string, source: FileRevision, destination: FileRevision): Promise<void> {
    validateGitPath(from); validateGitPath(to);
    if (from === to) return Promise.reject(new BrowserLocalGitError("invalid_path", "Source and destination must differ."));
    return this.call({ operation: "rename-file", from, to, source, destination });
  }

  status(): Promise<LocalGitStatus> { return this.call({ operation: "status" }); }

  diff(): Promise<DiffChange[]> {
    return this.call({ operation: "diff" });
  }

  reviewDiff(): Promise<CommitReview> {
    return this.call({ operation: "review-diff" });
  }

  commitReviewed(message: string, author: CommitAuthor, snapshot: CommitReviewSnapshot): Promise<{ oid: string; head: string; localState: "draft" | "local-committed" }> {
    return this.call({ operation: "commit-reviewed", message, author, snapshot });
  }

  commitDiff(oid: string): Promise<CommitDiff> {
    if (!/^[a-f0-9]{40}$/u.test(oid)) return Promise.reject(new BrowserLocalGitError("git_error", "Commit history requires a full 40-character commit ID."));
    return this.call({ operation: "commit-diff", oid });
  }

  /** Read exact bytes from the last persisted, remotely verified commit tree and compare saved files. */
  readConfirmedRemoteFiles(paths: readonly string[]): Promise<RemoteConfirmedFiles> {
    if (!Array.isArray(paths) || paths.length > 100) {
      return Promise.reject(new BrowserLocalGitError("invalid_input", "Remote provenance accepts at most 100 file paths."));
    }
    try { for (const path of paths) validateGitPath(path); }
    catch (error) { return Promise.reject(error); }
    return this.call({ operation: "remote-confirmed-files", paths: [...paths] });
  }

  async verifyStorage(): Promise<{ verified: true; head: string | null; entries: StatusEntry[] }> {
    if (this.uncertain) {
      this.worker.removeEventListener("message", this.onMessage);
      this.worker.removeEventListener("error", this.onError);
      this.worker.terminate();
      this.worker = this.createWorker();
    }
    const result = await this.call<{ verified: true; head: string | null; entries: StatusEntry[] }>({ operation: "verify" });
    this.uncertain = false;
    try { localStorage.removeItem(this.uncertaintyKey); }
    catch { this.markUncertain(); }
    return result;
  }

  add(paths: string[], expectedHead: string | null): Promise<{ entries: StatusEntry[]; head: string | null }> {
    for (const path of paths) validateGitPath(path);
    return this.call({ operation: "add", paths, expectedHead });
  }

  commit(message: string, author: CommitAuthor, expectedHead: string | null): Promise<{ oid: string; head: string; localState: "draft" | "local-committed" }> {
    return this.call({ operation: "commit", message, author, expectedHead });
  }

  log(depth = 50): Promise<CommitSummary[]> { return this.call({ operation: "log", depth }); }

  branches(): Promise<{ current: string; branches: string[] }> { return this.call({ operation: "branches" }); }

  createBranch(name: string, expectedHead: string): Promise<{ branch: string; head: string | null }> {
    return this.call({ operation: "create-branch", name, expectedHead });
  }

  /** Create an OAuth session already bound to this verified workspace identity. */
  connectGitHub(authRelayUrl: string, fetcher: typeof fetch = fetch): GitHubSyncClient {
    const session = createGitHubAccountSession(authRelayUrl, fetcher);
    const client = this.connectGitHubSession(session);
    this.githubSessions.add(client);
    return client;
  }

  /** Bind an existing account session so repository selection does not sign in a second time. */
  connectGitHubSession(session: GitHubAccountSession): GitHubSyncClient {
    if (!isGitHubWorkspaceIdentity(this.workspace)) {
      throw new GitHubSyncError("repository_mismatch", "A browser-only workspace has no GitHub repository to synchronize.");
    }
    const send: GitHubRemoteOperation = async <T>(
      operation: "remote-head" | "remote-fetch" | "remote-pull" | "remote-publish",
      token: string,
      relayUrl: string,
      expected?: { head: string; remoteHead: string | null },
    ): Promise<T> => {
      try {
        if (operation === "remote-publish") {
          if (!expected) throw new GitHubSyncError("git_error", "Publishing requires an expected local and remote head.");
          return await this.call<T>({ operation, token, authRelayUrl: relayUrl, expectedHead: expected.head, expectedRemoteHead: expected.remoteHead });
        }
        if (operation === "remote-fetch" || operation === "remote-pull") return await this.call<T>({ operation, token, authRelayUrl: relayUrl });
        return await this.call<T>({ operation, token });
      } catch (error) {
        if (error instanceof BrowserLocalGitError) {
          const known: GitHubSyncError["code"][] = ["authentication_required", "authentication_expired", "permission_denied", "repository_mismatch", "remote_conflict", "remote_unknown", "rest_unsupported", "network_unavailable", "git_error"];
          if (known.includes(error.code as GitHubSyncError["code"])) throw new GitHubSyncError(error.code as GitHubSyncError["code"], error.message);
        }
        throw error;
      }
    };
    return session.connect(send);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.githubSessions) session.signOut();
    this.githubSessions.clear();
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.terminate();
    const mutation = [...this.pending.values()].some(entry => isWorkspaceMutation(entry.operation));
    if (mutation) this.markUncertain();
    for (const entry of this.pending.values()) entry.reject(new BrowserLocalGitError(mutation ? "storage_unknown" : "git_error", "The Git worker was closed before the operation was confirmed."));
    this.pending.clear();
  }
}

function validateSnapshotId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{16,128}$/u.test(value)) {
    throw new BrowserLocalGitError("invalid_input", "Snapshot identifier is invalid.");
  }
}

function isWorkspaceMutation(operation: string): boolean {
  return ["init", "write", "delete", "apply-changes", "add", "commit", "commit-reviewed", "create-branch", "remote-fetch", "remote-pull", "remote-publish"].includes(operation);
}

function validateSnapshotPrefix(prefix: string): void {
  if (typeof prefix !== "string" || prefix.length > 1024 || prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\0")) {
    throw new BrowserLocalGitError("invalid_input", "Snapshot path prefix is invalid.");
  }
  if (!prefix) return;
  const path = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!path || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    throw new BrowserLocalGitError("invalid_input", "Snapshot path prefix is invalid.");
  }
}
