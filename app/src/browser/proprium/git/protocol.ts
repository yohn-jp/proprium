export interface WorkspaceIdentity {
  origin: string;
  repositoryId: number;
  owner: string;
  repository: string;
  branch: string;
  localWorkspaceId: string;
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
  | "git_error";

export interface LocalGitError {
  code: LocalGitErrorCode;
  message: string;
}

export interface FileRevision {
  oid: string | null;
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

export interface FileVersion {
  oid: string;
  data: Uint8Array;
}

export interface DiffChange extends StatusEntry {
  kind: "added" | "deleted" | "modified" | "staged";
  headFile: FileVersion | null;
  worktreeFile: FileVersion | null;
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
  | { id: string; workspace: WorkspaceIdentity; operation: "list-files" }
  | { id: string; workspace: WorkspaceIdentity; operation: "status" }
  | { id: string; workspace: WorkspaceIdentity; operation: "diff" }
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
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.repositoryId) || value.repositoryId <= 0) {
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
