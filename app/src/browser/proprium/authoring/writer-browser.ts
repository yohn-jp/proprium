import { BrowserLocalGit, BrowserLocalGitError } from "../git/index.js";
import type { FileRevisionExpectation, WorkspaceChange, WorkspaceIdentity } from "../git/index.js";
import type {
  WriterScope,
  WriterReadRevision,
  WriterSnapshot,
  WriterWorkspacePort,
} from "./writer.js";

const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_READ_CHUNK_BYTES = 256 * 1024;

/** Trusted Host hooks for the selected workspace and the mounted editor. */
export interface BrowserGitWriterContext {
  selected_scope(): WriterScope | null;
  remote_commit?(scope: WriterScope): string | null;
  is_editor_dirty(scope: WriterScope): boolean;
  /** Host resolves and revalidates a separately granted, immutable source lease. */
  assert_foreign_read?(scope: WriterScope, snapshot: WriterSnapshot, path: string, revision: string | null): Promise<void>;
  /** Freeze editor draft mutations until the Browser Git unit write resolves. */
  with_editor_write_guard<T>(scope: WriterScope, operation: () => Promise<T>, recovery: boolean): Promise<T>;
}

/**
 * Production H0 port. The outer Web Lock serializes writer/journal transitions;
 * BrowserLocalGit remains the sole file writer and reasserts the pinned complete
 * worktree generation inside its own lock immediately before touching bytes.
 */
export class BrowserGitWriterWorkspace implements WriterWorkspacePort {
  private readonly writerLockName: string;
  private readonly verifiedForUnblock = new Set<string>();

  constructor(
    private readonly git: BrowserLocalGit,
    private readonly identity: WorkspaceIdentity,
    private readonly context: BrowserGitWriterContext,
  ) {
    this.writerLockName = `proprium-authoring-writer-${identity.localWorkspaceId}`;
  }

  async with_exclusive_writer<T>(scope: WriterScope, operation: () => Promise<T>): Promise<T> {
    this.assertSelected(scope);
    if (typeof navigator === "undefined" || !navigator.locks) {
      throw new BrowserGitWriterError("storage_unknown", "This browser cannot coordinate authoring writer operations across tabs.");
    }
    return navigator.locks.request(this.writerLockName, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new BrowserGitWriterError("conflict", "Another authoring writer operation is active in this workspace.");
      this.assertSelected(scope);
      return operation();
    });
  }

  async assert_snapshot(scope: WriterScope, expected: WriterSnapshot): Promise<void> {
    this.assertSelected(scope);
    assertSavedSnapshot(expected);
    const actual = await this.pinSnapshot(scope);
    try { compareSnapshot(actual.snapshot, expected); }
    finally { await this.releaseSnapshot(actual.snapshot.id); }
  }

  async assert_current(scope: WriterScope, expected: WriterSnapshot): Promise<void> {
    await this.assert_snapshot(scope, expected);
    if (this.context.is_editor_dirty(scope)) {
      throw new BrowserGitWriterError("dirty_draft", "Save or retain the current editor draft before applying a proposal.");
    }
  }

  async assert_read_set(scope: WriterScope, snapshot: WriterSnapshot, read_set: readonly WriterReadRevision[]): Promise<void> {
    this.assertSelected(scope);
    for (const read of read_set) {
      const readScope = read.scope ?? scope;
      const readSnapshot = read.snapshot ?? snapshot;
      if (sameScope(readScope, scope) && sameSnapshot(readSnapshot, snapshot)) {
        const actual = await this.read(scope, snapshot, read.path);
        if (actual.revision !== read.revision) throw new BrowserGitWriterError("snapshot_stale", `Read dependency ${read.path} changed since the proposal was computed.`);
      } else {
        if (!this.context.assert_foreign_read) throw new BrowserGitWriterError("dependency_unavailable", "A foreign source read lease cannot be revalidated by the active Host.");
        try { await this.context.assert_foreign_read(readScope, readSnapshot, read.path, read.revision); }
        catch (error) { throw mapGitError(error); }
      }
    }
  }

  read(scope: WriterScope, path: string): Promise<{
    readonly bytes: Uint8Array | null;
    readonly revision: string | null;
    readonly storage_revision: string | null;
  }>;
  read(scope: WriterScope, snapshot: WriterSnapshot, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null }>;
  async read(scope: WriterScope, pathOrSnapshot: string | WriterSnapshot, selectedPath?: string): Promise<{
    readonly bytes: Uint8Array | null;
    readonly revision: string | null;
    readonly storage_revision?: string | null;
  }> {
    if (typeof pathOrSnapshot !== "string") return this.readSnapshot(scope, pathOrSnapshot, selectedPath!);
    const path = pathOrSnapshot;
    this.assertSelected(scope);
    try {
      const result = await this.git.read(path);
      const bytes = result.data?.slice() ?? null;
      const revision = bytes ? await sha256(bytes) : null;
      return Object.freeze({ bytes, revision, storage_revision: result.revision.oid });
    } catch (error) { throw mapGitError(error); }
  }

  async read_snapshot(scope: WriterScope, snapshot: WriterSnapshot, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null }> {
    return this.readSnapshot(scope, snapshot, path);
  }

  async apply_changes(
    scope: WriterScope,
    changes: readonly WorkspaceChange[],
    read_set: readonly FileRevisionExpectation[],
    expected: WriterSnapshot,
    recovery = false,
  ) {
    this.assertSelected(scope);
    assertSavedSnapshot(expected);
    return this.context.with_editor_write_guard(scope, async () => {
      if (!recovery && this.context.is_editor_dirty(scope)) {
        throw new BrowserGitWriterError("dirty_draft", "The editor became dirty before the approved unit reached the Git writer.");
      }
      const actual = await this.pinSnapshot(scope);
      try {
        compareSnapshot(actual.snapshot, expected);
        return await this.git.applyChanges(changes, read_set, actual.snapshot.id, recovery, true);
      } catch (error) { throw mapGitError(error); }
      finally { await this.releaseSnapshot(actual.snapshot.id); }
    }, recovery);
  }

  async current_snapshot(scope: WriterScope): Promise<WriterSnapshot> {
    const pinned = await this.pinSnapshot(scope);
    try { return pinned.snapshot; }
    finally { await this.releaseSnapshot(pinned.snapshot.id); }
  }

  async block_writes(scope: WriterScope, _reason: string): Promise<void> {
    this.assertSelected(scope);
    try { this.git.blockWrites(); }
    catch (error) { throw mapGitError(error); }
  }

  async unblock_writes(scope: WriterScope): Promise<void> {
    this.assertSelected(scope);
    const key = scopeKey(scope);
    if (!this.verifiedForUnblock.has(key)) {
      throw new BrowserGitWriterError("storage_unknown", "Browser Git storage must verify before the authoring write block can be cleared.");
    }
    try {
      this.git.unblockWrites();
      this.verifiedForUnblock.delete(key);
    } catch (error) { throw mapGitError(error); }
  }

  async verify_storage(scope: WriterScope): Promise<void> {
    this.assertSelected(scope);
    try {
      await this.git.verifyStorage();
      this.verifiedForUnblock.add(scopeKey(scope));
    } catch (error) { throw mapGitError(error); }
  }

  private async pinSnapshot(scope: WriterScope): Promise<{ readonly snapshot: WriterSnapshot }> {
    this.assertSelected(scope);
    try {
      const local = await this.git.pinAuthoringSnapshot();
      return {
        snapshot: Object.freeze({
          id: local.snapshot_id,
          local_commit: local.local_commit,
          worktree_generation: local.worktree_generation,
          draft_generation: null,
          remote_commit: this.context.remote_commit?.(scope) ?? null,
        }),
      };
    } catch (error) { throw mapGitError(error); }
  }

  private async readSnapshot(scope: WriterScope, expected: WriterSnapshot, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null }> {
    this.assertSelected(scope);
    assertSavedSnapshot(expected);
    const pinned = await this.pinSnapshot(scope);
    try {
      compareSnapshot(pinned.snapshot, expected);
      const file = await this.git.statAuthoringSnapshot(pinned.snapshot.id, path);
      if (!file) return Object.freeze({ bytes: null, revision: null });
      if (!Number.isSafeInteger(file.byte_length) || file.byte_length < 0 || file.byte_length > MAX_SNAPSHOT_FILE_BYTES) {
        throw new BrowserGitWriterError("capacity", `Snapshot file ${path} exceeds the Host read limit.`);
      }
      const bytes = new Uint8Array(file.byte_length);
      let offset = 0;
      while (offset < file.byte_length) {
        const length = Math.min(SNAPSHOT_READ_CHUNK_BYTES, file.byte_length - offset);
        const range = await this.git.readAuthoringSnapshotRange(pinned.snapshot.id, path, offset, length);
        if (range.offset !== offset || range.total_bytes !== file.byte_length || range.revision !== file.revision || range.bytes.byteLength !== length) {
          throw new BrowserGitWriterError("storage_unknown", `Snapshot range for ${path} did not match its pinned file metadata.`);
        }
        bytes.set(range.bytes, offset);
        offset += length;
      }
      const revision = await sha256(bytes);
      if (revision !== file.revision) throw new BrowserGitWriterError("storage_unknown", `Snapshot bytes for ${path} do not match their pinned digest.`);
      return Object.freeze({ bytes, revision });
    } catch (error) { throw mapGitError(error); }
    finally { await this.releaseSnapshot(pinned.snapshot.id); }
  }

  private async releaseSnapshot(snapshotId: string): Promise<void> {
    try { await this.git.releaseAuthoringSnapshot(snapshotId); }
    catch (error) {
      if ((error as { code?: string } | null)?.code !== "snapshot_stale") throw mapGitError(error);
    }
  }

  private assertSelected(scope: WriterScope): void {
    const selected = this.context.selected_scope();
    if (!selected || scopeKey(selected) !== scopeKey(scope) || !sameWorkspaceIdentity(scope, this.identity)) {
      throw new BrowserGitWriterError("snapshot_stale", "The requested writer scope is not the active Browser Git workspace.");
    }
  }
}

export class BrowserGitWriterError extends Error {
  constructor(readonly code: "snapshot_stale" | "dirty_draft" | "storage_unknown" | "conflict" | "dependency_unavailable" | "invalid_path" | "capacity", message: string) {
    super(message);
    this.name = "BrowserGitWriterError";
  }
}

function sameWorkspaceIdentity(scope: WriterScope, identity: WorkspaceIdentity): boolean {
  const repositoryId = identity.provider === "local" ? null : identity.repositoryId;
  return scope.workspace_id === identity.localWorkspaceId && scope.repository_id === repositoryId && scope.branch === identity.branch;
}

function sameScope(left: WriterScope, right: WriterScope): boolean {
  return left.workspace_id === right.workspace_id && left.repository_id === right.repository_id && left.branch === right.branch && left.generation === right.generation;
}

function sameSnapshot(left: WriterSnapshot, right: WriterSnapshot): boolean {
  return left.id === right.id && left.local_commit === right.local_commit && left.worktree_generation === right.worktree_generation && left.draft_generation === right.draft_generation && (left.remote_commit ?? null) === (right.remote_commit ?? null);
}

function assertSavedSnapshot(snapshot: WriterSnapshot): void {
  if (!snapshot || typeof snapshot.id !== "string" || !snapshot.id ||
      !(snapshot.local_commit === null || /^[a-f0-9]{40}$/u.test(snapshot.local_commit)) ||
      typeof snapshot.worktree_generation !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.worktree_generation) ||
      snapshot.draft_generation !== null || snapshot.remote_commit !== undefined && !(snapshot.remote_commit === null || /^[a-f0-9]{40}$/u.test(snapshot.remote_commit))) {
    throw new BrowserGitWriterError(snapshot?.draft_generation !== null ? "dirty_draft" : "snapshot_stale", "Only a saved Browser Git worktree snapshot can be applied.");
  }
}

function compareSnapshot(actual: WriterSnapshot, expected: WriterSnapshot): void {
  if (actual.local_commit !== expected.local_commit || actual.worktree_generation !== expected.worktree_generation ||
      actual.draft_generation !== expected.draft_generation || (actual.remote_commit ?? null) !== (expected.remote_commit ?? null)) {
    throw new BrowserGitWriterError("snapshot_stale", "The Browser Git worktree membership or generation changed since review.");
  }
}

function scopeKey(scope: WriterScope): string {
  return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch, scope.generation]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function mapGitError(error: unknown): Error {
  if (error instanceof BrowserGitWriterError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "Browser Git writer operation failed.";
  if (code === "dirty_draft") return new BrowserGitWriterError("dirty_draft", message);
  if (code === "snapshot_stale" || code === "revision_conflict") return new BrowserGitWriterError("snapshot_stale", message);
  if (code === "workspace_busy" || code === "lock_unavailable") return new BrowserGitWriterError("conflict", message);
  if (code === "storage_unknown") return new BrowserGitWriterError("storage_unknown", message);
  if (code === "capacity") return new BrowserGitWriterError("capacity", message);
  if (error instanceof BrowserLocalGitError && code === "invalid_path") return new BrowserGitWriterError("invalid_path", message);
  return error instanceof Error ? error : new BrowserGitWriterError("storage_unknown", message);
}
