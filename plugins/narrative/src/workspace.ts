import type { ActionRequest, Diagnostic, FileEntry, FilePage, NarrativeHost, ReadChunk, StructureKind, StructureRow } from "./contracts.js";
import { fail } from "./errors.js";
import type { HostCall } from "../../shared/guest.js";
import { sha256Hex } from "./hash.js";
import { parseYamlRecord } from "./yaml-source.js";

const LIST_LIMIT = 256;
const READ_CHUNK = 65_536;
const STRUCTURE_FILE = /^plot\/volumes\/[^/]+\/volume\.ya?ml$|^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.ya?ml$|^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.ya?ml$/iu;

export type MetadataFile = {
  path: string;
  revision: string;
  text: string;
  raw: Record<string, unknown>;
  kind: StructureKind;
  row?: StructureRow;
};

export type WorkSnapshot = {
  entries: FileEntry[];
  files: Map<string, MetadataFile>;
  volumes: StructureRow[];
  chapters: StructureRow[];
  scenes: StructureRow[];
  byId: Map<string, StructureRow>;
  duplicatePaths: Map<string, string[]>;
  diagnostics: Diagnostic[];
  treeRevision: string;
  status: "recognized" | "unrecognized" | "malformed";
  health: "clean" | "partial";
};

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pathKind(path: string): StructureKind | null {
  if (!STRUCTURE_FILE.test(path)) return null;
  if (/\/volume\.ya?ml$/iu.test(path)) return "volume";
  if (/\/chapter\.ya?ml$/iu.test(path)) return "chapter";
  return "scene";
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function validateManuscriptPath(value: unknown): string {
  if (typeof value !== "string" || !safeRelativePath(value) || !value.endsWith(".md")) {
    fail("invalid_path", "Scene manuscript must be a normalized repository-relative Markdown path", {
      path: typeof value === "string" ? value : undefined,
    });
  }
  return value;
}

function* listStructureEntries(host: NarrativeHost, request: ActionRequest): Generator<HostCall, FileEntry[], unknown> {
  const all: FileEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: FilePage = yield* host.request<FilePage>("workspace.file.list", {
      snapshot: request.snapshot, prefix: "plot/volumes", cursor, limit: LIST_LIMIT,
    });
    if (!Array.isArray(page.entries) || page.entries.length > LIST_LIMIT) fail("capacity", "Host returned an invalid hierarchy listing page");
    for (const entry of page.entries) {
      if (!entry || typeof entry.path !== "string" || typeof entry.revision !== "string" ||
          !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0) {
        fail("invalid_input", "Host returned an invalid hierarchy file entry");
      }
      if (pathKind(entry.path)) all.push(entry);
    }
    const next: string | null = page.next_cursor;
    if (next !== null && (typeof next !== "string" || !next || seenCursors.has(next))) {
      fail("invalid_input", "Host hierarchy cursor did not advance");
    }
    if (next !== null) seenCursors.add(next);
    cursor = next;
  } while (cursor !== null);
  all.sort((a, b) => compareUtf8(a.path, b.path));
  const unique = new Map<string, FileEntry>();
  for (const entry of all) {
    const previous = unique.get(entry.path);
    if (previous && previous.revision !== entry.revision) fail("snapshot_stale", `Pinned hierarchy listing changed at ${entry.path}`, { path: entry.path });
    unique.set(entry.path, entry);
  }
  return [...unique.values()];
}

function* readWholeFile(host: NarrativeHost, request: ActionRequest, entry: FileEntry): Generator<HostCall, string, unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let offset = 0;
  const revision = entry.revision;
  const totalBytes = entry.byte_length;
  let text = "";
  while (true) {
    let chunk: ReadChunk;
    try {
      chunk = yield* host.request<ReadChunk>("workspace.file.read", {
        snapshot: request.snapshot, path: entry.path, offset, length: READ_CHUNK,
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "file_not_found") {
        fail("snapshot_stale", `Hierarchy file disappeared from the pinned snapshot: ${entry.path}`, { path: entry.path });
      }
      throw error;
    }
    const bytes = chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes);
    if (chunk.revision !== revision || chunk.offset !== offset || chunk.total_bytes !== totalBytes || bytes.length > READ_CHUNK) {
      fail("snapshot_stale", `Pinned hierarchy bytes changed at ${entry.path}`, { path: entry.path });
    }
    try {
      text += decoder.decode(bytes, { stream: chunk.next_offset !== null });
    } catch (error) {
      fail("invalid_encoding", `Hierarchy metadata is not valid UTF-8 at ${entry.path}`, { path: entry.path, cause: String(error) });
    }
    const expectedNext = offset + bytes.length;
    if (chunk.next_offset === null) {
      if (expectedNext !== totalBytes) fail("invalid_input", `Host ended a partial file read at ${entry.path}`, { path: entry.path });
      try {
        text += decoder.decode();
      } catch (error) {
        fail("invalid_encoding", `Hierarchy metadata is not valid UTF-8 at ${entry.path}`, { path: entry.path, cause: String(error) });
      }
      break;
    }
    if (chunk.next_offset !== expectedNext || chunk.next_offset <= offset || expectedNext > totalBytes) {
      fail("invalid_input", `Host file read did not advance at ${entry.path}`, { path: entry.path });
    }
    offset = chunk.next_offset;
  }
  return text;
}

function diagnostic(code: string, path: string | undefined, message: string, severity: Diagnostic["severity"] = "warning"): Diagnostic {
  return { code, ...(path ? { path } : {}), message, severity };
}

function parseMetadata(entry: FileEntry, text: string, diagnostics: Diagnostic[]): MetadataFile | undefined {
  const kind = pathKind(entry.path);
  if (!kind) return undefined;
  let parsed;
  try {
    parsed = parseYamlRecord(text, entry.path);
  } catch (error) {
    diagnostics.push(diagnostic("malformed_metadata", entry.path, error instanceof Error ? error.message : String(error), "error"));
    return undefined;
  }
  const id = stringField(parsed.value.id);
  if (!id || id.length > 256) {
    diagnostics.push(diagnostic("malformed_metadata", entry.path, "Hierarchy metadata needs a stable id", "error"));
    return undefined;
  }
  if (parsed.value.type !== undefined && parsed.value.type !== kind) {
    diagnostics.push(diagnostic("malformed_metadata", entry.path, `Declared type conflicts with ${kind} hierarchy path`, "error"));
    return undefined;
  }
  const rawTitle = parsed.value.title ?? parsed.value.name;
  let title = id;
  if (rawTitle !== undefined) {
    if (typeof rawTitle !== "string" || !rawTitle.trim()) {
      diagnostics.push(diagnostic("malformed_metadata", entry.path, "Title must be a non-empty string", "error"));
      return undefined;
    }
    title = rawTitle;
  }
  const rawOrder = parsed.value.order;
  const order = Number.isSafeInteger(rawOrder) ? rawOrder as number : undefined;
  if (rawOrder !== undefined && order === undefined) {
    diagnostics.push(diagnostic("invalid_order", entry.path, "Order must be a finite safe integer"));
  }
  const parent = kind === "chapter" ? stringField(parsed.value.volume) : kind === "scene" ? stringField(parsed.value.chapter) : undefined;
  if (kind !== "volume" && !parent) {
    diagnostics.push(diagnostic("invalid_parent", entry.path, `${kind} metadata has no valid parent id`, "error"));
  }
  let manuscriptPath: string | undefined;
  if (kind === "scene") {
    try {
      manuscriptPath = validateManuscriptPath(parsed.value.manuscript);
    } catch (error) {
      diagnostics.push(diagnostic("invalid_manuscript_path", entry.path, error instanceof Error ? error.message : String(error), "error"));
    }
  }
  return {
    path: entry.path,
    revision: entry.revision,
    text,
    raw: parsed.value,
    kind,
    row: {
      id,
      kind,
      title,
      ...(order === undefined ? {} : { order }),
      parent_id: kind === "volume" ? null : stringField(parsed.value[kind === "chapter" ? "volume" : "chapter"]) ?? null,
      metadata_path: entry.path,
      metadata_revision: entry.revision,
      ...(manuscriptPath ? { manuscript_path: manuscriptPath } : {}),
      raw: parsed.value,
    },
  };
}

function compareRows(a: StructureRow, b: StructureRow): number {
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
  if (a.order !== undefined && b.order === undefined) return -1;
  if (a.order === undefined && b.order !== undefined) return 1;
  return compareUtf8(a.metadata_path, b.metadata_path) || compareUtf8(a.id, b.id);
}

export function* readWorkSnapshot(host: NarrativeHost, request: ActionRequest): Generator<HostCall, WorkSnapshot, unknown> {
  const entries = yield* listStructureEntries(host, request);
  const diagnostics: Diagnostic[] = [];
  const files = new Map<string, MetadataFile>();
  for (const entry of entries) {
    let text: string;
    try {
      text = yield* readWholeFile(host, request, entry);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "invalid_encoding") {
        diagnostics.push(diagnostic("malformed_metadata", entry.path, "Hierarchy metadata is not valid UTF-8", "error"));
        continue;
      }
      throw error;
    }
    const metadata = parseMetadata(entry, text, diagnostics);
    if (metadata) files.set(entry.path, metadata);
  }

  const orderGroups = new Map<string, MetadataFile[]>();
  for (const file of files.values()) {
    if (file.raw.order === undefined) diagnostics.push(diagnostic("invalid_order", file.path, "Order is missing; this sibling sorts after ordered rows"));
    if (file.row?.order === undefined) continue;
    const parentId = file.kind === "volume" ? "~" : String(file.raw[file.kind === "chapter" ? "volume" : "chapter"] ?? "?");
    const key = `${file.kind}\0${parentId}\0${file.row.order}`;
    const group = orderGroups.get(key) ?? [];
    group.push(file);
    orderGroups.set(key, group);
  }
  for (const group of orderGroups.values()) if (group.length > 1) {
    for (const file of group) diagnostics.push(diagnostic("invalid_order", file.path,
      `Order ${String(file.row?.order)} is shared by siblings; rows sort by metadata path then ID`));
  }

  const pathsById = new Map<string, string[]>();
  for (const file of files.values()) {
    const id = file.row!.id;
    const paths = pathsById.get(id) ?? [];
    paths.push(file.path);
    pathsById.set(id, paths);
  }
  const duplicatePaths = new Map([...pathsById].filter(([, paths]) => paths.length > 1));
  for (const [id, paths] of duplicatePaths) {
    const sorted = [...paths].sort(compareUtf8);
    for (const path of sorted) diagnostics.push(diagnostic("duplicate_entity_id", path, `ID ${id} is ambiguous across: ${sorted.join(", ")}`, "error"));
  }

  const volumes: StructureRow[] = [];
  const chapters: StructureRow[] = [];
  const scenes: StructureRow[] = [];
  const byId = new Map<string, StructureRow>();
  for (const file of files.values()) {
    const row = file.row!;
    if (duplicatePaths.has(row.id)) continue;
    if (row.kind === "volume") volumes.push(row);
    else if (row.kind === "chapter") chapters.push(row);
    else scenes.push(row);
    byId.set(row.id, row);
  }
  const validVolumes = new Set(volumes.map((row) => row.id));
  const validChapters = new Map(chapters.map((row) => [row.id, row]));
  const goodChapters = chapters.filter((row) => {
    if (!row.parent_id || !validVolumes.has(row.parent_id)) {
      diagnostics.push(diagnostic("invalid_parent", row.metadata_path, `Chapter ${row.id} refers to a missing or ambiguous volume`, "error"));
      byId.delete(row.id);
      return false;
    }
    return true;
  });
  const goodChapterIds = new Set(goodChapters.map((row) => row.id));
  const goodScenes = scenes.filter((row) => {
    const file = files.get(row.metadata_path)!;
    const chapterId = row.parent_id;
    const chapter = chapterId ? validChapters.get(chapterId) : undefined;
    const volumeId = stringField(file.raw.volume);
    if (!chapterId || !goodChapterIds.has(chapterId) || !chapter || !volumeId || chapter.parent_id !== volumeId) {
      diagnostics.push(diagnostic("invalid_parent", row.metadata_path, `Scene ${row.id} has a missing or inconsistent chapter/volume`, "error"));
      byId.delete(row.id);
      return false;
    }
    return true;
  });
  const allPaths = entries.map((entry) => [entry.path, entry.revision] as const).sort(([a], [b]) => compareUtf8(a, b));
  const treeRevision = `sha256-${sha256Hex(JSON.stringify(allPaths))}`;
  const knownPath = entries.length > 0;
  const hasVolume = volumes.length > 0;
  const status: WorkSnapshot["status"] = !knownPath ? "unrecognized" : hasVolume ? "recognized" : "malformed";
  if (status === "malformed") diagnostics.push(diagnostic("malformed_work", undefined, "Hierarchy paths exist, but no usable volume root was found", "error"));
  const health = diagnostics.length ? "partial" : "clean";
  return {
    entries,
    files,
    volumes: volumes.sort(compareRows),
    chapters: goodChapters.sort(compareRows),
    scenes: goodScenes.sort(compareRows),
    byId,
    duplicatePaths,
    diagnostics,
    treeRevision,
    status,
    health,
  };
}
