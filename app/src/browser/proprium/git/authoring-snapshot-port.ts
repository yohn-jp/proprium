import { AuthoringSnapshotError, type AuthoringScope, type SnapshotLease, type SnapshotPage, type SnapshotPort } from "../authoring/snapshots.js";
import type { WorkspaceIdentity } from "./protocol.js";
import { BrowserLocalGit, BrowserLocalGitError } from "./index.js";

interface LocalSnapshotHandle {
  readonly owner: object;
  readonly snapshot_id: string;
}

interface SnapshotState {
  readonly scope_key: string;
  readonly lease: SnapshotLease;
}

/** Connects the authoring reader to the Host's selected Browser Git workspace. */
export class BrowserGitSnapshotPort implements SnapshotPort {
  private readonly owner = Object.freeze({});
  private readonly handles = new WeakMap<object, string>();
  private readonly states = new Map<string, SnapshotState>();

  constructor(private readonly git: BrowserLocalGit, private readonly workspace: WorkspaceIdentity) {}

  async pin(scope: AuthoringScope, options: { readonly include_draft: boolean }): Promise<SnapshotLease> {
    if (options.include_draft) throw new AuthoringSnapshotError("capability_denied", "Browser Git snapshots do not include an editor draft unless the Host supplies a draft lease.");
    this.assertSelectedScope(scope);
    try {
      const local = await this.git.pinAuthoringSnapshot();
      const lease: SnapshotLease = Object.freeze({
        scope: Object.freeze({ ...scope }),
        snapshot: Object.freeze({
          id: local.snapshot_id,
          local_commit: local.local_commit,
          worktree_generation: local.worktree_generation,
          draft_generation: null,
        }),
        host_token: Object.freeze({ owner: this.owner, snapshot_id: local.snapshot_id } satisfies LocalSnapshotHandle),
      });
      this.handles.set(lease.host_token as object, local.snapshot_id);
      this.states.set(local.snapshot_id, { scope_key: scopeKey(scope), lease });
      return lease;
    } catch (error) { throw mapError(error); }
  }

  async assert_current(lease: SnapshotLease): Promise<void> {
    const id = this.snapshotId(lease);
    try { await this.git.assertAuthoringSnapshot(id); }
    catch (error) { throw mapError(error); }
  }

  async list(lease: SnapshotLease, query: { readonly prefix: string; readonly cursor: string | null; readonly limit: number }): Promise<SnapshotPage> {
    const id = this.snapshotId(lease);
    try {
      const page = await this.git.listAuthoringSnapshot(id, query.prefix, query.cursor, query.limit);
      return Object.freeze({
        items: Object.freeze(page.items.map(item => Object.freeze({
          path: item.path,
          revision: item.revision,
          byte_length: item.byte_length,
          media_type: item.media_type,
        }))),
        next_cursor: page.next_cursor,
      });
    } catch (error) { throw mapError(error); }
  }

  async stat(lease: SnapshotLease, path: string) {
    const id = this.snapshotId(lease);
    try {
      const file = await this.git.statAuthoringSnapshot(id, path);
      return file && Object.freeze({
        path: file.path,
        revision: file.revision,
        byte_length: file.byte_length,
        media_type: file.media_type,
      });
    } catch (error) { throw mapError(error); }
  }

  async read_range(lease: SnapshotLease, path: string, offset: number, length: number) {
    const id = this.snapshotId(lease);
    try {
      const range = await this.git.readAuthoringSnapshotRange(id, path, offset, length);
      return Object.freeze({ ...range, bytes: range.bytes.slice() });
    } catch (error) { throw mapError(error); }
  }

  async release(lease: SnapshotLease): Promise<void> {
    const id = this.snapshotId(lease);
    this.states.delete(id);
    try { await this.git.releaseAuthoringSnapshot(id); }
    catch (error) {
      if ((error as { code?: string } | null)?.code !== "snapshot_stale") throw mapError(error);
    }
  }

  isSnapshotLease(lease: SnapshotLease): boolean {
    return Boolean(lease?.host_token && typeof lease.host_token === "object" &&
      (lease.host_token as LocalSnapshotHandle).owner === this.owner);
  }

  private snapshotId(lease: SnapshotLease): string {
    const token = lease?.host_token;
    const id = token && typeof token === "object" ? this.handles.get(token as object) : undefined;
    const saved = id ? this.states.get(id) : undefined;
    if (!id || !saved || saved.scope_key !== scopeKey(lease.scope) ||
        saved.lease.snapshot.id !== lease.snapshot.id || saved.lease.snapshot.local_commit !== lease.snapshot.local_commit ||
        saved.lease.snapshot.worktree_generation !== lease.snapshot.worktree_generation ||
        saved.lease.snapshot.draft_generation !== lease.snapshot.draft_generation) {
      throw new AuthoringSnapshotError("snapshot_stale", "The Host snapshot lease is invalid or expired.");
    }
    return id;
  }

  private assertSelectedScope(scope: AuthoringScope): void {
    const repository_id = this.workspace.provider === "local" ? null : this.workspace.repositoryId;
    if (!scope || scope.workspace_id !== this.workspace.localWorkspaceId || scope.repository_id !== repository_id ||
        scope.branch !== this.workspace.branch || typeof scope.generation !== "string" || !scope.generation) {
      throw new AuthoringSnapshotError("repository_not_active", "Authoring snapshot scope is not the selected Browser Git workspace.");
    }
  }
}

function scopeKey(scope: AuthoringScope): string {
  return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch, scope.generation]);
}

function mapError(error: unknown): AuthoringSnapshotError {
  if (error instanceof AuthoringSnapshotError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "Browser Git snapshot operation failed.";
  if (code === "snapshot_stale" || code === "invalid_input" || code === "invalid_path" || code === "file_not_found" || code === "capacity") {
    return new AuthoringSnapshotError(code, message);
  }
  if (code === "workspace_busy") return new AuthoringSnapshotError("storage_unknown", "Another tab is currently changing this workspace. Retry the snapshot operation.");
  return new AuthoringSnapshotError("storage_unknown", message);
}
