import { validateGitPath } from "../git/index.js";
import type { ChangeSet, WriterScope, WriterSnapshot, WriterUnit } from "./writer.js";

const DEFAULT_STAGE_BYTES = 32 * 1024 * 1024;
const MAX_STAGE_COUNT = 64;
const MAX_STAGE_OPERATIONS = 256;
const MAX_STAGE_READS = 1024;
const STAGE_TTL_MS = 2 * 60 * 1000;

export interface ChangeStageContext {
  readonly scope: WriterScope;
  readonly caller_chain: readonly string[];
  /** Host invocation ID is stable only for this in-memory orchestration. */
  readonly invocation_id: string;
}

export interface ChangeStageRequest {
  readonly base_snapshot: WriterSnapshot;
  readonly previous_stage?: string;
  readonly units: readonly WriterUnit[];
  /** Extra source files used by compilers, beyond paths directly written. */
  readonly read_set?: ChangeSet["read_set"];
}

export interface ChangeStageRead {
  readonly path: string;
  readonly bytes: Uint8Array | null;
  /** Digest of returned bytes (the overlay digest when staged). */
  readonly revision: string | null;
  /** Exact revision in the original pinned base, even when bytes are overlaid. */
  readonly original_revision: string | null;
  readonly source: "base" | "stage";
}

export interface ChangeStageFile {
  readonly path: string;
  readonly revision: string;
  readonly byte_length: number;
  readonly media_type: string;
  readonly original_revision: string | null;
  readonly source: "base" | "stage";
}

export interface ChangeStagePage {
  readonly items: readonly ChangeStageFile[];
  readonly next_cursor: string | null;
}

export interface ChangeStageOverlay {
  readonly scope: WriterScope;
  readonly snapshot: WriterSnapshot;
  readonly lease: { readonly staging_snapshot: string; readonly caller_chain: readonly string[]; readonly invocation_id: string };
  readonly reader: {
    read(path: string, options?: { readonly offset?: number; readonly length?: number }): Promise<ChangeStageRead & { readonly total_bytes: number; readonly offset: number; readonly next_offset: number | null }>;
    stat(path: string): Promise<ChangeStageFile | null>;
    list(options?: { readonly prefix?: string; readonly cursor?: string | null; readonly limit?: number }): Promise<ChangeStagePage>;
  };
}

export interface ChangeStageBasePort {
  assert_snapshot(scope: WriterScope, snapshot: WriterSnapshot): Promise<void>;
  assert_read_set(scope: WriterScope, snapshot: WriterSnapshot, read_set: ChangeSet["read_set"]): Promise<void>;
  read(scope: WriterScope, snapshot: WriterSnapshot, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null }>;
  stat(scope: WriterScope, snapshot: WriterSnapshot, path: string): Promise<Omit<ChangeStageFile, "original_revision" | "source"> | null>;
  list(scope: WriterScope, snapshot: WriterSnapshot, prefix: string, cursor: string | null, limit: number): Promise<{ readonly items: readonly Omit<ChangeStageFile, "original_revision" | "source">[]; readonly next_cursor: string | null }>;
}

interface StagedPath {
  readonly bytes: Uint8Array | null;
  readonly original_revision: string | null;
  readonly revision: string | null;
}

interface StageRecord {
  readonly id: string;
  readonly context_key: string;
  readonly scope: WriterScope;
  readonly snapshot: WriterSnapshot;
  readonly caller_chain: readonly string[];
  readonly invocation_id: string;
  readonly overlay: ReadonlyMap<string, StagedPath>;
  readonly unit_order: readonly string[];
  readonly unit_dependencies: Readonly<Record<string, readonly string[]>>;
  readonly operation_ids: readonly string[];
  readonly bytes: number;
  readonly expires_at: number;
}

interface StageCursorRecord {
  readonly stage_id: string;
  readonly context_key: string;
  readonly caller_chain: readonly string[];
  readonly prefix: string;
  after_path: string | null;
  base_cursor: string | null;
  base_items: readonly Omit<ChangeStageFile, "original_revision" | "source">[];
  base_index: number;
  base_next_cursor: string | null;
  readonly overlay_paths: readonly string[];
  overlay_index: number;
  readonly expires_at: number;
}

/**
 * Ephemeral compiler overlay. It is deliberately memory-only: a token expires
 * on reload/cancel and can never be used as a Browser Git write or approval.
 */
export class ChangeStageStore {
  private readonly records = new Map<string, StageRecord>();
  private readonly cursors = new Map<string, StageCursorRecord>();

  constructor(
    private readonly base: ChangeStageBasePort,
    private readonly max_bytes = DEFAULT_STAGE_BYTES,
    private readonly now = () => Date.now(),
    private readonly new_id = () => crypto.randomUUID(),
    private readonly resolve_artifact?: (scope: WriterScope, snapshot: WriterSnapshot, artifact_id: string) => Promise<Uint8Array>,
  ) {
    if (!Number.isSafeInteger(max_bytes) || max_bytes < 1 || max_bytes > DEFAULT_STAGE_BYTES) throw new RangeError("Invalid staging quota.");
  }

  async stage(context: ChangeStageContext, request: ChangeStageRequest): Promise<{ readonly staging_snapshot: string }> {
    this.prune();
    validateContext(context);
    if (!isRecord(request) || !onlyKeys(request, ["base_snapshot", "previous_stage", "units", "read_set"]) ||
        request.previous_stage !== undefined && !validText(request.previous_stage, 128)) {
      throw new ChangeStageError("invalid_input", "Staging request is not a closed Host contract object.");
    }
    validateSnapshot(request?.base_snapshot);
    if (!Array.isArray(request.units) || request.units.length === 0 || request.units.length > MAX_STAGE_OPERATIONS ||
        request.read_set !== undefined && (!Array.isArray(request.read_set) || request.read_set.length > MAX_STAGE_READS)) {
      throw new ChangeStageError("invalid_input", "Staging request is empty or exceeds Host limits.");
    }

    const reads = new Map<string, string | null>();
    const localReads = new Map<string, string | null>();
    for (const read of request.read_set ?? []) {
      validateReadPrecondition(read, context.scope, request.base_snapshot);
      const resolvedScope = read.scope ?? context.scope;
      const resolvedSnapshot = read.snapshot ?? request.base_snapshot;
      const key = JSON.stringify([scopeKey(resolvedScope), snapshotKey(resolvedSnapshot), read.path]);
      if (reads.has(key)) throw new ChangeStageError("invalid_input", `Staging read set repeats ${read.path} in the same snapshot.`);
      reads.set(key, read.revision);
      if (sameScope(resolvedScope, context.scope) && sameSnapshot(resolvedSnapshot, request.base_snapshot)) {
        if (localReads.has(read.path)) throw new ChangeStageError("invalid_input", `Staging read set repeats local path ${read.path}.`);
        localReads.set(read.path, read.revision);
      }
    }

    await this.base.assert_snapshot(context.scope, request.base_snapshot);
    await this.base.assert_read_set(context.scope, request.base_snapshot, request.read_set ?? []);

    let overlay = new Map<string, StagedPath>();
    let previous: StageRecord | undefined;
    if (request.previous_stage !== undefined) {
      previous = this.requireStage(request.previous_stage, context, request.base_snapshot, false);
      overlay = new Map([...previous.overlay].map(([path, item]) => [path, cloneStagedPath(item)]));
    }

    let count = 0;
    const stagedPaths = new Map<string, { bytes: Uint8Array | null; original_revision: string | null; revision: string | null }>();
    const unitOrder = [...(previous?.unit_order ?? [])];
    const unitIds = new Set(unitOrder);
    const unitDependencies: Record<string, readonly string[]> = Object.fromEntries(
      Object.entries(previous?.unit_dependencies ?? {}).map(([id, dependencies]) => [id, [...dependencies]]),
    );
    const operationIds = new Set(previous?.operation_ids ?? []);
    for (const unit of request.units) {
      if (!isRecord(unit) || !onlyKeys(unit, ["id", "label", "depends_on", "operations", "source_operation_ids"]) ||
          !validText(unit.id, 128) || !validText(unit.label, 240) || unitIds.has(unit.id) ||
          !Array.isArray(unit.depends_on) || !Array.isArray(unit.operations) || unit.operations.length === 0 ||
          unit.source_operation_ids !== undefined && (!Array.isArray(unit.source_operation_ids) || unit.source_operation_ids.length > MAX_STAGE_OPERATIONS || unit.source_operation_ids.some(item => !validText(item, 128)))) {
        throw new ChangeStageError("invalid_input", "A staging unit is invalid or repeated.");
      }
      const dependencies = new Set<string>();
      for (const dependency of unit.depends_on) {
        if (!validText(dependency, 128) || dependency === unit.id || dependencies.has(dependency) || !unitIds.has(dependency)) {
          throw new ChangeStageError("invalid_input", `Staging unit ${unit.id} has a missing, forward or duplicate dependency.`);
        }
        dependencies.add(dependency);
      }
      unitIds.add(unit.id);
      unitOrder.push(unit.id);
      unitDependencies[unit.id] = Object.freeze([...dependencies]);
      const seenInUnit = new Set<string>();
      for (const operation of unit.operations) {
        count += 1;
        if (count > MAX_STAGE_OPERATIONS || !isRecord(operation) || !onlyKeys(operation, ["id", "kind", "path", "expected_revision", "content", "content_artifact"]) || !validText(operation.id, 128) || operationIds.has(operation.id) ||
            operation.kind !== "create" && operation.kind !== "replace" && operation.kind !== "delete" ||
            !validText(operation.path, 1024) || !validRevision(operation.expected_revision)) {
          throw new ChangeStageError("invalid_input", "A staged file operation is invalid.");
        }
        try { validateGitPath(operation.path); }
        catch { throw new ChangeStageError("invalid_path", `Staged path ${operation.path} is unsafe.`); }
        if (seenInUnit.has(operation.path)) throw new ChangeStageError("invalid_input", `Staging unit ${unit.id} repeats ${operation.path}.`);
        seenInUnit.add(operation.path);
        operationIds.add(operation.id);
        if (operation.kind === "create" && operation.expected_revision !== null ||
            (operation.kind === "replace" || operation.kind === "delete") && operation.expected_revision === null) {
          throw new ChangeStageError("invalid_input", `Staged operation ${operation.id} has an invalid create/replace/delete precondition.`);
        }
        const hasContent = operation.content instanceof Uint8Array;
        const hasArtifact = typeof operation.content_artifact === "string" && operation.content_artifact.length > 0;
        if (operation.kind === "delete" ? operation.content !== undefined || operation.content_artifact !== undefined :
            hasContent === hasArtifact || operation.content !== undefined && !hasContent || operation.content_artifact !== undefined && !hasArtifact) {
          throw new ChangeStageError("invalid_input", `Staged operation ${operation.id} must contain exactly one byte source or be a delete.`);
        }
        if (operation.kind !== "delete" && hasArtifact && !this.resolve_artifact) {
          throw new ChangeStageError("dependency_unavailable", "Host sealed artifact reads are unavailable for compiler staging.");
        }

        const original = await this.base.read(context.scope, request.base_snapshot, operation.path);
        if (original.revision !== operation.expected_revision) {
          throw new ChangeStageError("snapshot_stale", `Staged path ${operation.path} no longer matches its original-base revision.`);
        }
        const priorRead = localReads.get(operation.path);
        if (localReads.has(operation.path) && priorRead !== original.revision) {
          throw new ChangeStageError("snapshot_stale", `Staged write and read revisions disagree for ${operation.path}.`);
        }
        localReads.set(operation.path, original.revision);
        const bytes = operation.kind === "delete" ? null : hasContent
          ? Uint8Array.from(operation.content!)
          : Uint8Array.from(await this.resolve_artifact!(context.scope, request.base_snapshot, operation.content_artifact!));
        stagedPaths.set(operation.path, { bytes, original_revision: original.revision, revision: bytes ? await sha256(bytes) : null });
      }
    }

    for (const [path, item] of stagedPaths) overlay.set(path, { bytes: item.bytes?.slice() ?? null, original_revision: item.original_revision, revision: item.revision });
    const byteCount = [...overlay.values()].reduce((sum, item) => sum + (item.bytes?.byteLength ?? 0), 0);
    const otherBytes = [...this.records.values()].filter(item => item.id !== previous?.id).reduce((sum, item) => sum + item.bytes, 0);
    const otherStages = this.records.size - (previous ? 1 : 0);
    if (byteCount > this.max_bytes || otherBytes + byteCount > this.max_bytes) throw new ChangeStageError("capacity", "Compiler staging exceeds the Host overlay quota.");
    if (otherStages >= MAX_STAGE_COUNT) throw new ChangeStageError("capacity", "Too many compiler staging leases are active.");

    const id = this.new_id();
    if (!validText(id, 128) || this.records.has(id)) throw new ChangeStageError("storage_unknown", "Host could not issue a unique compiler staging lease.");
    const record: StageRecord = Object.freeze({
      id,
      context_key: contextKey(context),
      scope: Object.freeze({ ...context.scope }),
      snapshot: Object.freeze({ ...request.base_snapshot }),
      caller_chain: Object.freeze([...context.caller_chain]),
      invocation_id: context.invocation_id,
      overlay: new Map([...overlay].map(([path, item]) => [path, cloneStagedPath(item)])),
      unit_order: Object.freeze(unitOrder),
      unit_dependencies: Object.freeze(Object.fromEntries(Object.entries(unitDependencies).map(([id, dependencies]) => [id, Object.freeze([...dependencies])]))),
      operation_ids: Object.freeze([...operationIds]),
      bytes: byteCount,
      expires_at: this.now() + STAGE_TTL_MS,
    });
    this.records.set(id, record);
    if (previous) this.records.delete(previous.id);
    return Object.freeze({ staging_snapshot: id });
  }

  async read(snapshot_id: string, context: ChangeStageContext, base_snapshot: WriterSnapshot, path: string): Promise<ChangeStageRead> {
    try { validateGitPath(path); }
    catch { throw new ChangeStageError("invalid_path", "Staged read path is unsafe."); }
    const record = this.requireStage(snapshot_id, context, base_snapshot);
    await this.base.assert_snapshot(record.scope, record.snapshot);
    const overlay = record.overlay.get(path);
    if (overlay) {
      const bytes = overlay.bytes?.slice() ?? null;
      return Object.freeze({ path, bytes, revision: overlay.revision, original_revision: overlay.original_revision, source: "stage" });
    }
    const original = await this.base.read(record.scope, record.snapshot, path);
    return Object.freeze({ path, bytes: original.bytes?.slice() ?? null, revision: original.revision, original_revision: original.revision, source: "base" });
  }

  assertStage(snapshot_id: string, scope: WriterScope, snapshot: WriterSnapshot, caller_chain: readonly string[], invocation_id: string): void {
    this.requireStage(snapshot_id, { scope, caller_chain, invocation_id }, snapshot);
  }

  async readStage(
    snapshot_id: string,
    scope: WriterScope,
    snapshot: WriterSnapshot,
    caller_chain: readonly string[],
    invocation_id: string,
    path: string,
  ): Promise<ChangeStageRead> {
    return this.read(snapshot_id, { scope, caller_chain, invocation_id }, snapshot, path);
  }

  readOverlay(scope: WriterScope, base_snapshot: WriterSnapshot, staging_snapshot: string, caller_chain: readonly string[], invocation_id: string): ChangeStageOverlay {
    const context: ChangeStageContext = { scope, caller_chain, invocation_id };
    this.assertStage(staging_snapshot, scope, base_snapshot, caller_chain, invocation_id);
    return Object.freeze({
      scope: Object.freeze({ ...scope }),
      snapshot: Object.freeze({ ...base_snapshot }),
      lease: Object.freeze({ staging_snapshot, caller_chain: Object.freeze([...caller_chain]), invocation_id }),
      reader: Object.freeze({
        read: async (path: string, options: { readonly offset?: number; readonly length?: number } = {}) => {
          const offset = options.offset ?? 0;
          const length = options.length ?? 65_536;
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024) {
            throw new ChangeStageError("invalid_input", "Staged read range is invalid.");
          }
          const value = await this.read(staging_snapshot, context, base_snapshot, path);
          const total_bytes = value.bytes?.byteLength ?? 0;
          if (offset > total_bytes) throw new ChangeStageError("invalid_input", "Staged read offset is beyond end of file.");
          const end = Math.min(total_bytes, offset + length);
          return Object.freeze({ ...value, bytes: value.bytes?.slice(offset, end) ?? null, total_bytes, offset, next_offset: end < total_bytes ? end : null });
        },
        stat: (path: string) => this.statStage(staging_snapshot, context, base_snapshot, path),
        list: (options: { readonly prefix?: string; readonly cursor?: string | null; readonly limit?: number } = {}) => this.listStage(staging_snapshot, context, base_snapshot, options),
      }),
    });
  }

  async statStage(snapshot_id: string, context: ChangeStageContext, base_snapshot: WriterSnapshot, path: string): Promise<ChangeStageFile | null> {
    try { validateGitPath(path); } catch { throw new ChangeStageError("invalid_path", "Staged stat path is unsafe."); }
    const record = this.requireStage(snapshot_id, context, base_snapshot);
    await this.base.assert_snapshot(record.scope, record.snapshot);
    const overlay = record.overlay.get(path);
    if (overlay) {
      if (!overlay.bytes) return null;
      return Object.freeze({ path, revision: overlay.revision!, byte_length: overlay.bytes.byteLength, media_type: mediaType(path), original_revision: overlay.original_revision, source: "stage" });
    }
    const base = await this.base.stat(record.scope, record.snapshot, path);
    return base && Object.freeze({ ...base, original_revision: base.revision, source: "base" });
  }

  async listStage(snapshot_id: string, context: ChangeStageContext, base_snapshot: WriterSnapshot, options: {
    readonly prefix?: string;
    readonly cursor?: string | null;
    readonly limit?: number;
  } = {}): Promise<ChangeStagePage> {
    const record = this.requireStage(snapshot_id, context, base_snapshot);
    await this.base.assert_snapshot(record.scope, record.snapshot);
    const prefix = options.prefix ?? "";
    validatePrefix(prefix);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ChangeStageError("invalid_input", "Staging list page size must be from 1 to 100.");

    let cursor: StageCursorRecord;
    if (options.cursor) {
      const prior = this.cursors.get(options.cursor);
      this.cursors.delete(options.cursor);
      if (!prior || prior.expires_at <= this.now() || prior.stage_id !== snapshot_id || prior.context_key !== contextKey(context) ||
          !isPrefix(prior.caller_chain, context.caller_chain) || prior.prefix !== prefix) {
        throw new ChangeStageError("invalid_input", "Staging list cursor is expired or belongs to another stage, caller or path prefix.");
      }
      cursor = prior;
    } else {
      cursor = {
        stage_id: snapshot_id,
        context_key: contextKey(context),
        caller_chain: Object.freeze([...context.caller_chain]),
        prefix,
        after_path: null,
        base_cursor: null,
        base_items: [],
        base_index: 0,
        base_next_cursor: null,
        overlay_paths: [...record.overlay.keys()].filter(path => path.startsWith(prefix)).sort(compareUtf8),
        overlay_index: 0,
        expires_at: this.now() + STAGE_TTL_MS,
      };
    }

    const fetchBasePage = async () => {
      const page = await this.base.list(record.scope, record.snapshot, prefix, cursor.base_cursor, 100);
      cursor.base_items = page.items;
      cursor.base_index = 0;
      cursor.base_next_cursor = page.next_cursor;
    };
    const ensureBase = async () => {
      while (cursor.base_index >= cursor.base_items.length && cursor.base_next_cursor !== null) {
        cursor.base_cursor = cursor.base_next_cursor;
        await fetchBasePage();
      }
    };
    if (cursor.base_items.length === 0 && cursor.base_next_cursor === null && cursor.base_cursor === null) await fetchBasePage();

    const output: ChangeStageFile[] = [];
    while (output.length < limit) {
      await ensureBase();
      const baseItem = cursor.base_items[cursor.base_index];
      const overlayPath = cursor.overlay_paths[cursor.overlay_index];
      if (!baseItem && !overlayPath) break;
      if (baseItem && overlayPath && compareUtf8(baseItem.path, overlayPath) === 0) {
        cursor.base_index += 1;
        cursor.overlay_index += 1;
        cursor.after_path = baseItem.path;
        const staged = record.overlay.get(overlayPath)!;
        if (staged.bytes) output.push(Object.freeze({ path: overlayPath, revision: staged.revision!, byte_length: staged.bytes.byteLength, media_type: mediaType(overlayPath), original_revision: staged.original_revision, source: "stage" }));
      } else if (overlayPath && (!baseItem || compareUtf8(overlayPath, baseItem.path) < 0)) {
        cursor.overlay_index += 1;
        cursor.after_path = overlayPath;
        const staged = record.overlay.get(overlayPath)!;
        if (staged.bytes) output.push(Object.freeze({ path: overlayPath, revision: staged.revision!, byte_length: staged.bytes.byteLength, media_type: mediaType(overlayPath), original_revision: staged.original_revision, source: "stage" }));
      } else {
        cursor.base_index += 1;
        cursor.after_path = baseItem!.path;
        if (!record.overlay.has(baseItem!.path)) output.push(Object.freeze({ ...baseItem!, original_revision: baseItem!.revision, source: "base" }));
      }
    }
    await ensureBase();
    const hasMore = cursor.base_index < cursor.base_items.length || cursor.base_next_cursor !== null || cursor.overlay_index < cursor.overlay_paths.length;
    if (!hasMore) return Object.freeze({ items: Object.freeze(output), next_cursor: null });
    if (this.cursors.size >= 256) throw new ChangeStageError("capacity", "Too many staged list cursors are active.");
    const next = this.new_id();
    if (!validText(next, 128) || this.cursors.has(next)) throw new ChangeStageError("storage_unknown", "Host could not issue a unique staging list cursor.");
    this.cursors.set(next, cursor);
    return Object.freeze({ items: Object.freeze(output), next_cursor: next });
  }

  /** Host cancellation revokes every overlay in that orchestration chain. */
  releaseInvocation(context: ChangeStageContext): number {
    validateContext(context);
    const key = contextKey(context);
    let released = 0;
    for (const [id, stage] of this.records) {
      if (stage.context_key === key && isPrefix(context.caller_chain, stage.caller_chain)) { this.records.delete(id); released += 1; }
    }
    for (const [id, cursor] of this.cursors) if (cursor.context_key === key && isPrefix(context.caller_chain, cursor.caller_chain)) this.cursors.delete(id);
    return released;
  }

  get bytes_in_use(): number {
    this.prune();
    return [...this.records.values()].reduce((sum, item) => sum + item.bytes, 0);
  }

  private requireStage(snapshot_id: string, context: ChangeStageContext, snapshot: WriterSnapshot, allowDescendants = true): StageRecord {
    this.prune();
    const record = this.records.get(snapshot_id);
    if (!record || record.expires_at <= this.now() || record.context_key !== contextKey(context) ||
        !sameScope(record.scope, context.scope) || !sameSnapshot(record.snapshot, snapshot) ||
        !(allowDescendants ? isPrefix(record.caller_chain, context.caller_chain) : sameChain(record.caller_chain, context.caller_chain))) {
      throw new ChangeStageError("snapshot_stale", "Compiler staging lease is expired or belongs to another caller, scope or base snapshot.");
    }
    return record;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, item] of this.records) if (item.expires_at <= now) this.records.delete(id);
  }
}

export class ChangeStageError extends Error {
  constructor(readonly code: "invalid_input" | "invalid_path" | "snapshot_stale" | "capacity" | "storage_unknown" | "dependency_unavailable", message: string) {
    super(message); this.name = "ChangeStageError";
  }
}

function validateContext(context: ChangeStageContext): void {
  if (!isRecord(context) || !onlyKeys(context, ["scope", "caller_chain", "invocation_id"]) || !validScope(context.scope) || !Array.isArray(context.caller_chain) || context.caller_chain.length < 1 || context.caller_chain.length > 32 ||
      context.caller_chain.some(item => !validText(item, 256)) || !validText(context.invocation_id, 256)) {
    throw new ChangeStageError("invalid_input", "Host staging caller context is invalid.");
  }
}
function validateSnapshot(value: WriterSnapshot): void {
  if (!value || !validText(value.id, 128) || !(value.local_commit === null || /^[a-f0-9]{40}$/u.test(value.local_commit)) ||
      !/^[a-f0-9]{64}$/u.test(value.worktree_generation) || !(value.draft_generation === null || validText(value.draft_generation, 256)) ||
      value.remote_commit !== undefined && !(value.remote_commit === null || /^[a-f0-9]{40}$/u.test(value.remote_commit))) {
    throw new ChangeStageError("invalid_input", "Staging base snapshot is invalid.");
  }
}
function validateReadPrecondition(read: ChangeSet["read_set"][number], baseScope: WriterScope, baseSnapshot: WriterSnapshot): void {
  if (!isRecord(read) || !onlyKeys(read, ["path", "revision", "scope", "snapshot"]) || !validText(read.path, 1024) || !validRevision(read.revision) ||
      (read.scope === undefined) !== (read.snapshot === undefined)) {
    throw new ChangeStageError("invalid_input", "Staging read precondition is invalid.");
  }
  try { validateGitPath(read.path); } catch { throw new ChangeStageError("invalid_path", `Staging read path ${read.path} is unsafe.`); }
  if (read.scope !== undefined && (!validScope(read.scope) || !validSnapshotValue(read.snapshot))) {
    throw new ChangeStageError("invalid_input", "Foreign staging reads require a valid paired scope and snapshot.");
  }
  if (read.scope === undefined && !validScope(baseScope) || read.snapshot === undefined && !validSnapshotValue(baseSnapshot)) {
    throw new ChangeStageError("invalid_input", "Staging base scope or snapshot is invalid.");
  }
}
function validText(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function validRevision(value: unknown): value is string | null { return value === null || typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function validScope(value: unknown): value is WriterScope {
  return isRecord(value) && onlyKeys(value, ["workspace_id", "repository_id", "branch", "generation"]) && validText(value.workspace_id, 256) &&
    (value.repository_id === null || Number.isSafeInteger(value.repository_id) && (value.repository_id as number) > 0) &&
    validText(value.branch, 256) && validText(value.generation, 256);
}
function validSnapshotValue(value: unknown): value is WriterSnapshot {
  if (!isRecord(value) || !onlyKeys(value, ["id", "local_commit", "worktree_generation", "draft_generation", "remote_commit"])) return false;
  return validText(value.id, 128) && (value.local_commit === null || typeof value.local_commit === "string" && /^[a-f0-9]{40}$/u.test(value.local_commit)) &&
    typeof value.worktree_generation === "string" && /^[a-f0-9]{64}$/u.test(value.worktree_generation) &&
    (value.draft_generation === null || validText(value.draft_generation, 256)) &&
    (value.remote_commit === undefined || value.remote_commit === null || typeof value.remote_commit === "string" && /^[a-f0-9]{40}$/u.test(value.remote_commit));
}
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function onlyKeys(value: object, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function sameScope(left: WriterScope, right: WriterScope): boolean {
  return left.workspace_id === right.workspace_id && left.repository_id === right.repository_id && left.branch === right.branch && left.generation === right.generation;
}
function sameSnapshot(left: WriterSnapshot, right: WriterSnapshot): boolean {
  return left.id === right.id && left.local_commit === right.local_commit && left.worktree_generation === right.worktree_generation && left.draft_generation === right.draft_generation &&
    (left.remote_commit ?? null) === (right.remote_commit ?? null);
}
function contextKey(context: ChangeStageContext): string { return JSON.stringify([scopeKey(context.scope), context.invocation_id]); }
function snapshotKey(snapshot: WriterSnapshot): string { return JSON.stringify([snapshot.id, snapshot.local_commit, snapshot.worktree_generation, snapshot.draft_generation, snapshot.remote_commit ?? null]); }
function sameChain(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function isPrefix(prefix: readonly string[], value: readonly string[]): boolean { return prefix.length <= value.length && prefix.every((item, index) => item === value[index]); }
function scopeKey(scope: WriterScope): string { return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch, scope.generation]); }
function cloneStagedPath(item: StagedPath): StagedPath { return { bytes: item.bytes, original_revision: item.original_revision, revision: item.revision }; }
function validatePrefix(prefix: string): void {
  if (typeof prefix !== "string" || prefix.length > 1024 || prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\0")) throw new ChangeStageError("invalid_path", "Staging list prefix is invalid.");
  if (prefix) {
    const value = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (!value || value.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) throw new ChangeStageError("invalid_path", "Staging list prefix is invalid.");
  }
}
function compareUtf8(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
function mediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "json") return "application/json";
  if (ext === "yaml" || ext === "yml") return "application/yaml";
  if (ext === "txt" || ext === "toml") return "text/plain";
  return "application/octet-stream";
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
