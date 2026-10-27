export const MAX_WORKSPACE_CHANGE_COUNT = 256;
export const MAX_WORKSPACE_READ_SET_COUNT = 1024;
export const MAX_WORKSPACE_CHANGE_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACE_READ_BYTES = 64 * 1024 * 1024;

export interface GitHubWorkspaceIdentity {
  /** Omitted only by identities stored before the provider discriminator was added. */
  provider?: "github";
  origin: string;
  repositoryId: number;
  owner: string;
  repository: string;
  branch: string;
  localWorkspaceId: string;
}

/** A browser-only repository has no remote repository ID or GitHub owner. */
export interface LocalWorkspaceIdentity {
  provider: "local";
  name: string;
  branch: string;
  localWorkspaceId: string;
}

export type WorkspaceIdentity = GitHubWorkspaceIdentity | LocalWorkspaceIdentity;

export function isGitHubWorkspaceIdentity(value: WorkspaceIdentity): value is GitHubWorkspaceIdentity {
  return !!value && value.provider !== "local";
}

export type LocalGitErrorCode =
  | "invalid_identity"
  | "identity_mismatch"
  | "invalid_path"
  | "revision_conflict"
  | "lock_unavailable"
  | "workspace_busy"
  | "not_initialized"
  | "storage_unknown"
  | "authentication_required"
  | "authentication_expired"
  | "permission_denied"
  | "repository_mismatch"
  | "remote_conflict"
  | "remote_unknown"
  | "rest_unsupported"
  | "network_unavailable"
  | "snapshot_stale"
  | "invalid_input"
  | "file_not_found"
  | "capacity"
  | "git_error";

export interface LocalGitError {
  code: LocalGitErrorCode;
  message: string;
}

export interface FileRevision {
  oid: string | null;
}

export interface FileRevisionExpectation {
  path: string;
  revision: FileRevision;
}

export interface WorkspaceChange {
  path: string;
  content: Uint8Array | null;
  expectedRevision: FileRevision;
}

export interface AppliedWorkspaceChange {
  path: string;
  revision: FileRevision;
}

export interface StatusEntry {
  path: string;
  head: number;
  worktree: number;
  stage: number;
}

export interface WorkspaceFile {
  path: string;
  type: "blob";
  oid: string;
  bytes: number;
}

export interface AuthoringSnapshotMetadata {
  snapshot_id: string;
  local_commit: string | null;
  worktree_generation: string;
}

export interface AuthoringSnapshotFile {
  path: string;
  revision: string;
  byte_length: number;
  media_type: string;
}

export interface AuthoringSnapshotPage {
  items: AuthoringSnapshotFile[];
  next_cursor: string | null;
}

export interface AuthoringSnapshotRange {
  bytes: Uint8Array;
  total_bytes: number;
  offset: number;
  revision: string;
}

export interface FileVersion {
  oid: string;
  data: Uint8Array;
}

export interface DiffChange extends StatusEntry {
  kind: "added" | "deleted" | "modified" | "staged";
  headFile: FileVersion | null;
  worktreeFile: FileVersion | null;
}

/** A commit's content compared with its first parent; null represents an absent path. */
export interface CommitFileChange {
  path: string;
  kind: "added" | "deleted" | "modified";
  parentMode: string | null;
  commitMode: string | null;
  parentFile: FileVersion | null;
  commitFile: FileVersion | null;
}

export interface CommitDiff {
  oid: string;
  parentOid: string | null;
  parents: string[];
  changes: CommitFileChange[];
}

export interface RemoteConfirmedFiles {
  remote_commit: string | null;
  files: Array<{ path: string; revision: string | null; remote_confirmed: boolean }>;
}

/** Exact worktree bytes and changed path set that the author reviewed. */
export interface CommitReviewSnapshot {
  head: string | null;
  files: Array<{ path: string; oid: string | null }>;
}

export interface CommitReview {
  head: string | null;
  changes: DiffChange[];
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitSummary {
  oid: string;
  message: string;
  timestamp: number;
  author: CommitAuthor;
  parent: string[];
}

export type LocalGitRequest =
  | { id: string; workspace: WorkspaceIdentity; operation: "init" }
  | { id: string; workspace: WorkspaceIdentity; operation: "verify" }
  | { id: string; workspace: WorkspaceIdentity; operation: "read"; path: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "write"; path: string; data: Uint8Array; expected: FileRevision }
  | { id: string; workspace: WorkspaceIdentity; operation: "delete"; path: string; expected: FileRevision }
  | { id: string; workspace: WorkspaceIdentity; operation: "apply-changes"; changes: WorkspaceChange[]; readSet: FileRevisionExpectation[]; expectedAuthoringSnapshotId?: string; recovery?: boolean }
  | { id: string; workspace: WorkspaceIdentity; operation: "list-files" }
  | { id: string; workspace: WorkspaceIdentity; operation: "authoring-snapshot-pin" }
  | { id: string; workspace: WorkspaceIdentity; operation: "authoring-snapshot-assert"; snapshotId: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "authoring-snapshot-list"; snapshotId: string; prefix: string; cursor: string | null; limit: number }
  | { id: string; workspace: WorkspaceIdentity; operation: "authoring-snapshot-stat"; snapshotId: string; path: string; originalBytes?: true }
  | { id: string; workspace: WorkspaceIdentity; operation: "authoring-snapshot-read-range"; snapshotId: string; path: string; offset: number; length: number; originalBytes?: true }
  | { id: string; workspace: WorkspaceIdentity; operation: "authoring-snapshot-release"; snapshotId: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "status" }
  | { id: string; workspace: WorkspaceIdentity; operation: "diff" }
  | { id: string; workspace: WorkspaceIdentity; operation: "review-diff" }
  | { id: string; workspace: WorkspaceIdentity; operation: "commit-reviewed"; snapshot: CommitReviewSnapshot; message: string; author: CommitAuthor }
  | { id: string; workspace: WorkspaceIdentity; operation: "commit-diff"; oid: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "remote-confirmed-files"; paths: string[] }
  | { id: string; workspace: WorkspaceIdentity; operation: "add"; paths: string[]; expectedHead: string | null }
  | { id: string; workspace: WorkspaceIdentity; operation: "commit"; expectedHead: string | null; message: string; author: CommitAuthor }
  | { id: string; workspace: WorkspaceIdentity; operation: "log"; depth: number }
  | { id: string; workspace: WorkspaceIdentity; operation: "branches" }
  | { id: string; workspace: WorkspaceIdentity; operation: "create-branch"; name: string; expectedHead: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "remote-head"; token: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "remote-fetch"; token: string; authRelayUrl: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "remote-pull"; token: string; authRelayUrl: string }
  | { id: string; workspace: WorkspaceIdentity; operation: "remote-publish"; token: string; authRelayUrl: string; expectedHead: string; expectedRemoteHead: string | null };

export interface LocalGitResponse {
  id: string;
  workspaceId: string;
  result?: unknown;
  error?: LocalGitError;
}

export function validateWorkspaceIdentity(value: WorkspaceIdentity): void {
  if (!value || typeof value !== "object") throw Object.assign(new TypeError("invalid_identity: workspace identity must be an object"), { code: "invalid_identity" });
  if (value.provider === "local") {
    if ("origin" in value || "repositoryId" in value || "owner" in value || "repository" in value) {
      throw Object.assign(new TypeError("invalid_identity: local workspaces cannot claim GitHub repository identity"), { code: "invalid_identity" });
    }
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 || /[\u0000-\u001f\u007f]/u.test(value.name)) {
      throw Object.assign(new TypeError("invalid_identity: local workspace name must contain 1-120 printable characters"), { code: "invalid_identity" });
    }
    if (!/^[A-Za-z0-9._/-]+$/u.test(value.branch) || value.branch.startsWith("/") || value.branch.endsWith("/") || value.branch.includes("..") || value.branch.includes("//")) {
      throw Object.assign(new TypeError("invalid_identity: branch is invalid"), { code: "invalid_identity" });
    }
    if (!/^[A-Za-z0-9._-]{8,128}$/u.test(value.localWorkspaceId)) {
      throw Object.assign(new TypeError("invalid_identity: localWorkspaceId must be an opaque 8-128 character identifier"), { code: "invalid_identity" });
    }
    return;
  }
  if (value.provider !== undefined && value.provider !== "github") {
    throw Object.assign(new TypeError("invalid_identity: workspace provider is unsupported"), { code: "invalid_identity" });
  }
  if (!Number.isSafeInteger(value.repositoryId) || value.repositoryId <= 0) {
    throw Object.assign(new TypeError("invalid_identity: repositoryId must be a positive immutable GitHub repository ID"), { code: "invalid_identity" });
  }
  let origin: URL;
  try { origin = new URL(value.origin); } catch { throw Object.assign(new TypeError("invalid_identity: origin must be an absolute URL"), { code: "invalid_identity" }); }
  if (origin.origin !== value.origin || (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1")) {
    throw Object.assign(new TypeError("invalid_identity: origin must be an HTTPS origin (or loopback for local tests)"), { code: "invalid_identity" });
  }
  if (!/^[A-Za-z0-9-]+$/u.test(value.owner) || !/^[A-Za-z0-9._-]+$/u.test(value.repository)) {
    throw Object.assign(new TypeError("invalid_identity: owner or repository is invalid"), { code: "invalid_identity" });
  }
  if (!/^[A-Za-z0-9._/-]+$/u.test(value.branch) || value.branch.startsWith("/") || value.branch.endsWith("/") || value.branch.includes("..") || value.branch.includes("//")) {
    throw Object.assign(new TypeError("invalid_identity: branch is invalid"), { code: "invalid_identity" });
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/u.test(value.localWorkspaceId)) {
    throw Object.assign(new TypeError("invalid_identity: localWorkspaceId must be an opaque 8-128 character identifier"), { code: "invalid_identity" });
  }
}

export function validateGitPath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw Object.assign(new TypeError("invalid_path: expected a repository-relative Git path"), { code: "invalid_path" });
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) {
    throw Object.assign(new TypeError("invalid_path: path traversal and .git access are forbidden"), { code: "invalid_path" });
  }
}
