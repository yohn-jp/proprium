import type { AppliedWorkspaceChange, FileRevisionExpectation, WorkspaceChange } from "../git/index.js";
import { validateGitPath } from "../git/index.js";
import type { ChangeSet as WireChangeSet, ChangeUnit, FileOperation, ReadPrecondition, Scope, Snapshot, SourceSpan } from "./types.js";

/** The canonical H0 authoring scope. These identifiers are issued by the Host. */
export interface WriterScope extends Scope {}

export interface WriterSnapshot extends Snapshot {}

export interface WriterReadRevision extends ReadPrecondition {}

export type WriterOperationKind = "create" | "replace" | "delete";

export interface WriterOperation extends Omit<FileOperation, "content"> {
  readonly content?: Uint8Array;
}

export interface WriterUnit extends Omit<ChangeUnit, "operations" | "depends_on" | "source_operation_ids"> {
  readonly depends_on: readonly string[];
  readonly source_operation_ids?: readonly string[];
  readonly operations: readonly WriterOperation[];
}

export interface WriterEvidence extends SourceSpan {}

export interface ChangeSet extends Omit<WireChangeSet, "scope" | "snapshot" | "read_set" | "units" | "evidence"> {
  readonly scope: WriterScope;
  readonly snapshot: WriterSnapshot;
  readonly read_set: readonly WriterReadRevision[];
  readonly units: readonly WriterUnit[];
  readonly evidence: readonly WriterEvidence[];
  /** Exact domain input and provenance supplied by a producer, retained in its receipt. */
  readonly source_payload?: unknown;
  readonly source_payload_digest?: string;
  readonly domain_evidence?: unknown;
}

export interface WriterCaller {
  /** Caller and plugin identity are Host supplied; guests cannot set these. */
  readonly caller: "ui" | "mcp" | "plugin";
  readonly producer_plugin_id: string;
  readonly action_id: string;
  readonly scope: WriterScope;
  readonly idempotency_key: string;
  /** Exact sanitized original typed action input, retained for later inspection. */
  readonly source_payload: Uint8Array;
  readonly request_digest: string;
  readonly submitted_at: string;
}

export type ProposalState = "proposed" | "approved" | "rejected" | "stale" | "applying" | "applied" | "partially_applied" | "failed" | "storage_unknown";
export type UnitState = "pending" | "applying" | "applied" | "failed";

export interface UnitReceipt {
  readonly id: string;
  readonly source_operation_ids: readonly string[];
  readonly depends_on: readonly string[];
  readonly status: UnitState;
  readonly resulting_revisions: readonly WriterReadRevision[];
  readonly failure?: { readonly code: WriterErrorCode; readonly message: string };
}

export interface WriterProposalRecord {
  readonly proposal_id: string;
  readonly producer_plugin_id: string;
  readonly action_id: string;
  readonly scope: WriterScope;
  readonly base_snapshot: WriterSnapshot;
  /** Advances only after a unit's exact bytes are verified and receipted. */
  readonly latest_snapshot: WriterSnapshot;
  readonly status: ProposalState;
  readonly submitted_at: string;
  readonly approved_unit_ids: readonly string[];
  readonly units: readonly UnitReceipt[];
  readonly source_payload_digest: string;
  readonly checkpoint: { readonly local_commit: string | null; readonly remote_commit: string | null; readonly remote_confirmed: false };
  readonly source_payload_available: true;
}

export interface WriterReceiptEvent {
  readonly sequence: number;
  readonly at: string;
  readonly kind: "submitted" | "reviewed" | "rejected" | "apply_started" | "unit_completed" | "unit_failed" | "recovered";
  readonly proposal_id: string;
  readonly unit_id?: string;
  readonly snapshot?: WriterSnapshot;
  readonly resulting_revisions?: readonly WriterReadRevision[];
  readonly error_code?: WriterErrorCode;
}

export interface StagedOperation {
  readonly path: string;
  /** Host journal location containing the exact staged byte images. */
  readonly staging_path: string;
  readonly before: Uint8Array | null;
  readonly before_revision: string | null;
  readonly after: Uint8Array | null;
  readonly after_revision: string | null;
}

export interface UnitWriteAheadRecord {
  readonly proposal_id: string;
  readonly unit_id: string;
  readonly scope: WriterScope;
  readonly phase: "applying" | "storage_unknown";
  readonly operations: readonly StagedOperation[];
  readonly created_at: string;
}

export interface WriterState {
  readonly sequence: number;
  readonly proposals: Readonly<Record<string, PersistedProposal>>;
  readonly idempotency: Readonly<Record<string, { readonly request_digest: string; readonly proposal_id: string }>>;
  readonly timestamps: Readonly<Record<string, string>>;
  readonly write_ahead: UnitWriteAheadRecord | null;
  readonly events: readonly WriterReceiptEvent[];
}

export interface PersistedProposal {
  readonly set: ChangeSet;
  readonly caller: WriterCaller;
  readonly source_payload: Uint8Array;
  readonly base_files: Readonly<Record<string, Uint8Array | null>>;
  readonly record: WriterProposalRecord;
}

/**
 * Implementations must use one durable IndexedDB transaction for every callback.
 * In particular, proposal + idempotency index + receipt, and write-ahead record
 * + applying event may not be split across persistence writes.
 */
export interface WriterJournalStore {
  transact<T>(scope: WriterScope, update: (current: WriterState) => { readonly next: WriterState; readonly value: T }): Promise<T>;
  read(scope: WriterScope): Promise<WriterState>;
}

/**
 * The Host adapter supplies these methods. `apply_changes` must call the one
 * BrowserLocalGit writer. `with_exclusive_writer` holds a workspace-wide lock
 * across journal, apply and receipt persistence (not just the apply call).
 */
export interface WriterWorkspacePort {
  with_exclusive_writer<T>(scope: WriterScope, operation: () => Promise<T>): Promise<T>;
  /** Pins saved bytes and directory membership, while permitting a dirty editor buffer. */
  assert_snapshot(scope: WriterScope, snapshot: WriterSnapshot): Promise<void>;
  assert_current(scope: WriterScope, snapshot: WriterSnapshot): Promise<void>;
  /** Revalidates every local and foreign source lease in the declared read set. */
  assert_read_set(scope: WriterScope, snapshot: WriterSnapshot, read_set: readonly WriterReadRevision[]): Promise<void>;
  /** revision is the canonical exact-byte SHA-256; storage_revision is Browser Git's opaque conditional-write token. */
  read(scope: WriterScope, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null; readonly storage_revision: string | null }>;
  /** Optional exact pinned-base read used during admission/evidence validation. */
  read_snapshot?(scope: WriterScope, snapshot: WriterSnapshot, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null }>;
  apply_changes(scope: WriterScope, changes: readonly WorkspaceChange[], read_set: readonly FileRevisionExpectation[], expected_snapshot: WriterSnapshot, recovery?: boolean): Promise<readonly AppliedWorkspaceChange[]>;
  current_snapshot(scope: WriterScope): Promise<WriterSnapshot>;
  block_writes(scope: WriterScope, reason: string): Promise<void>;
  /** Must clear a prior uncertainty only after BrowserLocalGit.verifyStorage succeeds. */
  unblock_writes(scope: WriterScope): Promise<void>;
  verify_storage(scope: WriterScope): Promise<void>;
}

export interface WriterDependencies {
  readonly journal: WriterJournalStore;
  readonly workspace: WriterWorkspacePort;
  readonly resolve_artifact?: (scope: WriterScope, snapshot: WriterSnapshot, artifact_id: string) => Promise<Uint8Array>;
  readonly new_proposal_id: () => string;
  readonly now?: () => string;
}

export type WriterErrorCode = "invalid_input" | "invalid_path" | "invalid_encoding" | "snapshot_stale" | "dirty_draft" | "conflict" | "capability_denied" | "dependency_unavailable" | "idempotency_conflict" | "storage_unknown" | "file_not_found" | "capacity";

export class ChangeWriterError extends Error {
  constructor(readonly code: WriterErrorCode, message: string) {
    super(message);
    this.name = "ChangeWriterError";
  }
}

export interface ProposalInspectionOperation {
  readonly id: string;
  readonly kind: WriterOperationKind;
  readonly path: string;
  readonly expected_revision: string | null;
  readonly before_hash: string | null;
  readonly before_content_ref?: string;
  readonly content_ref?: string;
  readonly after_hash: string | null;
}

export interface ProposalInspection {
  readonly proposal_id: string;
  readonly status: ProposalState;
  readonly title: string;
  readonly reason: string;
  readonly read_set: readonly WriterReadRevision[];
  readonly units: readonly (Omit<WriterUnit, "operations"> & { readonly operations: readonly ProposalInspectionOperation[] })[];
  readonly evidence: readonly WriterEvidence[];
  readonly domain_evidence?: unknown;
  readonly source_payload_available: boolean;
  readonly source_payload_digest: string;
  readonly source_payload?: Uint8Array;
  readonly source_ref?: string;
  readonly next_cursor: string | null;
}

export interface ProposalPreview {
  readonly title: string;
  readonly reason: string;
  readonly scope: WriterScope;
  readonly snapshot: WriterSnapshot;
  readonly read_set: readonly WriterReadRevision[];
  readonly units: readonly (Omit<WriterUnit, "operations"> & { readonly operations: readonly ProposalInspectionOperation[] })[];
  readonly evidence: readonly WriterEvidence[];
  readonly domain_evidence?: unknown;
  readonly source_payload_digest: string;
}

export interface ProposalAdmission {
  readonly proposal_id: string;
  readonly preview: ProposalPreview;
  readonly status: ProposalState;
}

export interface ProposalContentChunk {
  readonly offset: number;
  readonly total_bytes: number;
  readonly bytes: Uint8Array;
  readonly next_offset: number | null;
  readonly sha256: string;
}

const EMPTY_STATE: WriterState = Object.freeze({ sequence: 0, proposals: Object.freeze({}), idempotency: Object.freeze({}), timestamps: Object.freeze({}), write_ahead: null, events: Object.freeze([]) });
const MAX_OPERATIONS = 256;
const MAX_READ_SET = 1024;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_TITLE = 240;
const MAX_REASON = 20_000;
const MAX_EVIDENCE = 1024;
const REVISION = /^[a-f0-9]{64}$/u;

function fail(code: WriterErrorCode, message: string): never { throw new ChangeWriterError(code, message); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function validRevision(value: unknown): value is string | null { return value === null || typeof value === "string" && REVISION.test(value); }
function scopeKey(scope: WriterScope): string { return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch, scope.generation]); }
function snapshotKey(snapshot: WriterSnapshot): string { return JSON.stringify([snapshot.id, snapshot.local_commit, snapshot.worktree_generation, snapshot.draft_generation, snapshot.remote_commit ?? null]); }
function readKey(scope: WriterScope, snapshot: WriterSnapshot, path: string): string { return JSON.stringify([scopeKey(scope), snapshotKey(snapshot), path]); }
function idemKey(caller: WriterCaller, scope: WriterScope): string { return `${scopeKey(scope)}\u0000${caller.producer_plugin_id}\u0000${caller.action_id}\u0000${caller.idempotency_key}`; }
function sameSnapshot(a: WriterSnapshot, b: WriterSnapshot): boolean {
  return a.id === b.id && a.local_commit === b.local_commit && a.worktree_generation === b.worktree_generation && a.draft_generation === b.draft_generation && (a.remote_commit ?? null) === (b.remote_commit ?? null);
}
function sameScope(a: WriterScope, b: WriterScope): boolean {
  return a.workspace_id === b.workspace_id && a.repository_id === b.repository_id && a.branch === b.branch && a.generation === b.generation;
}
function resolvedRead(item: WriterReadRevision, baseScope: WriterScope, baseSnapshot: WriterSnapshot): { readonly scope: WriterScope; readonly snapshot: WriterSnapshot; readonly key: string; readonly isBase: boolean } {
  if ((item.scope === undefined) !== (item.snapshot === undefined)) fail("invalid_input", "Foreign read preconditions require both scope and snapshot.");
  const scope = item.scope ?? baseScope;
  const snapshot = item.snapshot ?? baseSnapshot;
  validateScope(scope);
  validateSnapshot(snapshot);
  return { scope, snapshot, key: readKey(scope, snapshot, item.path), isBase: sameScope(scope, baseScope) && sameSnapshot(snapshot, baseSnapshot) };
}
function cloneBytes(bytes: Uint8Array | null | undefined): Uint8Array | null | undefined { return bytes ? Uint8Array.from(bytes) : bytes; }

function canonicalJson(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 64) fail("invalid_input", "Source payload exceeds the JSON nesting limit.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("invalid_input", "Source payload cannot contain cycles.");
    seen.add(value);
    const result = `[${value.map(item => canonicalJson(item, depth + 1, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (record(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (seen.has(value)) fail("invalid_input", "Source payload cannot contain cycles.");
    seen.add(value);
    const result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, seen)}`).join(",")}}`;
    seen.delete(value);
    return result;
  }
  fail("invalid_input", "Source payload must contain JSON values only.");
}

function isCanonicalJson(value: unknown): boolean {
  try { canonicalJson(value); return true; }
  catch { return false; }
}

function validateScope(scope: WriterScope): void {
  if (!record(scope) || !onlyKeys(scope, ["workspace_id", "repository_id", "branch", "generation"]) || !text(scope.workspace_id, 256) || /[\u0000-\u001f\u007f]/u.test(scope.workspace_id) || !text(scope.branch, 1024) ||
      !/^[A-Za-z0-9._/-]+$/u.test(scope.branch) || scope.branch.startsWith("/") || scope.branch.endsWith("/") || scope.branch.includes("..") || scope.branch.includes("//") ||
      !text(scope.generation, 256) || /[\u0000-\u001f\u007f]/u.test(scope.generation) ||
      !(scope.repository_id === null || Number.isSafeInteger(scope.repository_id) && scope.repository_id > 0)) fail("invalid_input", "ChangeSet scope is invalid.");
}

function validateSnapshot(snapshot: WriterSnapshot): void {
  if (!record(snapshot) || !onlyKeys(snapshot, ["id", "local_commit", "worktree_generation", "draft_generation", "remote_commit"]) || !text(snapshot.id, 256) || /[\u0000-\u001f\u007f]/u.test(snapshot.id) || !text(snapshot.worktree_generation, 256) || /[\u0000-\u001f\u007f]/u.test(snapshot.worktree_generation) ||
      !(snapshot.local_commit === null || typeof snapshot.local_commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(snapshot.local_commit)) ||
      !(snapshot.draft_generation === null || text(snapshot.draft_generation, 256)) ||
      snapshot.remote_commit !== undefined && !(snapshot.remote_commit === null || typeof snapshot.remote_commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(snapshot.remote_commit))) fail("invalid_input", "ChangeSet snapshot is invalid.");
}

/** Converts the canonical JSON wire byte arrays before any writer validation. */
export function normalizeChangeSet(value: unknown): ChangeSet {
  if (!record(value) || !Array.isArray(value.units)) fail("invalid_input", "ChangeSet wire value must be an object with units.");
  const units = value.units.map(unit => {
    if (!record(unit) || !Array.isArray(unit.operations)) fail("invalid_input", "ChangeSet wire unit is invalid.");
    const operations = unit.operations.map(operation => {
      if (!record(operation)) fail("invalid_input", "ChangeSet wire operation is invalid.");
      const content = operation.content;
      if (content === undefined || content instanceof Uint8Array) return operation;
      if (!Array.isArray(content) || content.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        fail("invalid_input", "File operation content must be an array of byte values.");
      }
      return { ...operation, content: Uint8Array.from(content as number[]) };
    });
    return { ...unit, operations };
  });
  return { ...value, units } as unknown as ChangeSet;
}

function validatePath(path: string): void {
  try { validateGitPath(path); }
  catch { fail("invalid_path", `Unsafe ChangeSet path: ${String(path)}`); }
}

function validateChangeSet(set: ChangeSet, caller: WriterCaller, observedReads: readonly WriterReadRevision[]): void {
  if (!record(set) || !onlyKeys(set, ["id", "idempotency_key", "scope", "snapshot", "title", "reason", "read_set", "units", "evidence", "source_payload", "source_payload_digest", "domain_evidence"])) fail("invalid_input", "ChangeSet must be a closed object.");
  validateScope(set.scope);
  validateSnapshot(set.snapshot);
  validateScope(caller.scope);
  const hasSourcePayload = Object.hasOwn(set, "source_payload");
  const hasSourcePayloadDigest = Object.hasOwn(set, "source_payload_digest");
  if (!text(set.id, 256) || !text(set.idempotency_key, 256) || set.idempotency_key !== caller.idempotency_key ||
      !text(set.title, MAX_TITLE) || !text(set.reason, MAX_REASON) || !Array.isArray(set.read_set) || set.read_set.length > MAX_READ_SET ||
      !Array.isArray(set.units) || set.units.length === 0 || set.units.length > MAX_OPERATIONS || !Array.isArray(set.evidence) || set.evidence.length > MAX_EVIDENCE ||
      hasSourcePayload !== hasSourcePayloadDigest || hasSourcePayload && !isCanonicalJson(set.source_payload) || Object.hasOwn(set, "domain_evidence") && !isCanonicalJson(set.domain_evidence) ||
      hasSourcePayloadDigest && !validRevision(set.source_payload_digest)) {
    fail("invalid_input", "ChangeSet envelope is incomplete or exceeds Host limits.");
  }
  if (!onlyKeys(caller as unknown as Record<string, unknown>, ["caller", "producer_plugin_id", "action_id", "scope", "idempotency_key", "source_payload", "request_digest", "submitted_at"]) || !text(caller.producer_plugin_id, 128) || !/^[a-z][a-z0-9.-]{2,127}$/u.test(caller.producer_plugin_id) ||
      !text(caller.action_id, 256) || !caller.action_id.startsWith(`${caller.producer_plugin_id}.`) || caller.caller !== "ui" && caller.caller !== "mcp" && caller.caller !== "plugin" ||
      !text(caller.idempotency_key, 256) || !(caller.source_payload instanceof Uint8Array) || caller.source_payload.byteLength > MAX_SOURCE_PAYLOAD_BYTES ||
      !REVISION.test(caller.request_digest) || !text(caller.submitted_at, 64)) {
    fail("invalid_input", "Host action identity is invalid.");
  }
  if (!Array.isArray(observedReads) || observedReads.length > MAX_READ_SET) fail("invalid_input", "Observed Host read transcript exceeds limits.");

  const declared = new Map<string, string | null>();
  const localDeclared = new Map<string, string | null>();
  for (const item of set.read_set) {
    if (!record(item) || !onlyKeys(item, ["path", "revision", "scope", "snapshot"]) || !text(item.path, 1024) || !validRevision(item.revision)) fail("invalid_input", "ChangeSet read set contains an invalid entry.");
    validatePath(item.path);
    const read = item as unknown as WriterReadRevision;
    const resolved = resolvedRead(read, set.scope, set.snapshot);
    if (declared.has(resolved.key)) fail("invalid_input", `ChangeSet read set repeats ${item.path} in the same snapshot.`);
    declared.set(resolved.key, item.revision);
    if (resolved.isBase) {
      if (localDeclared.has(item.path)) fail("invalid_input", `ChangeSet read set repeats local path ${item.path}.`);
      localDeclared.set(item.path, item.revision);
    }
  }
  const observed = new Map<string, string | null>();
  for (const item of observedReads) {
    if (!record(item) || !onlyKeys(item, ["path", "revision", "scope", "snapshot"]) || !text(item.path, 1024) || !validRevision(item.revision)) fail("invalid_input", "Host read transcript contains an invalid entry.");
    validatePath(item.path);
    const read = item as unknown as WriterReadRevision;
    const resolved = resolvedRead(read, set.scope, set.snapshot);
    const prior = observed.get(resolved.key);
    if (observed.has(resolved.key) && prior !== item.revision) fail("snapshot_stale", `The Host observed conflicting revisions for ${item.path}.`);
    observed.set(resolved.key, item.revision);
  }
  if (observed.size !== declared.size || [...observed].some(([path, revision]) => declared.get(path) !== revision)) {
    fail("invalid_input", "ChangeSet must declare every file revision observed by the Host action.");
  }

  const unitIds = new Set<string>();
  const operationIds = new Set<string>();
  const operationPaths = new Set<string>();
  let operationCount = 0;
  let contentBytes = 0;
  const dependencyGraph = new Map<string, readonly string[]>();
  for (const unit of set.units) {
    if (!record(unit) || !onlyKeys(unit, ["id", "label", "depends_on", "operations", "source_operation_ids"]) || !text(unit.id, 128) || !text(unit.label, 240) || !Array.isArray(unit.depends_on) || !Array.isArray(unit.operations) || !unit.operations.length ||
        unit.source_operation_ids !== undefined && (!Array.isArray(unit.source_operation_ids) || unit.source_operation_ids.length > MAX_OPERATIONS || unit.source_operation_ids.some(item => !text(item, 128)))) {
      fail("invalid_input", "ChangeSet contains an invalid unit.");
    }
    if (unitIds.has(unit.id)) fail("invalid_input", `ChangeSet repeats unit ${unit.id}.`);
    unitIds.add(unit.id);
    dependencyGraph.set(unit.id, unit.depends_on);
    const unitPaths = new Set<string>();
    for (const dependency of unit.depends_on) {
      if (!text(dependency, 128) || dependency === unit.id || unit.depends_on.filter(item => item === dependency).length !== 1) fail("invalid_input", `Unit ${unit.id} has an invalid or duplicate dependency.`);
    }
    for (const operation of unit.operations) {
      operationCount += 1;
      if (operationCount > MAX_OPERATIONS || !operation || typeof operation !== "object" || !onlyKeys(operation as unknown as Record<string, unknown>, ["id", "kind", "path", "expected_revision", "content", "content_artifact"]) || !text(operation.id, 128) || !text(operation.path, 1024) ||
          operation.kind !== "create" && operation.kind !== "replace" && operation.kind !== "delete" || !validRevision(operation.expected_revision)) fail("invalid_input", `Unit ${unit.id} contains an invalid operation.`);
      validatePath(operation.path);
      if (operationIds.has(operation.id)) fail("invalid_input", `ChangeSet repeats operation ${operation.id}.`);
      operationIds.add(operation.id);
      if (unitPaths.has(operation.path) || operationPaths.has(operation.path)) fail("invalid_input", `Path ${operation.path} is written more than once; staged writes must be collapsed before proposal.`);
      unitPaths.add(operation.path);
      operationPaths.add(operation.path);
      const expected = operation.expected_revision;
      if (operation.kind === "create" && expected !== null || (operation.kind === "replace" || operation.kind === "delete") && expected === null) {
        fail("invalid_input", `Operation ${operation.id} has an invalid create/replace/delete precondition.`);
      }
      if (localDeclared.has(operation.path) && localDeclared.get(operation.path) !== expected) fail("invalid_input", `Read and write revisions disagree for ${operation.path}.`);
      if (!localDeclared.has(operation.path)) fail("invalid_input", `ChangeSet omitted the local write path ${operation.path} from its read set.`);
        const hasBytes = operation.content instanceof Uint8Array;
      const hasArtifact = typeof operation.content_artifact === "string" && operation.content_artifact.length > 0;
      if (operation.kind === "delete") {
        if (hasBytes || hasArtifact || operation.content !== undefined || operation.content_artifact !== undefined) fail("invalid_input", `Delete ${operation.id} cannot include content.`);
      } else {
        if (hasBytes === hasArtifact || operation.content !== undefined && !hasBytes || operation.content_artifact !== undefined && !hasArtifact) {
          fail("invalid_input", `Operation ${operation.id} requires exactly one byte content or sealed artifact.`);
        }
        if (operation.content instanceof Uint8Array) contentBytes += operation.content.byteLength;
      }
      if (contentBytes > MAX_CONTENT_BYTES) fail("invalid_input", "ChangeSet content exceeds the Host byte limit.");
    }
  }
  for (const [unitId, dependencies] of dependencyGraph) for (const dependency of dependencies) {
    if (!unitIds.has(dependency)) fail("invalid_input", `Unit ${unitId} depends on missing unit ${dependency}.`);
  }
  assertAcyclic(dependencyGraph);
  const unitOrder = new Map(set.units.map((unit, index) => [unit.id, index]));
  for (const [unitId, dependencies] of dependencyGraph) for (const dependency of dependencies) {
    if (unitOrder.get(dependency)! >= unitOrder.get(unitId)!) fail("invalid_input", `Dependency ${dependency} must appear before unit ${unitId}.`);
  }
  assertNoPathCollisions(localDeclared.keys());

  for (const item of set.evidence) {
    if (!record(item) || !onlyKeys(item, ["path", "revision", "start", "end", "quote"]) || !text(item.path, 1024) || !REVISION.test(String(item.revision)) || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
        (item.start as number) < 0 || (item.end as number) < (item.start as number) || !text(item.quote, 100_000)) fail("invalid_input", "ChangeSet evidence contains an invalid source span.");
    validatePath(item.path);
    const revision = localDeclared.get(item.path);
    if (revision !== item.revision) fail("snapshot_stale", `Evidence for ${item.path} does not match the declared read revision.`);
  }
}

function assertAcyclic(graph: ReadonlyMap<string, readonly string[]>): void {
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) fail("invalid_input", "ChangeSet unit dependencies contain a cycle.");
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    active.delete(id);
    done.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function assertNoPathCollisions(paths: Iterable<string>): void {
  const sorted = [...paths].sort();
  for (let i = 0; i + 1 < sorted.length; i += 1) if (sorted[i + 1]!.startsWith(`${sorted[i]!}/`)) fail("invalid_path", `File/directory path collision between ${sorted[i]} and ${sorted[i + 1]}.`);
}

function dependencyClosure(set: ChangeSet, requested: readonly string[]): Set<string> {
  const units = new Map(set.units.map(unit => [unit.id, unit]));
  const selected = new Set<string>();
  const visit = (id: string): void => {
    const unit = units.get(id);
    if (!unit) fail("invalid_input", `Unknown ChangeSet unit ${id}.`);
    if (selected.has(id)) return;
    selected.add(id);
    for (const dependency of unit.depends_on) visit(dependency);
  };
  for (const id of requested) visit(id);
  return selected;
}

function defaultState(state: WriterState | null | undefined): WriterState { return state ?? EMPTY_STATE; }
function event(state: WriterState, input: Omit<WriterReceiptEvent, "sequence">): WriterReceiptEvent {
  return Object.freeze({ ...input, sequence: state.sequence + 1 });
}
function pushEvent(state: WriterState, item: WriterReceiptEvent): WriterState {
  return Object.freeze({ ...state, sequence: item.sequence, events: Object.freeze([...state.events, item]) });
}
function assertUserApproval(caller: "ui" | "mcp" | "plugin", gesture: boolean): void {
  if (caller !== "ui" || gesture !== true) fail("capability_denied", "ChangeSet review and approval require an explicit Host UI gesture.");
}

interface PageCursor { readonly scope: string; readonly collection: string; readonly after: string; }
function encodeCursor(cursor: PageCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodeCursor(value: string | undefined, scope: WriterScope, collection: string): string | null {
  if (value === undefined) return null;
  if (!text(value, 1024)) fail("invalid_input", "Proposal cursor is invalid.");
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as PageCursor;
    if (!record(cursor) || cursor.scope !== scopeKey(scope) || cursor.collection !== collection || !text(cursor.after, 512)) fail("invalid_input", "Proposal cursor belongs to another scope or list.");
    return cursor.after;
  } catch (error) {
    if (error instanceof ChangeWriterError) throw error;
    fail("invalid_input", "Proposal cursor is malformed.");
  }
}

/** Host-owned proposal journal and the only plugin-facing path to BrowserLocalGit writes. */
export class ChangeWriter {
  private readonly now: () => string;

  constructor(private readonly dependencies: WriterDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /** Stable action timestamp persisted before it can be returned to a guest. */
  async timestamp(scope: WriterScope, pluginId: string, actionId: string, idempotencyKey: string): Promise<{ readonly timestamp: string }> {
    validateScope(scope);
    if (!text(pluginId, 128) || !/^[a-z][a-z0-9.-]{2,127}$/u.test(pluginId) || !text(actionId, 256) || !actionId.startsWith(`${pluginId}.`) || !text(idempotencyKey, 256)) {
      fail("invalid_input", "Timestamp request identity is invalid.");
    }
    const key = `${scopeKey(scope)}\u0000${pluginId}\u0000${actionId}\u0000${idempotencyKey}`;
    return this.dependencies.workspace.with_exclusive_writer(scope, () => this.dependencies.journal.transact(scope, currentValue => {
      const current = defaultState(currentValue);
      const existing = current.timestamps[key];
      if (existing) return { next: current, value: Object.freeze({ timestamp: existing }) };
      const timestamp = this.now();
      if (!text(timestamp, 64) || Number.isNaN(Date.parse(timestamp))) fail("storage_unknown", "Host clock returned an invalid timestamp.");
      return { next: Object.freeze({ ...current, timestamps: Object.freeze({ ...current.timestamps, [key]: timestamp }) }), value: Object.freeze({ timestamp }) };
    }));
  }

  async propose(set: ChangeSet, hostCaller: Omit<WriterCaller, "submitted_at">, observedReads: readonly WriterReadRevision[]): Promise<ProposalAdmission> {
    const caller: WriterCaller = Object.freeze({ ...hostCaller, source_payload: Uint8Array.from(hostCaller.source_payload), submitted_at: this.now() });
    validateChangeSet(set, caller, observedReads);
    if (!sameScope(set.scope, hostCaller.scope)) fail("invalid_input", "Proposal scope must equal the Host selected workspace scope.");
    const key = idemKey(caller, set.scope);
    return this.dependencies.workspace.with_exclusive_writer(set.scope, async () => {
      // Resolve a lost-response retry before consulting an ephemeral artifact lease.
      const existing = defaultState(await this.dependencies.journal.read(set.scope)).idempotency[key];
      if (existing) {
        if (existing.request_digest !== caller.request_digest) fail("idempotency_conflict", "This idempotency key already refers to a different ChangeSet.");
        const prior = (await this.dependencies.journal.read(set.scope)).proposals[existing.proposal_id];
        if (!prior) fail("storage_unknown", "The idempotency receipt points to a missing proposal.");
        return this.admission(prior);
      }
      await this.dependencies.workspace.assert_snapshot(set.scope, set.snapshot);
      await this.dependencies.workspace.assert_read_set(set.scope, set.snapshot, set.read_set);
      // Host takes ownership of sealed bytes before the proposal receipt is returned.
      const resolved = await this.resolveContents(set);
      await this.validateEvidence(set);
      const sourcePayload = set.source_payload === undefined ? Uint8Array.from(caller.source_payload) : new TextEncoder().encode(canonicalJson(set.source_payload));
      if (sourcePayload.byteLength > MAX_SOURCE_PAYLOAD_BYTES) fail("invalid_input", "Retained source payload exceeds the Host limit.");
      try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourcePayload)); }
      catch { fail("invalid_input", "Retained source payload must be valid UTF-8 JSON."); }
      const sourceDigest = await sha256Bytes(sourcePayload);
      if (set.source_payload_digest !== undefined && set.source_payload_digest !== sourceDigest) fail("invalid_input", "Source payload digest does not match its exact retained bytes.");
      const baseFiles: Record<string, Uint8Array | null> = {};
      for (const unit of resolved.units) for (const operation of unit.operations) {
        const before = await this.readExactSnapshot(set.scope, set.snapshot, operation.path);
        if (before.revision !== operation.expected_revision) fail("snapshot_stale", `Write path ${operation.path} no longer matches the proposal base.`);
        baseFiles[operation.id] = cloneBytes(before.bytes) ?? null;
      }
      const persisted = await this.dependencies.journal.transact(set.scope, currentValue => {
      const current = defaultState(currentValue);
      const previous = current.idempotency[key];
      if (previous) {
        if (previous.request_digest !== caller.request_digest) fail("idempotency_conflict", "This idempotency key already refers to a different ChangeSet.");
        const prior = current.proposals[previous.proposal_id];
        if (!prior) fail("storage_unknown", "The idempotency receipt points to a missing proposal.");
        return { next: current, value: prior };
      }
      const proposalId = this.dependencies.new_proposal_id();
      if (!text(proposalId, 256) || current.proposals[proposalId]) fail("storage_unknown", "Host proposal ID is invalid or already exists.");
      const ownedSet: ChangeSet = Object.freeze({ ...resolved, id: proposalId });
      const units = ownedSet.units.map(unit => Object.freeze({ id: unit.id, source_operation_ids: Object.freeze([...(unit.source_operation_ids ?? unit.operations.map(operation => operation.id))]), depends_on: Object.freeze([...unit.depends_on]), status: "pending" as const, resulting_revisions: Object.freeze([]) }));
      const proposal: PersistedProposal = Object.freeze({ set: ownedSet, caller, source_payload: Uint8Array.from(sourcePayload), base_files: Object.freeze(Object.fromEntries(Object.entries(baseFiles).map(([id, bytes]) => [id, cloneBytes(bytes) ?? null]))), record: Object.freeze({
        proposal_id: proposalId,
        producer_plugin_id: caller.producer_plugin_id,
        action_id: caller.action_id,
        scope: Object.freeze({ ...ownedSet.scope }),
        base_snapshot: Object.freeze({ ...ownedSet.snapshot }),
        latest_snapshot: Object.freeze({ ...ownedSet.snapshot }),
        status: "proposed",
        submitted_at: caller.submitted_at,
        approved_unit_ids: Object.freeze([]),
        units: Object.freeze(units),
        source_payload_digest: sourceDigest,
        checkpoint: Object.freeze({ local_commit: ownedSet.snapshot.local_commit, remote_commit: null, remote_confirmed: false as const }),
        source_payload_available: true as const,
      }) });
      const submitted = event(current, { at: caller.submitted_at, kind: "submitted", proposal_id: proposalId, snapshot: ownedSet.snapshot });
      const next = pushEvent(current, submitted);
      return { next: Object.freeze({ ...next, proposals: Object.freeze({ ...current.proposals, [proposalId]: proposal }), idempotency: Object.freeze({ ...current.idempotency, [key]: { request_digest: caller.request_digest, proposal_id: proposalId } }) }), value: proposal };
      });
      return this.admission(persisted);
    });
  }

  async reject(scope: WriterScope, proposalId: string, caller: "ui" | "mcp" | "plugin", userGesture: boolean): Promise<WriterProposalRecord> {
    assertUserApproval(caller, userGesture);
    return this.dependencies.workspace.with_exclusive_writer(scope, async () => this.updateProposal(scope, proposalId, (state, prior) => {
      if (prior.record.status !== "proposed" && prior.record.status !== "stale") fail("conflict", "Only an unapproved proposal can be rejected.");
      const recordValue: WriterProposalRecord = Object.freeze({ ...prior.record, status: "rejected" });
      const updated = Object.freeze({ ...prior, record: recordValue });
      const next = pushEvent(state, event(state, { at: this.now(), kind: "rejected", proposal_id: proposalId }));
      return { next: Object.freeze({ ...next, proposals: Object.freeze({ ...state.proposals, [proposalId]: updated }) }), value: recordValue };
    }));
  }

  async apply(scope: WriterScope, proposalId: string, requestedUnitIds: readonly string[], caller: "ui" | "mcp" | "plugin", userGesture: boolean): Promise<WriterProposalRecord> {
    assertUserApproval(caller, userGesture);
    if (!Array.isArray(requestedUnitIds) || requestedUnitIds.length === 0) fail("invalid_input", "Choose at least one complete ChangeSet unit.");
    return this.dependencies.workspace.with_exclusive_writer(scope, async () => {
      let persisted = await this.getProposal(scope, proposalId);
      if (persisted.record.status !== "proposed" && persisted.record.status !== "approved" && persisted.record.status !== "partially_applied" && persisted.record.status !== "failed") fail("conflict", `Proposal in ${persisted.record.status} state cannot be applied.`);
      if (!sameScope(persisted.record.scope, scope)) fail("invalid_input", "Proposal belongs to another workspace scope.");
      const closure = dependencyClosure(persisted.set, requestedUnitIds);
      const alreadyApplied = new Set(persisted.record.units.filter(unit => unit.status === "applied").map(unit => unit.id));
      for (const id of closure) if (alreadyApplied.has(id) && !requestedUnitIds.includes(id)) continue;
      const selected = persisted.set.units.filter(unit => closure.has(unit.id) && !alreadyApplied.has(unit.id));
      if (!selected.length) return persisted.record;

      try {
        await this.dependencies.workspace.assert_current(scope, persisted.record.latest_snapshot);
      } catch (error) {
        const code = errorCode(error);
        if (code === "dirty_draft") {
          await this.setStatus(scope, proposalId, "stale", { kind: "reviewed" });
          throw new ChangeWriterError("dirty_draft", errorMessage(error));
        }
        if (code === "storage_unknown") {
          await this.dependencies.workspace.block_writes(scope, "Workspace state is uncertain; resolve storage before applying a proposal.");
          throw new ChangeWriterError("storage_unknown", errorMessage(error));
        }
        await this.setStatus(scope, proposalId, "stale", { kind: "reviewed", error_code: "snapshot_stale" });
        throw new ChangeWriterError("snapshot_stale", errorMessage(error));
      }

      const completedPaths = new Map<string, string | null>();
      for (const receipt of persisted.record.units) if (receipt.status === "applied") for (const revision of receipt.resulting_revisions) completedPaths.set(revision.path, revision.revision);

      let anyFailure = false;
      for (const unit of selected) {
        try { await this.dependencies.workspace.assert_current(scope, persisted.record.latest_snapshot); }
        catch (error) {
          const code = errorCode(error);
          if (code === "dirty_draft") {
            await this.setStatus(scope, proposalId, "stale", { kind: "unit_failed", unit_id: unit.id, error_code: code });
            throw new ChangeWriterError("dirty_draft", errorMessage(error));
          }
          if (code === "storage_unknown") {
            await this.dependencies.workspace.block_writes(scope, "Workspace state is uncertain; resolve storage before applying a proposal.");
            throw new ChangeWriterError("storage_unknown", errorMessage(error));
          }
          await this.setStatus(scope, proposalId, "stale", { kind: "unit_failed", unit_id: unit.id, error_code: "snapshot_stale" });
          throw new ChangeWriterError("snapshot_stale", errorMessage(error));
        }
        const operations: StagedOperation[] = [];
        const changes: WorkspaceChange[] = [];
        const foreignReads = persisted.set.read_set.filter(read => !resolvedRead(read, persisted.set.scope, persisted.set.snapshot).isBase);
        try { await this.dependencies.workspace.assert_read_set(scope, persisted.record.latest_snapshot, foreignReads); }
        catch (error) {
          const code = errorCode(error);
          if (code === "snapshot_stale" || code === "dirty_draft") {
            await this.setStatus(scope, proposalId, "stale", { kind: "unit_failed", unit_id: unit.id, error_code: code });
          }
          throw new ChangeWriterError(code, errorMessage(error));
        }
        for (const operation of unit.operations) {
          const before = await this.readExact(scope, operation.path);
          const baseRevision = operation.expected_revision;
          if (before.revision !== (completedPaths.get(operation.path) ?? baseRevision)) {
            anyFailure = true;
            persisted = await this.finishUnit(scope, proposalId, unit.id, "failed", [], { code: "snapshot_stale", message: `File ${operation.path} changed after the proposal was reviewed.` });
            await this.setStatus(scope, proposalId, "stale", { kind: "reviewed", error_code: "snapshot_stale" });
            break;
          }
          const after = operation.content instanceof Uint8Array ? Uint8Array.from(operation.content) : null;
          const afterRevision = after ? await sha256Bytes(after) : null;
          operations.push(Object.freeze({
            path: operation.path,
            staging_path: `indexeddb://${encodeURIComponent(scopeKey(scope))}/${encodeURIComponent(proposalId)}/${encodeURIComponent(unit.id)}/${encodeURIComponent(operation.id)}`,
            before: cloneBytes(before.bytes) ?? null,
            before_revision: before.revision,
            after: after ? Uint8Array.from(after) : null,
            after_revision: afterRevision,
          }));
          changes.push({ path: operation.path, content: after, expectedRevision: { oid: before.storage_revision } });
        }
        if (anyFailure) break;
        const adjustedReadSet: FileRevisionExpectation[] = [];
        try {
          for (const read of persisted.set.read_set) {
            if (!resolvedRead(read, persisted.set.scope, persisted.set.snapshot).isBase) continue;
            const current = await this.readExact(scope, read.path);
            const expectedCanonical = completedPaths.has(read.path) ? completedPaths.get(read.path)! : read.revision;
            if (current.revision !== expectedCanonical) fail("snapshot_stale", `Read dependency ${read.path} changed after review.`);
            adjustedReadSet.push({ path: read.path, revision: { oid: current.storage_revision } });
          }
          for (const operation of unit.operations) if (!adjustedReadSet.some(read => read.path === operation.path)) {
            const current = await this.readExact(scope, operation.path);
            const expectedCanonical = completedPaths.get(operation.path) ?? operation.expected_revision;
            if (current.revision !== expectedCanonical) fail("snapshot_stale", `Write path ${operation.path} changed after review.`);
            adjustedReadSet.push({ path: operation.path, revision: { oid: current.storage_revision } });
          }
        } catch (error) {
          const code = errorCode(error);
          if (code === "snapshot_stale" || code === "dirty_draft") {
            anyFailure = true;
            await this.setStatus(scope, proposalId, "stale", { kind: "unit_failed", unit_id: unit.id, error_code: code });
            break;
          }
          if (code === "storage_unknown") {
            await this.dependencies.workspace.block_writes(scope, "A source read has uncertain storage state; verify storage before writing again.");
            throw new ChangeWriterError("storage_unknown", errorMessage(error));
          }
          throw error;
        }
        if (anyFailure) break;
        persisted = await this.beginUnit(scope, proposalId, unit.id, operations, [...new Set([...persisted.record.approved_unit_ids, ...closure])]);
        try {
          const results = await this.dependencies.workspace.apply_changes(scope, changes, adjustedReadSet, persisted.record.latest_snapshot);
          const resulting: WriterReadRevision[] = [];
          for (const operation of unit.operations) {
            const readBack = await this.readExact(scope, operation.path);
            const staged = operations.find(item => item.path === operation.path)!;
            if (readBack.revision !== staged.after_revision || !bytesEqual(readBack.bytes, staged.after)) {
              fail("storage_unknown", `Written bytes for ${operation.path} could not be verified against the approved ChangeSet.`);
            }
            const workerResult = results.find(result => result.path === operation.path);
            if (!workerResult || workerResult.revision.oid !== readBack.storage_revision) fail("storage_unknown", `The single writer returned no matching receipt for ${operation.path}.`);
            resulting.push(Object.freeze({ path: operation.path, revision: readBack.revision }));
          }
          persisted = await this.finishUnit(scope, proposalId, unit.id, "applied", resulting);
          for (const item of resulting) completedPaths.set(item.path, item.revision);
        } catch (error) {
          anyFailure = true;
          const code = errorCode(error);
          if (code === "storage_unknown") {
            await this.dependencies.workspace.block_writes(scope, "A proposal unit has an uncertain persisted result; recover the write-ahead receipt before another mutation.");
            await this.markWriteAheadUnknown(scope, proposalId, unit.id);
            await this.setStatus(scope, proposalId, "storage_unknown", { kind: "unit_failed", unit_id: unit.id, error_code: "storage_unknown" });
            throw new ChangeWriterError("storage_unknown", errorMessage(error));
          }
          persisted = await this.finishUnit(scope, proposalId, unit.id, "failed", [], { code, message: errorMessage(error) });
          if (code === "snapshot_stale" || code === "dirty_draft") await this.setStatus(scope, proposalId, "stale", { kind: "unit_failed", unit_id: unit.id, error_code: code });
          break;
        }
      }
      if (anyFailure) return (await this.getProposal(scope, proposalId)).record;
      return (await this.getProposal(scope, proposalId)).record;
    });
  }

  /** Reconcile a persisted write-ahead record before enabling any later writer. */
  async recover(scope: WriterScope): Promise<WriterProposalRecord | null> {
    return this.dependencies.workspace.with_exclusive_writer(scope, async () => {
      const state = defaultState(await this.dependencies.journal.read(scope));
      const journal = state.write_ahead;
      if (!journal || !sameScope(journal.scope, scope)) {
        const unresolved = Object.values(state.proposals).find(item => sameScope(item.record.scope, scope) && (item.record.status === "applying" || item.record.status === "storage_unknown"));
        if (unresolved) {
          await this.dependencies.workspace.block_writes(scope, "An applying proposal has no retained write-ahead journal.");
          fail("storage_unknown", "An applying proposal has no retained write-ahead journal.");
        }
        await this.dependencies.workspace.verify_storage(scope);
        await this.dependencies.workspace.unblock_writes(scope);
        return null;
      }
      const persisted = state.proposals[journal.proposal_id];
      if (!persisted) {
        await this.dependencies.workspace.block_writes(scope, "A write-ahead record has no matching retained proposal.");
        fail("storage_unknown", "A write-ahead record has no matching retained proposal.");
      }
      await this.dependencies.workspace.verify_storage(scope);
      const observed: Array<{ operation: StagedOperation; bytes: Uint8Array | null; revision: string | null; storage_revision: string | null }> = [];
      for (const operation of journal.operations) {
        const read = await this.readExact(scope, operation.path);
        if (read.revision !== operation.before_revision && read.revision !== operation.after_revision) {
          await this.markStorageUnknown(scope, persisted, journal, `File ${operation.path} matches neither saved write-ahead version.`);
          fail("storage_unknown", `File ${operation.path} matches neither saved write-ahead version.`);
        }
        if (read.revision === operation.before_revision && !bytesEqual(read.bytes, operation.before) ||
            read.revision === operation.after_revision && !bytesEqual(read.bytes, operation.after)) {
          await this.markStorageUnknown(scope, persisted, journal, `Bytes for ${operation.path} do not match their recorded revision.`);
          fail("storage_unknown", `Bytes for ${operation.path} do not match their recorded revision.`);
        }
        observed.push({ operation, bytes: read.bytes, revision: read.revision, storage_revision: read.storage_revision });
      }
      const allAfter = observed.every(item => item.revision === item.operation.after_revision && bytesEqual(item.bytes, item.operation.after));
      if (allAfter) {
        const resulting = observed.map(item => ({ path: item.operation.path, revision: item.revision }));
        await this.finishUnit(scope, journal.proposal_id, journal.unit_id, "applied", resulting, undefined, true);
        await this.dependencies.workspace.unblock_writes(scope);
        return (await this.getProposal(scope, journal.proposal_id)).record;
      }
      const allBefore = observed.every(item => item.revision === item.operation.before_revision && bytesEqual(item.bytes, item.operation.before));
      if (allBefore) {
        await this.resetInterruptedUnit(scope, journal.proposal_id, journal.unit_id);
        await this.dependencies.workspace.unblock_writes(scope);
        return (await this.getProposal(scope, journal.proposal_id)).record;
      }

      // The filesystem contains a proper subset of this unit. Restore only bytes
      // that still match our staged after-images. Any unrelated edit above failed closed.
      const restore: WorkspaceChange[] = [];
      const readSet: FileRevisionExpectation[] = [];
      for (const item of observed) {
        const live = observed.find(entry => entry.operation.path === item.operation.path)!;
        readSet.push({ path: item.operation.path, revision: { oid: live.storage_revision } });
        if (item.revision !== item.operation.before_revision) restore.push({ path: item.operation.path, content: cloneBytes(item.operation.before) ?? null, expectedRevision: { oid: live.storage_revision } });
      }
      try {
        const recoverySnapshot = await this.dependencies.workspace.current_snapshot(scope);
        const restored = await this.dependencies.workspace.apply_changes(scope, restore, readSet, recoverySnapshot, true);
        for (const item of observed) {
          const read = await this.readExact(scope, item.operation.path);
          if (read.revision !== item.operation.before_revision || !bytesEqual(read.bytes, item.operation.before)) {
            fail("storage_unknown", `Recovery could not restore original bytes for ${item.operation.path}.`);
          }
          if (item.revision !== item.operation.before_revision && !restored.some(result => result.path === item.operation.path && result.revision.oid === read.storage_revision)) {
            fail("storage_unknown", `Recovery received no matching single-writer receipt for ${item.operation.path}.`);
          }
        }
        await this.resetInterruptedUnit(scope, journal.proposal_id, journal.unit_id);
        await this.dependencies.workspace.unblock_writes(scope);
        return (await this.getProposal(scope, journal.proposal_id)).record;
      } catch (error) {
        await this.markStorageUnknown(scope, persisted, journal, errorMessage(error));
        await this.dependencies.workspace.block_writes(scope, "Partial unit recovery could not be confirmed; verify workspace storage before writing.");
        fail("storage_unknown", errorMessage(error));
      }
    });
  }

  async status(scope: WriterScope, proposalId: string): Promise<WriterProposalRecord> { return (await this.getProposal(scope, proposalId)).record; }
  async list(scope: WriterScope, cursor?: string, limit = 50, status?: ProposalState): Promise<{ readonly items: readonly WriterProposalRecord[]; readonly next_cursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_input", "Proposal page size must be from 1 to 100.");
    const after = decodeCursor(cursor, scope, "proposals");
    const state = defaultState(await this.dependencies.journal.read(scope));
    const ordered = Object.values(state.proposals)
      .filter(item => sameScope(item.record.scope, scope) && (!status || item.record.status === status))
      .map(item => item.record)
      .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.proposal_id.localeCompare(b.proposal_id))
      .filter(item => !after || `${item.submitted_at}\n${item.proposal_id}` > after);
    const items = ordered.slice(0, limit);
    const last = items.at(-1);
    return Object.freeze({ items: Object.freeze(items), next_cursor: ordered.length > limit && last
      ? encodeCursor({ scope: scopeKey(scope), collection: "proposals", after: `${last.submitted_at}\n${last.proposal_id}` }) : null });
  }
  async events(scope: WriterScope, proposalId: string): Promise<readonly WriterReceiptEvent[]> {
    await this.getProposal(scope, proposalId);
    return defaultState(await this.dependencies.journal.read(scope)).events.filter(item => item.proposal_id === proposalId);
  }
  async observations(scope: WriterScope, proposalId: string, cursor?: string, limit = 50): Promise<{ readonly items: readonly WriterReceiptEvent[]; readonly next_cursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_input", "Receipt page size must be from 1 to 100.");
    await this.getProposal(scope, proposalId);
    const collection = `events:${proposalId}`;
    const after = decodeCursor(cursor, scope, collection);
    if (after !== null && (!/^\d+$/u.test(after) || !Number.isSafeInteger(Number(after)))) fail("invalid_input", "Receipt cursor sequence is invalid.");
    const state = defaultState(await this.dependencies.journal.read(scope));
    const allEvents = state.events.filter(item => item.proposal_id === proposalId && (!after || item.sequence > Number(after)));
    const items = allEvents.slice(0, limit);
    const last = items.at(-1);
    return Object.freeze({ items: Object.freeze(items), next_cursor: allEvents.length > limit && last
      ? encodeCursor({ scope: scopeKey(scope), collection, after: String(last.sequence) }) : null });
  }
  async inspect(scope: WriterScope, proposalId: string, cursor?: string, limit = 20, includeSource = false): Promise<ProposalInspection> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail("invalid_input", "Proposal inspection page size must be from 1 to 50.");
    const proposal = await this.getProposal(scope, proposalId);
    const collection = `inspect:${proposalId}`;
    const after = decodeCursor(cursor, scope, collection);
    const offset = after === null ? 0 : Number(after);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > proposal.set.units.length) fail("invalid_input", "Proposal inspection cursor is invalid.");
    const page = proposal.set.units.slice(offset, offset + limit);
    const units = await Promise.all(page.map(unit => this.previewUnit(proposal, unit)));
    return Object.freeze({
      proposal_id: proposalId,
      status: proposal.record.status,
      title: proposal.set.title,
      reason: proposal.set.reason,
      read_set: proposal.set.read_set,
      units: Object.freeze(units),
      evidence: proposal.set.evidence,
      ...(proposal.set.domain_evidence === undefined ? {} : { domain_evidence: proposal.set.domain_evidence }),
      source_payload_available: proposal.record.source_payload_available,
      source_payload_digest: proposal.record.source_payload_digest,
      ...(includeSource && proposal.source_payload.byteLength <= 128 * 1024 ? { source_payload: Uint8Array.from(proposal.source_payload) } : {}),
      ...(includeSource && proposal.source_payload.byteLength > 128 * 1024 ? { source_ref: `source:${proposalId}` } : {}),
      next_cursor: offset + page.length < proposal.set.units.length
        ? encodeCursor({ scope: scopeKey(scope), collection, after: String(offset + page.length) }) : null,
    });
  }

  async read_content(scope: WriterScope, proposalId: string, contentRef: string, offset = 0, length = 65_536): Promise<ProposalContentChunk> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024) fail("invalid_input", "Proposal content byte range is invalid.");
    const proposal = await this.getProposal(scope, proposalId);
    let bytes: Uint8Array | undefined;
    if (contentRef === `source:${proposalId}`) bytes = proposal.source_payload;
    for (const unit of proposal.set.units) for (const operation of unit.operations) {
      if (contentRef === `content:${unit.id}:${operation.id}` && operation.content instanceof Uint8Array) bytes = operation.content;
      if (contentRef === `before:${unit.id}:${operation.id}`) bytes = proposal.base_files[operation.id] ?? undefined;
    }
    if (!bytes) fail("file_not_found", "Proposal content reference does not exist.");
    if (offset > bytes.byteLength) fail("invalid_input", "Proposal content offset exceeds the byte length.");
    const end = Math.min(bytes.byteLength, offset + length);
    return Object.freeze({ offset, total_bytes: bytes.byteLength, bytes: bytes.slice(offset, end), next_offset: end < bytes.byteLength ? end : null, sha256: await sha256Bytes(bytes) });
  }

  private async resolveContents(set: ChangeSet): Promise<ChangeSet> {
    let count = 0;
    const units: WriterUnit[] = [];
    for (const unit of set.units) {
      const operations: WriterOperation[] = [];
      for (const operation of unit.operations) {
        let content = cloneBytes(operation.content);
        if (operation.content_artifact !== undefined) {
          if (!this.dependencies.resolve_artifact) fail("dependency_unavailable", "Host artifact read capability is unavailable.");
          content = Uint8Array.from(await this.dependencies.resolve_artifact(set.scope, set.snapshot, operation.content_artifact));
        }
        if (content) count += content.byteLength;
        if (count > MAX_CONTENT_BYTES) fail("invalid_input", "Sealed ChangeSet content exceeds the Host byte limit.");
        operations.push(Object.freeze({ id: operation.id, kind: operation.kind, path: operation.path, expected_revision: operation.expected_revision, ...(content ? { content } : {}) }));
      }
      units.push(Object.freeze({ ...unit, depends_on: Object.freeze([...unit.depends_on]), operations: Object.freeze(operations) }));
    }
    return Object.freeze({ ...set, scope: Object.freeze({ ...set.scope }), snapshot: Object.freeze({ ...set.snapshot }), read_set: Object.freeze(set.read_set.map(item => Object.freeze({ ...item }))), units: Object.freeze(units), evidence: Object.freeze(set.evidence.map(item => Object.freeze({ ...item }))) });
  }

  private async validateEvidence(set: ChangeSet): Promise<void> {
    for (const span of set.evidence) {
      const source = await this.readExactSnapshot(set.scope, set.snapshot, span.path);
      if (!source.bytes || source.revision !== span.revision) fail("snapshot_stale", `Evidence source ${span.path} is missing or stale.`);
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes); }
      catch { fail("invalid_encoding", `Evidence source ${span.path} is not valid UTF-8.`); }
      if (span.end > content.length || content.slice(span.start, span.end) !== span.quote) fail("invalid_input", `Evidence quote does not match UTF-16 source span ${span.path}:${span.start}-${span.end}.`);
    }
  }

  private async admission(proposal: PersistedProposal): Promise<ProposalAdmission> {
    return Object.freeze({ proposal_id: proposal.record.proposal_id, preview: await this.preview(proposal), status: proposal.record.status });
  }

  private async preview(proposal: PersistedProposal): Promise<ProposalPreview> {
    const units = await Promise.all(proposal.set.units.map(unit => this.previewUnit(proposal, unit)));
    return Object.freeze({
      title: proposal.set.title,
      reason: proposal.set.reason,
      scope: proposal.set.scope,
      snapshot: proposal.set.snapshot,
      read_set: proposal.set.read_set,
      units: Object.freeze(units),
      evidence: proposal.set.evidence,
      ...(proposal.set.domain_evidence === undefined ? {} : { domain_evidence: proposal.set.domain_evidence }),
      source_payload_digest: proposal.record.source_payload_digest,
    });
  }

  private async previewUnit(proposal: PersistedProposal, unit: WriterUnit): Promise<ProposalPreview["units"][number]> {
    const operations = await Promise.all(unit.operations.map(async operation => {
      if (!Object.hasOwn(proposal.base_files, operation.id)) fail("storage_unknown", `Proposal lost its base bytes for ${operation.path}.`);
      const before = proposal.base_files[operation.id]!;
      return Object.freeze({
        id: operation.id,
        kind: operation.kind,
        path: operation.path,
        expected_revision: operation.expected_revision,
        before_hash: before ? await sha256Bytes(before) : null,
        ...(before ? { before_content_ref: `before:${unit.id}:${operation.id}` } : {}),
        ...(operation.content instanceof Uint8Array ? { content_ref: `content:${unit.id}:${operation.id}` } : {}),
        after_hash: operation.content instanceof Uint8Array ? await sha256Bytes(operation.content) : null,
      });
    }));
    return Object.freeze({
      id: unit.id,
      label: unit.label,
      depends_on: unit.depends_on,
      ...(unit.source_operation_ids ? { source_operation_ids: unit.source_operation_ids } : {}),
      operations: Object.freeze(operations),
    });
  }

  private async readExact(scope: WriterScope, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null; readonly storage_revision: string | null }> {
    let result: Awaited<ReturnType<WriterWorkspacePort["read"]>>;
    try { result = await this.dependencies.workspace.read(scope, path); }
    catch (error) {
      if (errorCode(error) === "storage_unknown") await this.dependencies.workspace.block_writes(scope, "A scoped file read has uncertain storage state.");
      throw error;
    }
    const digest = result.bytes ? await sha256Bytes(result.bytes) : null;
    if (digest !== result.revision || (result.bytes === null) !== (result.storage_revision === null)) {
      await this.dependencies.workspace.block_writes(scope, "A scoped file read has bytes or revision metadata that do not match.");
      fail("storage_unknown", `Host read for ${path} has bytes or revision metadata that do not match.`);
    }
    return result;
  }

  private async readExactSnapshot(scope: WriterScope, snapshot: WriterSnapshot, path: string): Promise<{ readonly bytes: Uint8Array | null; readonly revision: string | null }> {
    try {
      if (this.dependencies.workspace.read_snapshot) return await this.dependencies.workspace.read_snapshot(scope, snapshot, path);
      const result = await this.dependencies.workspace.read(scope, path);
      return { bytes: result.bytes, revision: result.revision };
    } catch (error) {
      if (errorCode(error) === "storage_unknown") await this.dependencies.workspace.block_writes(scope, "A pinned source read has uncertain storage state.");
      throw error;
    }
  }

  private async getProposal(scope: WriterScope, proposalId: string): Promise<PersistedProposal> {
    const state = defaultState(await this.dependencies.journal.read(scope));
    const proposal = state.proposals[proposalId];
    if (!proposal || !sameScope(proposal.record.scope, scope)) fail("file_not_found", "Proposal does not exist in this workspace scope.");
    return proposal;
  }

  private async updateProposal<T>(scope: WriterScope, proposalId: string, update: (state: WriterState, proposal: PersistedProposal) => { readonly next: WriterState; readonly value: T }): Promise<T> {
    return this.dependencies.journal.transact(scope, currentValue => {
      const current = defaultState(currentValue);
      const proposal = current.proposals[proposalId];
      if (!proposal || !sameScope(proposal.record.scope, scope)) fail("file_not_found", "Proposal does not exist in this workspace scope.");
      return update(current, proposal);
    });
  }

  private async beginUnit(scope: WriterScope, proposalId: string, unitId: string, operations: readonly StagedOperation[], approved: readonly string[]): Promise<PersistedProposal> {
    await this.dependencies.journal.transact(scope, currentValue => {
      const state = defaultState(currentValue);
      if (state.write_ahead) fail("storage_unknown", "Another write-ahead unit must be recovered before applying changes.");
      const proposal = state.proposals[proposalId];
      if (!proposal || !proposal.record.units.some(unit => unit.id === unitId)) fail("storage_unknown", "Proposal unit disappeared before it could be staged.");
      const recordValue: UnitWriteAheadRecord = Object.freeze({ proposal_id: proposalId, unit_id: unitId, scope: Object.freeze({ ...scope }), phase: "applying", operations: Object.freeze(operations.map(item => Object.freeze({ ...item, before: cloneBytes(item.before) ?? null, after: cloneBytes(item.after) ?? null }))), created_at: this.now() });
      const units = proposal.record.units.map(unit => unit.id === unitId ? Object.freeze({ ...unit, status: "applying" as const }) : unit);
      const updatedProposal = Object.freeze({ ...proposal, record: Object.freeze({ ...proposal.record, status: "applying" as const, approved_unit_ids: Object.freeze([...approved]), units: Object.freeze(units) }) });
      const reviewed = proposal.record.approved_unit_ids.length === 0
        ? pushEvent(state, event(state, { at: recordValue.created_at, kind: "reviewed", proposal_id: proposalId }))
        : state;
      const next = pushEvent(reviewed, event(reviewed, { at: recordValue.created_at, kind: "apply_started", proposal_id: proposalId, unit_id: unitId }));
      return { next: Object.freeze({ ...next, write_ahead: recordValue, proposals: Object.freeze({ ...state.proposals, [proposalId]: updatedProposal }) }), value: updatedProposal };
    });
    return this.getProposal(scope, proposalId);
  }

  private async finishUnit(scope: WriterScope, proposalId: string, unitId: string, status: UnitState, resulting: readonly WriterReadRevision[], failure?: { readonly code: WriterErrorCode; readonly message: string }, recovered = false): Promise<PersistedProposal> {
    const latestSnapshot = status === "applied" ? await this.dependencies.workspace.current_snapshot(scope) : undefined;
    return this.dependencies.journal.transact(scope, currentValue => {
      const state = defaultState(currentValue);
      const prior = state.proposals[proposalId];
      if (!prior || !sameScope(prior.record.scope, scope)) fail("storage_unknown", "Proposal disappeared while applying its receipt.");
      const units = prior.record.units.map(unit => unit.id === unitId ? Object.freeze({ ...unit, status, resulting_revisions: Object.freeze([...resulting]), ...(failure ? { failure: Object.freeze({ ...failure }) } : {}) }) : unit);
      if (!units.some(unit => unit.id === unitId)) fail("storage_unknown", "The write-ahead unit is not present in its proposal receipt.");
      const allApprovedDone = prior.record.approved_unit_ids.every(id => units.find(unit => unit.id === id)?.status === "applied");
      const allProposalDone = units.every(unit => unit.status === "applied");
      const nextStatus: ProposalState = status === "failed" ? "partially_applied" : allApprovedDone ? (allProposalDone ? "applied" : "partially_applied") : "approved";
      const recordValue: WriterProposalRecord = Object.freeze({ ...prior.record, ...(latestSnapshot ? { latest_snapshot: latestSnapshot } : {}), status: nextStatus, units: Object.freeze(units) });
      const proposal = Object.freeze({ ...prior, record: recordValue });
      const item = event(state, { at: this.now(), kind: status === "applied" ? (recovered ? "recovered" : "unit_completed") : "unit_failed", proposal_id: proposalId, unit_id: unitId, resulting_revisions: resulting, ...(failure ? { error_code: failure.code } : {}) });
      const next = pushEvent(state, item);
      return { next: Object.freeze({ ...next, proposals: Object.freeze({ ...state.proposals, [proposalId]: proposal }), write_ahead: null }), value: proposal };
    });
  }

  private async resetInterruptedUnit(scope: WriterScope, proposalId: string, unitId: string): Promise<void> {
    const latestSnapshot = await this.dependencies.workspace.current_snapshot(scope);
    await this.dependencies.journal.transact(scope, currentValue => {
      const state = defaultState(currentValue);
      const prior = state.proposals[proposalId];
      if (!prior) fail("storage_unknown", "Proposal disappeared during recovery.");
      const units = prior.record.units.map(unit => unit.id === unitId ? Object.freeze({ ...unit, status: "pending" as const, resulting_revisions: Object.freeze([]) }) : unit);
      const remainingStatus = units.some(unit => unit.status === "applied") ? "partially_applied" as const : "proposed" as const;
      const proposal = Object.freeze({ ...prior, record: Object.freeze({ ...prior.record, latest_snapshot: latestSnapshot, status: remainingStatus, units: Object.freeze(units) }) });
      const item = event(state, { at: this.now(), kind: "recovered", proposal_id: proposalId, unit_id: unitId });
      const next = pushEvent(state, item);
      return { next: Object.freeze({ ...next, proposals: Object.freeze({ ...state.proposals, [proposalId]: proposal }), write_ahead: null }), value: undefined };
    });
  }

  private async markWriteAheadUnknown(scope: WriterScope, proposalId: string, unitId: string): Promise<void> {
    await this.dependencies.journal.transact(scope, currentValue => {
      const state = defaultState(currentValue);
      if (!state.write_ahead || state.write_ahead.proposal_id !== proposalId || state.write_ahead.unit_id !== unitId) fail("storage_unknown", "Write-ahead receipt is missing.");
      return { next: Object.freeze({ ...state, write_ahead: Object.freeze({ ...state.write_ahead, phase: "storage_unknown" }) }), value: undefined };
    });
  }

  private async markStorageUnknown(scope: WriterScope, prior: PersistedProposal, journal: UnitWriteAheadRecord, message: string): Promise<void> {
    await this.dependencies.journal.transact(scope, currentValue => {
      const state = defaultState(currentValue);
      const current = state.proposals[prior.record.proposal_id];
      if (!current) fail("storage_unknown", message);
      const updated = Object.freeze({ ...current, record: Object.freeze({ ...current.record, status: "storage_unknown" as const }) });
      const item = event(state, { at: this.now(), kind: "unit_failed", proposal_id: journal.proposal_id, unit_id: journal.unit_id, error_code: "storage_unknown" });
      const next = pushEvent(state, item);
      return { next: Object.freeze({ ...next, proposals: Object.freeze({ ...state.proposals, [journal.proposal_id]: updated }), write_ahead: Object.freeze({ ...journal, phase: "storage_unknown" }) }), value: undefined };
    });
  }

  private async setStatus(scope: WriterScope, proposalId: string, status: ProposalState, receipt: Omit<WriterReceiptEvent, "sequence" | "at" | "proposal_id"> & { readonly kind: WriterReceiptEvent["kind"] }): Promise<WriterProposalRecord> {
    return this.updateProposal(scope, proposalId, (state, proposal) => {
      const recordValue = Object.freeze({ ...proposal.record, status });
      const updated = Object.freeze({ ...proposal, record: recordValue });
      const nextEvent = event(state, { ...receipt, at: this.now(), proposal_id: proposalId });
      const next = pushEvent(state, nextEvent);
      return { next: Object.freeze({ ...next, proposals: Object.freeze({ ...state.proposals, [proposalId]: updated }) }), value: recordValue };
    });
  }
}

function errorCode(error: unknown): WriterErrorCode {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "conflict";
  if (code === "revision_conflict") return "snapshot_stale";
  if (["invalid_input", "invalid_path", "snapshot_stale", "dirty_draft", "conflict", "capability_denied", "dependency_unavailable", "idempotency_conflict", "storage_unknown", "file_not_found", "capacity"].includes(code)) return code as WriterErrorCode;
  return "conflict";
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
