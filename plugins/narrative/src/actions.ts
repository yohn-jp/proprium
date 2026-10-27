import { normalizeUnicode } from "../../shared/unicode.js";
import { stringify } from "yaml";
import type {
  ActionRequest,
  ChangeSet,
  ChangeUnit,
  Diagnostic,
  FileOperation,
  NarrativeHost,
  ProposalValue,
  Scope,
  Snapshot,
  StructureKind,
  StructureRow,
} from "./contracts.js";
import { fail } from "./errors.js";
import { sha256Hex } from "./hash.js";
import type { HostCall } from "../../shared/guest.js";
import {
  appendYamlSequenceValue,
  parseYamlRecord,
  removeYamlSequenceIndex,
  updateYamlFields,
} from "./yaml-source.js";
import { readWorkSnapshot, validateManuscriptPath, type MetadataFile, type WorkSnapshot } from "./workspace.js";
import { compileNarrativeChanges } from "./change-compiler.js";
import { listPortableResumeMarks, proposePortableResumeMark } from "./resume.js";

export const NARRATIVE_ACTIONS = [
  "proprium.narrative.work.detect",
  "proprium.narrative.hierarchy.tree",
  "proprium.narrative.hierarchy.outline",
  "proprium.narrative.scene.open",
  "proprium.narrative.scene.continue",
  "proprium.narrative.scene.context",
  "proprium.narrative.structure.create",
  "proprium.narrative.structure.update",
  "proprium.narrative.structure.reorder",
  "proprium.narrative.reading-marks.list",
  "proprium.narrative.reading-marks.create",
  "proprium.narrative.reading-marks.delete",
  "proprium.narrative.changes.compile",
  "proprium.narrative.resume.marks.list",
  "proprium.narrative.resume.mark.propose",
] as const;

type ActionId = typeof NARRATIVE_ACTIONS[number];
type ReadSnapshot = ReturnType<typeof readWorkSnapshot> extends Generator<HostCall, infer T, unknown> ? T : never;

const TREE_LIMIT = 128;
const READ_CHUNK = 65_536;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MARK_REQUIRED = ["id", "offset", "length", "snippet", "createdAt"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label = "input"): Record<string, unknown> {
  if (!isRecord(value)) fail("invalid_input", `${label} must be an object`);
  return value;
}

function strictObject(value: unknown, required: string[], optional: string[] = [], label = "input"): Record<string, unknown> {
  const row = object(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(row)) if (!allowed.has(key)) fail("invalid_input", `Unknown ${label} field: ${key}`);
  for (const key of required) if (!(key in row)) fail("invalid_input", `Missing ${label} field: ${key}`);
  return row;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail("invalid_input", `${name} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail("invalid_input", `${name} must be a positive integer`);
  return value as number;
}

function validateEnvelope(request: ActionRequest): void {
  if (!request || request.plugin_id !== "proprium.narrative" || request.schema_version !== 1 ||
      typeof request.request_id !== "string" || !request.request_id || typeof request.action_id !== "string" ||
      !request.scope || !request.snapshot || !request.input || !Number.isInteger(request.deadline_ms) || request.deadline_ms < 1) {
    fail("invalid_input", "Narrative ActionRequest envelope is invalid");
  }
  if (typeof request.scope.workspace_id !== "string" || !request.scope.workspace_id || typeof request.scope.generation !== "string" || !request.scope.generation ||
      typeof request.scope.branch !== "string" || !request.scope.branch || !(request.scope.repository_id === null ||
        Number.isSafeInteger(request.scope.repository_id) && request.scope.repository_id > 0) ||
      typeof request.snapshot.id !== "string" || !request.snapshot.id || typeof request.snapshot.worktree_generation !== "string") {
    fail("invalid_input", "Narrative scope or snapshot is invalid");
  }
}

function validateAction(action: string): asserts action is ActionId {
  if (!(NARRATIVE_ACTIONS as readonly string[]).includes(action)) fail("invalid_input", `Unknown Narrative action: ${action}`);
}

function makeWorkId(scope: Scope): string {
  return scope.repository_id === null ? `workspace:${scope.workspace_id}` : `github:${scope.repository_id}`;
}

function compareRows(a: StructureRow, b: StructureRow): number {
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
  if (a.order !== undefined && b.order === undefined) return -1;
  if (a.order === undefined && b.order !== undefined) return 1;
  return a.metadata_path < b.metadata_path ? -1 : a.metadata_path > b.metadata_path ? 1 : a.id.localeCompare(b.id);
}

function treeCursor(snapshot: Snapshot, parentId: string | null, revision: string, offset: number): string {
  return `nar1|${encodeURIComponent(snapshot.id)}|${parentId === null ? "~" : encodeURIComponent(parentId)}|${revision}|${offset}`;
}

function parseTreeCursor(value: string, snapshot: Snapshot, parentId: string | null, revision: string): number {
  const parts = value.split("|");
  if (parts.length !== 5 || parts[0] !== "nar1" || decodeURIComponent(parts[1]!) !== snapshot.id ||
      (parts[2] === "~" ? null : decodeURIComponent(parts[2]!)) !== parentId || parts[3] !== revision ||
      !/^\d+$/u.test(parts[4]!)) {
    fail("snapshot_stale", "Hierarchy cursor does not match this pinned tree");
  }
  const offset = Number(parts[4]);
  if (!Number.isSafeInteger(offset)) fail("invalid_input", "Hierarchy cursor offset is invalid");
  return offset;
}

function treeRows(snapshot: ReadSnapshot, parentId: string | null): StructureRow[] {
  if (parentId === null) {
    if (snapshot.status === "malformed") fail("unsupported_format", "Hierarchy paths exist, but there is no usable volume root", {
      diagnostics: snapshot.diagnostics.map((item) => ({ ...item })),
    });
    return snapshot.volumes;
  }
  const parent = snapshot.byId.get(parentId);
  if (!parent) {
    if (snapshot.duplicatePaths.has(parentId)) fail("ambiguous_identity", `Hierarchy parent ${parentId} is ambiguous`, { paths: snapshot.duplicatePaths.get(parentId) });
    fail("scene_not_found", `Hierarchy parent ${parentId} was not found`);
  }
  if (parent.kind === "volume") return snapshot.chapters.filter((row) => row.parent_id === parent.id);
  if (parent.kind === "chapter") return snapshot.scenes.filter((row) => row.parent_id === parent.id);
  fail("invalid_input", "Scenes cannot be hierarchy parents");
}

function treeItem(row: StructureRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    ...(row.order === undefined ? {} : { order: row.order }),
    parent_id: row.parent_id,
    metadata_path: row.metadata_path,
    metadata_revision: row.metadata_revision,
    ...(row.manuscript_path ? { manuscript_path: row.manuscript_path } : {}),
  };
}

function assertTreeRevision(input: Record<string, unknown>, snapshot: ReadSnapshot): void {
  if (input.expected_tree_revision !== undefined && input.expected_tree_revision !== snapshot.treeRevision) {
    fail("snapshot_stale", "Hierarchy changed after the requested tree revision", { expected: input.expected_tree_revision, actual: snapshot.treeRevision });
  }
}

export function* readTextFile(host: NarrativeHost, request: ActionRequest, path: string, allowMissing = false): Generator<HostCall, { text: string; revision: string | null; byteLength: number }, unknown> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let revision: string | null = null;
  let totalBytes: number | null = null;
  while (true) {
    let chunk: import("./contracts.js").ReadChunk;
    try {
      chunk = yield* host.request<import("./contracts.js").ReadChunk>("workspace.file.read", {
        snapshot: request.snapshot, path, offset, length: READ_CHUNK,
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (allowMissing && code === "file_not_found") return { text: "", revision: null, byteLength: 0 };
      if (code === "file_not_found") fail("file_not_found", `Linked manuscript is missing: ${path}`, { path });
      throw error;
    }
    if (revision === null) {
      revision = chunk.revision;
      totalBytes = chunk.total_bytes;
    }
    if (chunk.revision !== revision || chunk.offset !== offset || chunk.total_bytes !== totalBytes ||
        !(chunk.bytes instanceof Uint8Array || Array.isArray(chunk.bytes))) {
      fail("snapshot_stale", `File changed during pinned read: ${path}`, { path });
    }
    const bytes = chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes);
    chunks.push(bytes);
    const next = offset + bytes.length;
    if (chunk.next_offset === null) {
      if (next !== totalBytes) fail("invalid_input", `Host ended a partial file read: ${path}`, { path });
      break;
    }
    if (chunk.next_offset !== next || next <= offset || next > totalBytes!) fail("invalid_input", `Host file read did not advance: ${path}`, { path });
    offset = chunk.next_offset;
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    fail("invalid_encoding", `File is not valid UTF-8: ${path}`, { path, cause: String(error) });
  }
  return { text, revision, byteLength: totalBytes ?? 0 };
}

export function* readFileRevision(host: NarrativeHost, request: ActionRequest, path: string): Generator<HostCall, string, unknown> {
  let chunk: import("./contracts.js").ReadChunk;
  try {
    chunk = yield* host.request<import("./contracts.js").ReadChunk>("workspace.file.read", {
      snapshot: request.snapshot, path, offset: 0, length: 1,
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "file_not_found") fail("file_not_found", `Linked manuscript is missing: ${path}`, { path });
    throw error;
  }
  const bytes = chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes);
  if (chunk.offset !== 0 || chunk.total_bytes < 0 || bytes.length > 1 ||
      chunk.next_offset !== null && chunk.next_offset !== bytes.length ||
      chunk.next_offset === null && bytes.length !== chunk.total_bytes) {
    fail("invalid_input", `Host returned an invalid revision probe for ${path}`, { path });
  }
  return chunk.revision;
}

export function* pathExists(host: NarrativeHost, request: ActionRequest, path: string): Generator<HostCall, boolean, unknown> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: import("./contracts.js").FilePage = yield* host.request<import("./contracts.js").FilePage>("workspace.file.list", {
      snapshot: request.snapshot, prefix: path, cursor, limit: 256,
    });
    if (!page || !Array.isArray(page.entries) || page.entries.length > 256) fail("invalid_input", "Host returned an invalid path listing");
    if (page.entries.some((entry) => entry.path === path)) return true;
    const next: string | null = page.next_cursor;
    if (next !== null && (typeof next !== "string" || !next || seen.has(next))) fail("invalid_input", "Host path listing cursor did not advance");
    if (next !== null) seen.add(next);
    cursor = next;
  } while (cursor !== null);
  return false;
}

function sceneFor(snapshot: ReadSnapshot, sceneId: string): { scene: StructureRow; chapter: StructureRow; volume: StructureRow; metadata: MetadataFile } {
  if (snapshot.duplicatePaths.has(sceneId)) fail("ambiguous_identity", `Scene ${sceneId} is ambiguous`, { paths: snapshot.duplicatePaths.get(sceneId) });
  const scene = snapshot.byId.get(sceneId);
  if (!scene || scene.kind !== "scene") fail("scene_not_found", `Scene ${sceneId} was not found`);
  const chapter = scene.parent_id ? snapshot.byId.get(scene.parent_id) : undefined;
  const metadata = snapshot.files.get(scene.metadata_path);
  const volumeId = metadata?.raw.volume;
  const volume = typeof volumeId === "string" ? snapshot.byId.get(volumeId) : undefined;
  if (!chapter || chapter.kind !== "chapter" || !volume || volume.kind !== "volume" || !metadata) {
    fail("invalid_parent", `Scene ${sceneId} has no valid volume/chapter path`, { path: scene.metadata_path });
  }
  return { scene, chapter, volume, metadata };
}

function* sceneContext(host: NarrativeHost, request: ActionRequest, input: Record<string, unknown>, snapshot: ReadSnapshot): Generator<HostCall, {
  scene: StructureRow;
  chapter: StructureRow;
  volume: StructureRow;
  manuscript_path: string;
  manuscript_revision: string;
}, unknown> {
  const sceneId = nonEmptyString(input.scene_id, "scene_id");
  const { scene, chapter, volume } = sceneFor(snapshot, sceneId);
  const path = validateManuscriptPath(scene.manuscript_path);
  const manuscriptRevision = yield* readFileRevision(host, request, path);
  return { scene, chapter, volume, manuscript_path: path, manuscript_revision: manuscriptRevision };
}

function diagnosticValues(snapshot: ReadSnapshot): Diagnostic[] {
  return snapshot.diagnostics;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function makeChangeSet(
  request: ActionRequest,
  action: ActionId,
  title: string,
  reason: string,
  idempotencyKey: string,
  readEntries: Iterable<{ path: string; revision: string | null }>,
  operations: Array<Omit<FileOperation, "id">>,
  label = title,
): ChangeSet {
  const changeId = `narrative-cs-${sha256Hex(JSON.stringify([request.scope.workspace_id, request.scope.generation, action, idempotencyKey]))}`;
  const readMap = new Map<string, string | null>();
  for (const item of readEntries) {
    const prior = readMap.get(item.path);
    if (prior !== undefined && prior !== item.revision) fail("snapshot_stale", `Read set has conflicting revisions for ${item.path}`, { path: item.path });
    readMap.set(item.path, item.revision);
  }
  const operationRows: FileOperation[] = operations.map((operation, index) => ({
    ...operation,
    id: `${changeId}/op/${index + 1}`,
  }));
  const paths = new Set<string>();
  for (const operation of operationRows) {
    if (paths.has(operation.path)) fail("invalid_input", `Change unit contains duplicate path ${operation.path}`);
    paths.add(operation.path);
    if (!readMap.has(operation.path)) readMap.set(operation.path, operation.expected_revision);
  }
  const unit: ChangeUnit = { id: `${changeId}/unit/1`, label, depends_on: [], operations: operationRows };
  return {
    id: changeId,
    idempotency_key: idempotencyKey,
    scope: request.scope,
    snapshot: request.snapshot,
    title,
    reason,
    read_set: [...readMap].map(([path, revision]) => ({ path, revision })).sort((a, b) => a.path.localeCompare(b.path)),
    units: [unit],
    evidence: [],
  };
}

export function* propose(
  host: NarrativeHost,
  request: ActionRequest,
  action: ActionId,
  title: string,
  reason: string,
  reads: Iterable<{ path: string; revision: string | null }>,
  operations: Array<Omit<FileOperation, "id">>,
): Generator<HostCall, ProposalValue, unknown> {
  const idempotencyKey = nonEmptyString(request.idempotency_key, "idempotency_key");
  const change = makeChangeSet(request, action, title, reason, idempotencyKey, reads, operations);
  const result = yield* host.request<Record<string, unknown>>("workspace.change.propose", { changeset: change as unknown as Record<string, unknown> });
  if (!isRecord(result) || typeof result.proposal_id !== "string" || !result.proposal_id || !isRecord(result.preview)) {
    fail("invalid_input", "Host returned an invalid proposal review reference");
  }
  return { proposal_id: result.proposal_id, preview: result.preview as ProposalValue["preview"] };
}

function snapshotReads(snapshot: ReadSnapshot): Array<{ path: string; revision: string | null }> {
  return snapshot.entries.map((file) => ({ path: file.path, revision: file.revision }));
}

function safeId(id: string): boolean {
  return SAFE_ID.test(id);
}

function validateTitle(value: unknown): string {
  const title = nonEmptyString(value, "title");
  if ([...title].length > 500 || /[\r\n\u0000-\u001f\u007f-\u009f]/u.test(title)) {
    fail("invalid_input", "title must be one non-empty line of at most 500 Unicode scalar values");
  }
  return title;
}

function idPrefix(kind: StructureKind): string {
  return kind === "volume" ? "vol-" : kind === "chapter" ? "ch-" : "sc-";
}

export function narrativeIdForTitle(kind: StructureKind, title: string, existingIds: Iterable<string>): string {
  const ids = new Set(existingIds);
  const slug = normalizeUnicode(title, "NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/gu, "");
  const prefix = idPrefix(kind);
  const base = slug ? `${prefix}${slug}` : prefix;
  let candidate = base;
  if (slug) {
    let suffix = 2;
    while (ids.has(candidate)) candidate = `${base}-${suffix++}`;
  } else {
    let suffix = 1;
    while (ids.has(`${base}${suffix}`)) suffix++;
    candidate = `${base}${suffix}`;
  }
  if (!safeId(candidate)) fail("invalid_input", "Generated structure id is not path-safe");
  return candidate;
}

function chooseId(kind: StructureKind, input: Record<string, unknown>, title: string, snapshot: ReadSnapshot): string {
  const ids = [...snapshot.files.values()].map((file) => String(file.raw.id));
  if (input.id === undefined) return narrativeIdForTitle(kind, title, ids);
  const id = nonEmptyString(input.id, "id");
  if (!safeId(id)) fail("invalid_input", "id must contain 1 to 128 ASCII letters, numbers, hyphens, or underscores");
  if (snapshot.duplicatePaths.has(id) || snapshot.byId.has(id) || ids.includes(id)) fail("conflict", `Structure ID already exists: ${id}`);
  return id;
}

function orderOfNew(input: Record<string, unknown>, siblings: StructureRow[], name = "order"): number {
  if (input[name] !== undefined) return positiveInteger(input[name], name, 2_147_483_647);
  const maximum = siblings.reduce((value, row) => row.order === undefined ? value : Math.max(value, row.order), 0);
  const next = Math.max(1, maximum + 1);
  if (next > 2_147_483_647) fail("invalid_input", `${name} cannot append after the current siblings`);
  return next;
}

function metadataYaml(values: Record<string, string | number>): string {
  return stringify(values, { lineWidth: 0, simpleKeys: true });
}

export function fileOperation(path: string, expected: string | null, content: string | null): Omit<FileOperation, "id"> {
  return content === null
    ? { kind: "delete", path, expected_revision: expected }
    : { kind: expected === null ? "create" : "replace", path, expected_revision: expected, content: Array.from(new TextEncoder().encode(content)) };
}

function hierarchyEntries(snapshot: ReadSnapshot): Array<{ path: string; revision: string | null }> {
  return snapshotReads(snapshot);
}

function expectedRevision(input: Record<string, unknown>, actual: string, field = "expected_metadata_revision"): void {
  if (input[field] !== actual) fail("snapshot_stale", `Metadata revision changed from ${String(input[field])}`, { expected: input[field], actual });
}

function parentChildren(snapshot: ReadSnapshot, kind: "chapter" | "scene", parentId: string): StructureRow[] {
  if (snapshot.duplicatePaths.has(parentId)) fail("ambiguous_identity", `Parent ${parentId} is ambiguous`, { paths: snapshot.duplicatePaths.get(parentId) });
  const parent = snapshot.byId.get(parentId);
  const expected = kind === "chapter" ? "volume" : "chapter";
  if (!parent || parent.kind !== expected) fail("invalid_input", `${kind} parent ${parentId} does not exist`);
  const parentPath = parent.metadata_path.replace(kind === "chapter" ? /\/volume\.ya?ml$/iu : /\/chapter\.ya?ml$/iu, "");
  const childPrefix = `${parentPath}/${kind === "chapter" ? "chapters" : "scenes"}/`;
  const malformed = snapshot.diagnostics.find((item) => item.severity === "error" && item.path?.startsWith(childPrefix));
  if (malformed) fail("unsupported_format", `Cannot verify the complete ${kind} sibling set while ${malformed.path} is malformed`, { path: malformed.path });
  const files = [...snapshot.files.values()].filter((file) => file.kind === kind &&
    file.raw[kind === "chapter" ? "volume" : "chapter"] === parentId);
  const duplicate = files.find((file) => snapshot.duplicatePaths.has(String(file.raw.id)));
  if (duplicate) fail("ambiguous_identity", `A ${kind} sibling has an ambiguous ID`, {
    id: duplicate.raw.id,
    paths: snapshot.duplicatePaths.get(String(duplicate.raw.id)),
  });
  const rows = kind === "chapter" ? snapshot.chapters : snapshot.scenes;
  return rows.filter((row) => row.parent_id === parentId).sort(compareRows);
}

function getMetadata(snapshot: ReadSnapshot, row: StructureRow): MetadataFile {
  const file = snapshot.files.get(row.metadata_path);
  if (!file) fail("file_not_found", `Metadata file was not read: ${row.metadata_path}`, { path: row.metadata_path });
  return file;
}

function kindInput(value: unknown, allowed: readonly StructureKind[]): StructureKind {
  if (typeof value !== "string" || !allowed.includes(value as StructureKind)) fail("invalid_input", "kind is invalid");
  return value as StructureKind;
}

function readingMarkValid(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!MARK_REQUIRED.every((key) => key in value)) return false;
  if (typeof value.id !== "string" || !value.id || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
      !Number.isSafeInteger(value.length) || (value.length as number) < 1 || typeof value.snippet !== "string" ||
      typeof value.createdAt !== "string" || !isRfc3339Utc(value.createdAt)) return false;
  if (value.comment !== undefined && (typeof value.comment !== "string" || value.comment.length > 200)) return false;
  return true;
}

function isRfc3339Utc(value: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function* readMarkBody(host: NarrativeHost, request: ActionRequest, path: string): Generator<HostCall, { text: string; revision: string }, unknown> {
  const result = yield* readTextFile(host, request, path);
  if (result.revision === null) fail("file_not_found", `Linked manuscript is missing: ${path}`, { path });
  return { text: result.text, revision: result.revision };
}

function getMarks(raw: Record<string, unknown>, path: string): { rows: unknown[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const value = raw.readingMarks;
  if (value === undefined) return { rows: [], diagnostics };
  if (!Array.isArray(value)) {
    diagnostics.push({ code: "invalid_reading_marks", path, message: "readingMarks must be a sequence", severity: "warning" });
    return { rows: [], diagnostics };
  }
  const rows: unknown[] = [];
  value.forEach((row, index) => {
    if (readingMarkValid(row)) rows.push(row);
    else diagnostics.push({ code: "invalid_reading_marks", path, index, message: `readingMarks[${index}] is malformed and was preserved`, severity: "warning" });
  });
  return { rows, diagnostics };
}

function allReadsForScene(snapshot: ReadSnapshot, manuscriptPath: string, manuscriptRevision: string): Array<{ path: string; revision: string | null }> {
  return [...hierarchyEntries(snapshot), { path: manuscriptPath, revision: manuscriptRevision }];
}

function* executeAction(host: NarrativeHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  validateEnvelope(request);
  validateAction(request.action_id);
  const input = request.input;
  const action = request.action_id;
  switch (action) {
    case "proprium.narrative.work.detect": {
      strictObject(input, []);
      const work = yield* readWorkSnapshot(host, request);
      return {
        status: work.status,
        work_id: makeWorkId(request.scope),
        tree_revision: work.treeRevision,
        ...(work.status === "recognized" ? { health: work.health } : {}),
        diagnostics: diagnosticValues(work),
      };
    }
    case "proprium.narrative.hierarchy.tree": {
      strictObject(input, [], ["parent_id", "cursor", "limit", "expected_tree_revision"]);
      const parentId = input.parent_id === undefined || input.parent_id === null ? null : nonEmptyString(input.parent_id, "parent_id");
      const limit = input.limit === undefined ? TREE_LIMIT : positiveInteger(input.limit, "limit", 200);
      const work = yield* readWorkSnapshot(host, request);
      assertTreeRevision(input, work);
      const rows = treeRows(work, parentId);
      let offset = 0;
      if (input.cursor !== undefined) offset = parseTreeCursor(nonEmptyString(input.cursor, "cursor"), request.snapshot, parentId, work.treeRevision);
      if (offset > rows.length) fail("snapshot_stale", "Hierarchy cursor is beyond this sibling list");
      const items = rows.slice(offset, offset + limit).map(treeItem);
      const nextOffset = offset + items.length;
      return {
        parent_id: parentId,
        items,
        next_cursor: nextOffset < rows.length ? treeCursor(request.snapshot, parentId, work.treeRevision, nextOffset) : null,
        tree_revision: work.treeRevision,
        diagnostics: diagnosticValues(work),
      };
    }
    case "proprium.narrative.hierarchy.outline": {
      strictObject(input, [], ["parent_id", "cursor", "limit", "expected_tree_revision", "selected_id"]);
      const parentId = input.parent_id === undefined || input.parent_id === null ? null : nonEmptyString(input.parent_id, "parent_id");
      const limit = input.limit === undefined ? TREE_LIMIT : positiveInteger(input.limit, "limit", 200);
      const work = yield* readWorkSnapshot(host, request);
      assertTreeRevision(input, work);
      const rows = treeRows(work, parentId);
      const offset = input.cursor === undefined ? 0 : parseTreeCursor(nonEmptyString(input.cursor, "cursor"), request.snapshot, parentId, work.treeRevision);
      if (offset > rows.length) fail("snapshot_stale", "Hierarchy cursor is beyond this sibling list");
      const selectedId = input.selected_id === undefined ? null : nonEmptyString(input.selected_id, "selected_id");
      const pageRows = rows.slice(offset, offset + limit);
      const selectedRow = selectedId === null ? null : pageRows.find(row => row.id === selectedId);
      if (selectedId !== null && !selectedRow) fail("scene_not_found", "Selected hierarchy row is not on this page");
      const items: Array<Record<string, unknown>> = [];
      const usedIds = new Set(pageRows.map(row => row.id));
      const syntheticId = (candidate: string) => {
        while (usedIds.has(candidate)) candidate = `@${candidate}`;
        usedIds.add(candidate);
        return candidate;
      };
      if (parentId !== null) {
        const parent = work.byId.get(parentId)!;
        items.push({ id: syntheticId("__parent__"), title: `← ${parent.title}`, action: {
          action_id: "proprium.narrative.hierarchy.outline",
          input_template: { parent_id: parent.parent_id, expected_tree_revision: work.treeRevision },
        } });
      }
      for (const row of pageRows) {
        items.push({ id: row.id, title: row.title, action: row.kind === "scene"
          ? { action_id: "proprium.narrative.scene.open", input_template: { scene_id: row.id, expected_tree_revision: work.treeRevision } }
          : { action_id: "proprium.narrative.hierarchy.outline", input_template: { parent_id: row.id, expected_tree_revision: work.treeRevision } },
        });
        items.push({ id: syntheticId(`edit:${sha256Hex(row.metadata_path)}`), title: `${row.title.slice(0, 512)} を編集対象に選択`, action: { action_id: "proprium.narrative.hierarchy.outline", input_template: {
          parent_id: parentId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), limit,
          selected_id: row.id, expected_tree_revision: work.treeRevision,
        } } });
      }
      const nextOffset = offset + Math.min(limit, rows.length - offset);
      return { parent_id: parentId, items, selected: selectedRow ? treeItem(selectedRow) : null, next_cursor: nextOffset < rows.length ? treeCursor(request.snapshot, parentId, work.treeRevision, nextOffset) : null,
        previous_cursor: offset > 0 ? treeCursor(request.snapshot, parentId, work.treeRevision, Math.max(0, offset - limit)) : null,
        tree_revision: work.treeRevision, diagnostics: diagnosticValues(work) };
    }
    case "proprium.narrative.scene.open":
    case "proprium.narrative.scene.context": {
      strictObject(input, ["scene_id"], ["expected_tree_revision"]);
      const work = yield* readWorkSnapshot(host, request);
      assertTreeRevision(input, work);
      const sceneId = nonEmptyString(input.scene_id, "scene_id");
      const context = yield* sceneContext(host, request, { scene_id: sceneId }, work);
      const { scene, chapter, volume, manuscript_path, manuscript_revision } = context;
      const value = action.endsWith("scene.open")
        ? {
            scene: {
              id: scene.id,
              title: scene.title,
              ...(scene.order === undefined ? {} : { order: scene.order }),
              metadata_path: scene.metadata_path,
              metadata_revision: scene.metadata_revision,
            },
            volume: { id: volume.id, title: volume.title },
            chapter: { id: chapter.id, title: chapter.title },
            manuscript_path,
            manuscript_revision,
            navigation: {
              target: { path: manuscript_path },
              expected_context: {
                scope: request.scope,
                snapshot: request.snapshot,
                draft_generation: request.snapshot.draft_generation,
              },
              intent: "open",
            },
          }
        : {
            scene_id: scene.id,
            title: scene.title,
            volume: { id: volume.id, title: volume.title },
            chapter: { id: chapter.id, title: chapter.title },
            manuscript_path,
            metadata_revision: scene.metadata_revision,
            manuscript_revision,
            diagnostics: diagnosticValues(work),
          };
      return value;
    }
    case "proprium.narrative.scene.continue": {
      strictObject(input, [], ["resume_position"]);
      if (input.resume_position === undefined || input.resume_position === null) {
        return { status: "no_position", candidate: null, diagnostics: [] };
      }
      const resume = strictObject(input.resume_position, ["scene_id", "manuscript_path", "metadata_revision", "manuscript_revision", "draft_generation", "sentence_index", "scroll_top"]);
      const sceneId = nonEmptyString(resume.scene_id, "resume_position.scene_id");
      const path = validateManuscriptPath(resume.manuscript_path);
      if (!(resume.draft_generation === null || typeof resume.draft_generation === "string") ||
          !(resume.sentence_index === null || Number.isSafeInteger(resume.sentence_index) && (resume.sentence_index as number) > 0) ||
          typeof resume.scroll_top !== "number" || !Number.isFinite(resume.scroll_top) || resume.scroll_top < 0 ||
          typeof resume.metadata_revision !== "string" || typeof resume.manuscript_revision !== "string") {
        fail("invalid_input", "resume_position fields are invalid");
      }
      const work = yield* readWorkSnapshot(host, request);
      if (work.duplicatePaths.has(sceneId)) fail("ambiguous_identity", `Scene ${sceneId} is ambiguous`, { paths: work.duplicatePaths.get(sceneId) });
      const scene = work.byId.get(sceneId);
      if (!scene || scene.kind !== "scene") return { status: "stale_position", candidate: null, diagnostics: [{ code: "stale_position", message: "The saved scene no longer exists", severity: "warning" }] };
      if (scene.manuscript_path !== path) return { status: "stale_position", candidate: null, diagnostics: [{ code: "stale_position", path: scene.metadata_path, message: "The saved scene now links to a different manuscript", severity: "warning" }] };
      let currentRevision: string;
      try {
        currentRevision = yield* readFileRevision(host, request, path);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "file_not_found") {
          return { status: "unavailable", candidate: null, diagnostics: [{ code: "stale_position", path, message: "The saved manuscript is missing", severity: "warning" }] };
        }
        throw error;
      }
      if (currentRevision !== resume.manuscript_revision) {
        const draftGeneration = resume.draft_generation;
        const draftAvailable = typeof draftGeneration === "string" && request.snapshot.draft_generation === draftGeneration;
        if (!draftAvailable) return { status: "stale_position", candidate: null, diagnostics: [{ code: "stale_position", path, message: "The saved manuscript revision changed", severity: "warning" }] };
      }
      const chapter = scene.parent_id ? work.byId.get(scene.parent_id) : undefined;
      const volumeId = work.files.get(scene.metadata_path)?.raw.volume;
      const volume = typeof volumeId === "string" ? work.byId.get(volumeId) : undefined;
      if (!chapter || chapter.kind !== "chapter" || !volume || volume.kind !== "volume") return { status: "unavailable", candidate: null, diagnostics: [{ code: "invalid_parent", path: scene.metadata_path, message: "Saved scene has no valid hierarchy parent", severity: "error" }] };
      return {
        status: "ready",
        candidate: {
          scene_id: scene.id,
          title: scene.title,
          manuscript_path: path,
          metadata_revision: scene.metadata_revision,
          manuscript_revision: currentRevision,
          draft_generation: resume.draft_generation,
          sentence_index: resume.sentence_index,
          scroll_top: resume.scroll_top,
        },
        diagnostics: diagnosticValues(work),
      };
    }
    case "proprium.narrative.structure.create":
      return yield* createStructure(host, request, input);
    case "proprium.narrative.structure.update":
      return yield* updateStructure(host, request, input);
    case "proprium.narrative.structure.reorder":
      return yield* reorderStructure(host, request, input);
    case "proprium.narrative.reading-marks.list":
      return yield* listReadingMarks(host, request, input);
    case "proprium.narrative.reading-marks.create":
      return yield* createReadingMark(host, request, input);
    case "proprium.narrative.reading-marks.delete":
      return yield* deleteReadingMark(host, request, input);
    case "proprium.narrative.changes.compile":
      return yield* compileNarrativeChanges(host, request, input);
    case "proprium.narrative.resume.marks.list":
      return yield* listPortableResumeMarks(host, request, input);
    case "proprium.narrative.resume.mark.propose":
      return yield* proposePortableResumeMark(host, request, input);
    default: {
      const neverAction: never = action;
      fail("invalid_input", `Unsupported Narrative action: ${neverAction}`);
    }
  }
}

function* createStructure(host: NarrativeHost, request: ActionRequest, value: Record<string, unknown>): Generator<HostCall, unknown, unknown> {
  const input = object(value);
  const kind = kindInput(input.kind, ["volume", "chapter", "scene"]);
  const required = kind === "volume" ? ["kind", "title", "expected_tree_revision"] : kind === "chapter"
    ? ["kind", "title", "volume_id", "expected_tree_revision"]
    : ["kind", "title", "volume_id", "chapter_id", "expected_tree_revision"];
  const optional = kind === "volume" ? ["id", "order"] : kind === "chapter" ? ["id", "order"] : ["id", "position"];
  strictObject(input, required, optional);
  const title = validateTitle(input.title);
  const work = yield* readWorkSnapshot(host, request);
  assertTreeRevision(input, work);
  const id = chooseId(kind, input, title, work);
  const operations: Array<Omit<FileOperation, "id">> = [];
  let path: string;
  let order: number;
  if (kind === "volume") {
    const siblings = work.volumes;
    order = orderOfNew(input, siblings);
    path = `plot/volumes/${id}/volume.yaml`;
    operations.push(fileOperation(path, null, metadataYaml({ id, type: kind, title, order })));
  } else if (kind === "chapter") {
    const volumeId = nonEmptyString(input.volume_id, "volume_id");
    if (!SAFE_ID.test(volumeId)) fail("invalid_path", "volume_id cannot be used as a canonical path component");
    if (work.duplicatePaths.has(volumeId)) fail("ambiguous_identity", `Volume ${volumeId} is ambiguous`, { paths: work.duplicatePaths.get(volumeId) });
    const volume = work.byId.get(volumeId);
    if (!volume || volume.kind !== "volume") fail("invalid_parent", `Volume ${volumeId} was not found`);
    const siblings = parentChildren(work, "chapter", volumeId);
    order = orderOfNew(input, siblings);
    path = `plot/volumes/${volumeId}/chapters/${id}/chapter.yaml`;
    operations.push(fileOperation(path, null, metadataYaml({ id, type: kind, title, volume: volumeId, order })));
  } else {
    const volumeId = nonEmptyString(input.volume_id, "volume_id");
    const chapterId = nonEmptyString(input.chapter_id, "chapter_id");
    if (!SAFE_ID.test(volumeId) || !SAFE_ID.test(chapterId)) fail("invalid_path", "Scene parent IDs cannot be used as canonical path components");
    if (work.duplicatePaths.has(volumeId) || work.duplicatePaths.has(chapterId)) fail("ambiguous_identity", "Scene parent identity is ambiguous");
    const volume = work.byId.get(volumeId);
    const chapter = work.byId.get(chapterId);
    if (!volume || volume.kind !== "volume" || !chapter || chapter.kind !== "chapter" || chapter.parent_id !== volumeId) {
      fail("invalid_parent", "Scene volume and chapter do not form a valid parent path");
    }
    const siblings = parentChildren(work, "scene", chapterId);
    const suppliedPosition = input.position === undefined ? undefined : positiveInteger(input.position, "position");
    const position = suppliedPosition === undefined ? siblings.length + 1 : Math.min(suppliedPosition, siblings.length + 1);
    order = suppliedPosition === undefined ? siblings.length + 1 : position;
    path = `plot/volumes/${volumeId}/chapters/${chapterId}/scenes/${id}.yaml`;
    const manuscriptPath = `manuscript/${volume.id}/${chapter.id}/${id}.md`;
    const metadata = metadataYaml({ id, type: kind, title, volume: volumeId, chapter: chapterId, order, manuscript: manuscriptPath });
    operations.push(fileOperation(path, null, metadata));
    operations.push(fileOperation(manuscriptPath, null, `---\ntitle: ${JSON.stringify(title)}\nstatus: planned\n---\n\n`));
    if (suppliedPosition !== undefined) {
      const ordered = [...siblings];
      const created: StructureRow = {
        id,
        kind: "scene",
        title,
        order: position,
        parent_id: chapterId,
        metadata_path: path,
        metadata_revision: "",
        manuscript_path: manuscriptPath,
        raw: { volume: volumeId, chapter: chapterId },
      };
      ordered.splice(position - 1, 0, created);
      for (const [index, sibling] of ordered.entries()) {
        if (sibling.id === id) {
          const createdText = metadataYaml({ id, type: kind, title, volume: volumeId, chapter: chapterId, order: index + 1, manuscript: manuscriptPath });
          operations[0] = fileOperation(path, null, createdText);
        } else {
          const siblingFile = getMetadata(work, sibling);
          const changed = updateYamlFields(siblingFile.text, sibling.metadata_path, { order: index + 1 });
          if (changed !== siblingFile.text) operations.push(fileOperation(sibling.metadata_path, sibling.metadata_revision, changed));
        }
      }
    }
  }
  const existingPaths = new Set(work.entries.map((entry) => entry.path));
  for (const operation of operations) {
    if (operation.kind === "create" && existingPaths.has(operation.path)) fail("conflict", `Structure path already exists: ${operation.path}`, { path: operation.path });
    if (operation.kind === "replace" && !existingPaths.has(operation.path)) fail("snapshot_stale", `Sibling metadata disappeared: ${operation.path}`, { path: operation.path });
    if (operation.expected_revision === null && operation.kind !== "create") fail("invalid_input", "New structure paths must be creates");
    if (operation.kind === "create" && !existingPaths.has(operation.path) && (yield* pathExists(host, request, operation.path))) {
      fail("conflict", `Structure path already exists: ${operation.path}`, { path: operation.path });
    }
  }
  const proposal = yield* propose(host, request, "proprium.narrative.structure.create", `Create ${kind}: ${title}`, `Create ${kind} ${id}`,
    hierarchyEntries(work), operations);
  return proposal;
}

function* updateStructure(host: NarrativeHost, request: ActionRequest, value: Record<string, unknown>): Generator<HostCall, unknown, unknown> {
  const input = strictObject(value, ["kind", "id", "patch", "expected_metadata_revision"]);
  const kind = kindInput(input.kind, ["volume", "chapter", "scene"]);
  const id = nonEmptyString(input.id, "id");
  const patch = object(input.patch, "patch");
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !["title", ...(kind === "scene" ? ["manuscript"] : [])].includes(key))) {
    fail("invalid_input", "Narrative structure update accepts title and scene manuscript only");
  }
  if (patch.title !== undefined) validateTitle(patch.title);
  if (patch.manuscript !== undefined) validateManuscriptPath(patch.manuscript);
  const work = yield* readWorkSnapshot(host, request);
  if (work.duplicatePaths.has(id)) fail("ambiguous_identity", `Structure ID ${id} is ambiguous`, { paths: work.duplicatePaths.get(id) });
  const row = work.byId.get(id);
  if (!row || row.kind !== kind) fail("scene_not_found", `${kind} ${id} was not found`);
  const file = getMetadata(work, row);
  expectedRevision(input, file.revision);
  const reads = hierarchyEntries(work);
  if (patch.manuscript !== undefined) {
    const destinationRevision = yield* readFileRevision(host, request, String(patch.manuscript));
    reads.push({ path: String(patch.manuscript), revision: destinationRevision });
  }
  const changed = updateYamlFields(file.text, file.path, patch as Record<string, string>);
  if (changed === file.text) fail("invalid_input", "Structure update does not change metadata");
  const proposal = yield* propose(host, request, "proprium.narrative.structure.update", `Update ${kind}: ${row.title}`, `Update structural metadata for ${id}`,
    reads, [fileOperation(file.path, file.revision, changed)]);
  return proposal;
}

function* reorderStructure(host: NarrativeHost, request: ActionRequest, value: Record<string, unknown>): Generator<HostCall, unknown, unknown> {
  const input = strictObject(value, ["kind", "parent_id", "ordered_ids", "expected_tree_revision"]);
  const kind = kindInput(input.kind, ["chapter", "scene"]) as "chapter" | "scene";
  const parentId = nonEmptyString(input.parent_id, "parent_id");
  if (!Array.isArray(input.ordered_ids) || input.ordered_ids.some((id) => typeof id !== "string" || !id)) fail("invalid_input", "ordered_ids must be a list of IDs");
  const order = input.ordered_ids as string[];
  if (new Set(order).size !== order.length) fail("invalid_input", "ordered_ids cannot contain duplicates");
  const work = yield* readWorkSnapshot(host, request);
  assertTreeRevision(input, work);
  const siblings = parentChildren(work, kind, parentId);
  if (siblings.length !== order.length || siblings.some((row) => !order.includes(row.id))) {
    fail("invalid_input", "ordered_ids must include every sibling exactly once", { expected_ids: siblings.map((row) => row.id) });
  }
  const operations: Array<Omit<FileOperation, "id">> = [];
  for (const [index, id] of order.entries()) {
    const sibling = siblings.find((row) => row.id === id)!;
    const file = getMetadata(work, sibling);
    if (file.raw.order !== index + 1) {
      const changed = updateYamlFields(file.text, file.path, { order: index + 1 });
      operations.push(fileOperation(file.path, file.revision, changed));
    }
  }
  if (!operations.length) fail("invalid_input", "Sibling order already matches the requested order");
  const proposal = yield* propose(host, request, "proprium.narrative.structure.reorder", `Reorder ${kind}s`, `Reorder ${kind} siblings under ${parentId}`,
    hierarchyEntries(work), operations);
  return proposal;
}

function* listReadingMarks(host: NarrativeHost, request: ActionRequest, value: Record<string, unknown>): Generator<HostCall, unknown, unknown> {
  const input = strictObject(value, ["scene_id"], ["expected_tree_revision"]);
  const work = yield* readWorkSnapshot(host, request);
  assertTreeRevision(input, work);
  const sceneId = nonEmptyString(input.scene_id, "scene_id");
  const { scene, metadata } = sceneFor(work, sceneId);
  const body = yield* readMarkBody(host, request, validateManuscriptPath(scene.manuscript_path));
  const { rows, diagnostics } = getMarks(metadata.raw, metadata.path);
  const marks = rows.map((mark) => {
    const row = mark as Record<string, unknown>;
    return {
      id: row.id,
      offset: row.offset,
      length: row.length,
      snippet: row.snippet,
      ...(row.comment ? { comment: row.comment } : {}),
      createdAt: row.createdAt,
      position_status: body.text.slice(row.offset as number, (row.offset as number) + (row.length as number)) === row.snippet ? "current" : "stale",
    };
  });
  return {
    scene_id: scene.id,
    metadata_revision: metadata.revision,
    manuscript_revision: body.revision,
    marks,
    diagnostics: [...diagnosticValues(work), ...diagnostics],
  };
}

function* createReadingMark(host: NarrativeHost, request: ActionRequest, value: Record<string, unknown>): Generator<HostCall, unknown, unknown> {
  const input = strictObject(value, ["scene_id", "mark", "expected_metadata_revision", "expected_manuscript_revision"]);
  const sceneId = nonEmptyString(input.scene_id, "scene_id");
  const mark = strictObject(input.mark, ["id", "offset", "length", "snippet", "createdAt"], ["comment"], "mark");
  const id = nonEmptyString(mark.id, "mark.id");
  if (!Number.isSafeInteger(mark.offset) || (mark.offset as number) < 0) fail("invalid_input", "mark.offset must be a nonnegative integer");
  const offset = mark.offset as number;
  const length = positiveInteger(mark.length, "mark.length");
  const snippet = typeof mark.snippet === "string" ? mark.snippet : fail("invalid_input", "mark.snippet must be text");
  const createdAt = typeof mark.createdAt === "string" && isRfc3339Utc(mark.createdAt) ? mark.createdAt : fail("invalid_input", "mark.createdAt must be RFC 3339 UTC");
  const comment = mark.comment === undefined || mark.comment === "" ? undefined : typeof mark.comment === "string" && mark.comment.length <= 200
    ? mark.comment : fail("invalid_input", "mark.comment must be at most 200 UTF-16 code units");
  if (offset + length > Number.MAX_SAFE_INTEGER) fail("invalid_input", "Reading mark range exceeds the valid position range");
  const work = yield* readWorkSnapshot(host, request);
  const { scene, metadata } = sceneFor(work, sceneId);
  expectedRevision(input, metadata.revision);
  const path = validateManuscriptPath(scene.manuscript_path);
  const body = yield* readMarkBody(host, request, path);
  expectedRevision(input, body.revision, "expected_manuscript_revision");
  if (body.text.slice(offset, offset + length) !== snippet) fail("invalid_input", "Reading mark snippet does not match the saved manuscript range");
  const { rows } = getMarks(metadata.raw, metadata.path);
  if (rows.some((item) => (item as Record<string, unknown>).id === id)) fail("conflict", `Reading mark ID already exists: ${id}`);
  if (rows.some((item) => {
    const row = item as Record<string, unknown>;
    return row.offset === offset && row.length === length;
  })) fail("conflict", "Reading mark already exists for this range");
  const newMark = { id, offset, length, snippet, ...(comment === undefined ? {} : { comment }), createdAt };
  const changed = appendYamlSequenceValue(metadata.text, metadata.path, "readingMarks", newMark);
  const proposal = yield* propose(host, request, "proprium.narrative.reading-marks.create", `Mark reading passage in ${scene.title}`,
    `Add reading mark ${id} to ${scene.id}`, allReadsForScene(work, path, body.revision), [fileOperation(metadata.path, metadata.revision, changed)]);
  return proposal;
}

function* deleteReadingMark(host: NarrativeHost, request: ActionRequest, value: Record<string, unknown>): Generator<HostCall, unknown, unknown> {
  const input = strictObject(value, ["scene_id", "mark_id", "expected_metadata_revision", "expected_manuscript_revision"]);
  const sceneId = nonEmptyString(input.scene_id, "scene_id");
  const markId = nonEmptyString(input.mark_id, "mark_id");
  const work = yield* readWorkSnapshot(host, request);
  const { scene, metadata } = sceneFor(work, sceneId);
  expectedRevision(input, metadata.revision);
  const path = validateManuscriptPath(scene.manuscript_path);
  const body = yield* readMarkBody(host, request, path);
  expectedRevision(input, body.revision, "expected_manuscript_revision");
  const rawMarks = metadata.raw.readingMarks;
  if (!Array.isArray(rawMarks)) fail("conflict", "Scene has no valid reading mark list");
  const matches = rawMarks.flatMap((item, index) => readingMarkValid(item) && item.id === markId ? [index] : []);
  if (!matches.length) fail("conflict", `Reading mark not found: ${markId}`);
  if (matches.length > 1) fail("ambiguous_identity", `Reading mark ID is duplicated: ${markId}`);
  const changed = removeYamlSequenceIndex(metadata.text, metadata.path, "readingMarks", matches[0]!);
  const proposal = yield* propose(host, request, "proprium.narrative.reading-marks.delete", `Remove reading mark from ${scene.title}`,
    `Remove reading mark ${markId} from ${scene.id}`, allReadsForScene(work, path, body.revision), [fileOperation(metadata.path, metadata.revision, changed)]);
  return proposal;
}

export function invokeNarrative(request: ActionRequest, host: NarrativeHost): Generator<HostCall, unknown, unknown> {
  return executeAction(host, request);
}
