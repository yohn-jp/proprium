import YAML from "yaml";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { HOST_OPERATIONS, type FileChunk as HostFileChunk, type FilePage } from "../../shared/operations.js";
import type { ActionRequest, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import type { StoryEntity, StoryGraphInput, StoryLink } from "./domain/types.js";

export interface SnapshotFileEntry {
  readonly path: string;
  readonly revision: string;
  readonly byte_length: number;
  readonly media_type: string;
}

export interface PagedFileList {
  readonly entries: readonly SnapshotFileEntry[];
  readonly next_cursor: string | null;
}

export interface FileChunk {
  readonly revision: string;
  readonly total_bytes: number;
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly next_offset: number | null;
}

/** Host v2 pinned file capabilities, adapted without retaining a repository-wide byte snapshot. */
export interface SnapshotReader {
  readonly snapshot: Snapshot;
  list(input: { snapshot: Snapshot; prefix: string; cursor?: string; limit: number; staging_snapshot?: string }): Generator<HostCall, PagedFileList, unknown>;
  read(input: { snapshot: Snapshot; path: string; offset: number; length: number; staging_snapshot?: string }): Generator<HostCall, FileChunk, unknown>;
}

export interface StoryFile {
  readonly path: string;
  readonly content: string;
  readonly revision: string;
}

export interface SnapshotDiagnostic {
  readonly code: "invalid_path" | "unsupported_format" | "invalid_encoding" | "duplicate_id" | "broken_reference";
  readonly path?: string;
  readonly entityId?: string;
  readonly message: string;
}

export interface LoadedKnowledgeSnapshot extends StoryGraphInput {
  readonly files: ReadonlyMap<string, StoryFile>;
  readonly revisions: ReadonlyMap<string, string>;
  readonly duplicateIds: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly SnapshotDiagnostic[];
}

const ENTITY_DIRS: ReadonlyArray<[string, StoryEntity["type"]]> = [
  ["bible/characters", "character"],
  ["bible/locations", "location"],
  ["bible/items", "item"],
  ["bible/factions", "faction"],
  ["bible/timeline/events", "event"],
  ["bible/lore", "lore"],
  ["plot/threads", "thread"],
  ["plot/arcs", "arc"],
  ["bible/dialogue_sketches", "dialogue_sketch"],
];

const ENTITY_TYPES = new Set<StoryEntity["type"]>([
  "character", "location", "item", "faction", "event", "thread", "scene", "chapter",
  "volume", "arc", "lore", "manuscript", "dialogue_sketch",
]);

const LINK_FIELDS: Readonly<Record<string, string>> = {
  appears: "appears", mentions: "mentions", plants: "plants", advances: "advances", related: "related",
  pov: "pov", affiliated: "affiliated", target: "target", first_appears: "first_appears",
  planted: "planted", payoff: "payoff",
};

const PAGE_LIMIT = 128;
const READ_CHUNK_BYTES = 256 * 1024;
const YAML_SUFFIX = /\.(?:yaml|yml)$/u;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validProjectPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function inferType(filePath: string, raw: Record<string, unknown>): StoryEntity["type"] | null {
  if (typeof raw.type === "string" && ENTITY_TYPES.has(raw.type as StoryEntity["type"])) {
    return raw.type as StoryEntity["type"];
  }
  for (const [prefix, type] of ENTITY_DIRS) if (filePath.startsWith(`${prefix}/`)) return type;
  if (/^plot\/volumes\/[^/]+\/volume\.ya?ml$/iu.test(filePath)) return "volume";
  if (/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.ya?ml$/iu.test(filePath)) return "chapter";
  if (/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.ya?ml$/iu.test(filePath)) return "scene";
  return null;
}

function appendLink(links: StoryLink[], from: string, to: unknown, kind: string, note?: unknown): void {
  if (typeof to === "string" && to) links.push({ from, to, kind, ...(typeof note === "string" ? { note } : {}) });
}

function extractLinks(entityId: string, raw: Record<string, unknown>, links: StoryLink[]): void {
  for (const [field, kind] of Object.entries(LINK_FIELDS)) {
    const value = raw[field];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") appendLink(links, entityId, item, kind);
        else {
          const ref = asRecord(item);
          if (ref) appendLink(links, entityId, ref.target ?? ref.scene ?? ref.id, kind, ref.note);
        }
      }
    } else if (typeof value === "string") appendLink(links, entityId, value, kind);
  }
  if (typeof raw.location === "string") appendLink(links, entityId, raw.location, "location");
  if (Array.isArray(raw.relations)) {
    for (const value of raw.relations) {
      const relation = asRecord(value);
      if (relation && typeof relation.target === "string") {
        appendLink(links, entityId, relation.target, typeof relation.kind === "string" ? relation.kind : "related", relation.note);
      }
    }
  }
  const nestedEntities = asRecord(raw.entities);
  if (nestedEntities) {
    for (const [field, kind] of Object.entries(LINK_FIELDS)) {
      const targets = nestedEntities[field];
      if (Array.isArray(targets)) for (const target of targets) appendLink(links, entityId, target, kind);
    }
  }
  const threads = asRecord(raw.threads);
  if (threads) {
    for (const field of ["plants", "advances"] as const) {
      const targets = threads[field];
      if (Array.isArray(targets)) for (const target of targets) appendLink(links, entityId, target, field);
    }
  }
}

function parseMarkdown(content: string): { raw: Record<string, unknown>; body: string } | null {
  const opening = /^---[ \t]*\r?\n/u.exec(content);
  if (!opening) return { raw: {}, body: content };
  const delimiter = /^---[ \t]*\r?$/gmu;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(content);
  if (!closing) return null;
  const raw = asRecord(YAML.parse(content.slice(opening[0].length, closing.index)));
  if (!raw) return null;
  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  return { raw, body: content.slice(bodyStart) };
}

function parseStoryEntity(file: StoryFile): StoryEntity | null {
  if (file.path.startsWith("manuscript/") && file.path.endsWith(".md")) {
    const parsed = parseMarkdown(file.content);
    if (!parsed) return null;
    const id = file.path.replace(/^manuscript\//u, "ms-").replace(/\//gu, "-").replace(/\.md$/u, "");
    return {
      id, type: "manuscript", name: typeof parsed.raw.title === "string" ? parsed.raw.title : undefined,
      status: typeof parsed.raw.status === "string" ? parsed.raw.status : undefined,
      tags: Array.isArray(parsed.raw.tags) ? parsed.raw.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      filePath: file.path, raw: parsed.raw, body: parsed.body,
    };
  }
  if (!YAML_SUFFIX.test(file.path)) return null;
  const raw = asRecord(YAML.parse(file.content));
  if (!raw || typeof raw.id !== "string") return null;
  const type = inferType(file.path, raw);
  if (!type) return null;
  return {
    id: raw.id, type,
    name: typeof raw.name === "string" ? raw.name : undefined,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((value): value is string => typeof value === "string") : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((value): value is string => typeof value === "string") : undefined,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((value): value is string => typeof value === "string") : undefined,
    resolution: typeof raw.resolution === "string" ? raw.resolution : undefined,
    filePath: file.path, raw,
  };
}

function* readAllBytes(reader: SnapshotReader, entry: SnapshotFileEntry): Generator<HostCall, StoryFile, unknown> {
  if (!Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 || !/^[a-f0-9]{64}$/u.test(entry.revision)) {
    throw new Error(`invalid_input: malformed file-list entry for ${entry.path}`);
  }
  const bytes = new Uint8Array(entry.byte_length);
  let offset = 0;
  let revision: string | undefined;
  while (offset < entry.byte_length) {
    const chunk = yield* reader.read({ snapshot: reader.snapshot, path: entry.path, offset, length: READ_CHUNK_BYTES });
    if (chunk.offset !== offset || chunk.total_bytes !== entry.byte_length || !chunk.bytes.length ||
        chunk.revision !== entry.revision || (revision !== undefined && chunk.revision !== revision)) {
      throw new Error(`snapshot_stale: inconsistent byte range for ${entry.path}`);
    }
    revision ??= chunk.revision;
    bytes.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
    if (chunk.next_offset !== (offset < entry.byte_length ? offset : null)) {
      throw new Error(`invalid_input: malformed byte cursor for ${entry.path}`);
    }
  }
  if (entry.byte_length === 0) revision = entry.revision;
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`invalid_encoding: ${entry.path}`); }
  return { path: entry.path, content, revision: revision! };
}

function* listPrefix(reader: SnapshotReader, prefix: string): Generator<HostCall, SnapshotFileEntry[], unknown> {
  const entries: SnapshotFileEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = yield* reader.list({ snapshot: reader.snapshot, prefix, ...(cursor ? { cursor } : {}), limit: PAGE_LIMIT });
    for (const entry of page.entries) {
      if (entries.some((prior) => prior.path === entry.path)) throw new Error(`invalid_input: duplicate listing path ${entry.path}`);
      entries.push(entry);
    }
    if (page.next_cursor && seenCursors.has(page.next_cursor)) throw new Error(`invalid_input: repeated listing cursor for ${prefix}`);
    if (page.next_cursor) seenCursors.add(page.next_cursor);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return entries;
}

/** Reads the bounded YAML metadata index from a pinned revision; manuscript bodies stay lazy. */
export function* readKnowledgeSnapshot(reader: SnapshotReader): Generator<HostCall, LoadedKnowledgeSnapshot, unknown> {
  const diagnostics: SnapshotDiagnostic[] = [];
  const listed: SnapshotFileEntry[][] = [];
  for (const prefix of ["bible", "plot", "meta"]) listed.push(yield* listPrefix(reader, prefix));
  const entriesByPath = new Map<string, SnapshotFileEntry>();
  for (const entry of listed.flat()) {
    if (!validProjectPath(entry.path)) {
      diagnostics.push({ code: "invalid_path", path: entry.path, message: "Host returned an invalid workspace path" });
      continue;
    }
    if (YAML_SUFFIX.test(entry.path)) entriesByPath.set(entry.path, entry);
  }

  const files = new Map<string, StoryFile>();
  const entries = [...entriesByPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (let offset = 0; offset < entries.length; offset += 12) {
    const batch = entries.slice(offset, offset + 12);
    for (const entry of batch) files.set(entry.path, yield* readAllBytes(reader, entry));
  }

  const candidates: StoryEntity[] = [];
  for (const file of files.values()) {
    if (/^bible\/characters\/[^/]+\/voice\.ya?ml$/u.test(file.path)) continue;
    // Approved summary documents are auxiliary metadata, not Story entities.
    if (/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/(?:scene-summaries\/[^/]+|chapter-summary)\.ya?ml$/u.test(file.path)) continue;
    try {
      const entity = parseStoryEntity(file);
      if (entity) candidates.push(entity);
      else if (YAML_SUFFIX.test(file.path) && /^(bible|plot)\//u.test(file.path)) {
        diagnostics.push({ code: "unsupported_format", path: file.path, message: "YAML file is not a recognized Knowledge or Narrative entity" });
      }
    } catch (error) {
      diagnostics.push({ code: "unsupported_format", path: file.path, message: error instanceof Error ? error.message : "Malformed YAML" });
    }
  }

  const pathsById = new Map<string, string[]>();
  for (const entity of candidates) pathsById.set(entity.id, [...(pathsById.get(entity.id) ?? []), entity.filePath]);
  const duplicateIds = new Map([...pathsById].filter(([, paths]) => paths.length > 1));
  for (const [entityId, paths] of duplicateIds) {
    diagnostics.push({ code: "duplicate_id", entityId, message: `Duplicate identity appears in: ${paths.join(", ")}` });
  }

  const entities = new Map<string, StoryEntity>();
  for (const entity of candidates) if (!duplicateIds.has(entity.id)) entities.set(entity.id, entity);
  for (const entity of entities.values()) {
    if (entity.type === "character" && entity.filePath.endsWith("/profile.yaml")) {
      const voicePath = entity.filePath.replace(/profile\.yaml$/u, "voice.yaml");
      const voiceFile = files.get(voicePath);
      if (voiceFile) {
        try {
          const voice = asRecord(YAML.parse(voiceFile.content));
          if (voice) entity.raw = { ...entity.raw, voice };
        } catch (error) {
          diagnostics.push({ code: "unsupported_format", path: voicePath, message: error instanceof Error ? error.message : "Malformed voice metadata" });
        }
      }
    }
  }

  const links: StoryLink[] = [];
  for (const entity of entities.values()) extractLinks(entity.id, entity.raw, links);
  for (const link of links) {
    if (!entities.has(link.to)) diagnostics.push({ code: "broken_reference", entityId: link.from, message: `${link.kind} references missing or ambiguous ${link.to}` });
  }
  return {
    snapshot: reader.snapshot, entities, links, files,
    revisions: new Map([...files].map(([path, file]) => [path, file.revision])), duplicateIds, diagnostics,
  };
}

/** Reads one scene manuscript by explicit authored path and selected snapshot. */
export function* readSceneManuscript(reader: SnapshotReader, path: string): Generator<HostCall, StoryFile, unknown> {
  if (!validProjectPath(path) || !path.startsWith("manuscript/") || !path.endsWith(".md")) throw new Error("invalid_path");
  const selected = (yield* listPrefix(reader, path)).find((item) => item.path === path);
  if (!selected) throw new Error("file_not_found");
  return yield* readAllBytes(reader, selected);
}

/** Reads a known source path through its pinned list revision, including JSONL metadata files. */
export function* readOptionalPath(reader: SnapshotReader, path: string): Generator<HostCall, StoryFile | null, unknown> {
  if (!validProjectPath(path)) throw Object.assign(new Error(`Invalid workspace path: ${path}`), { code: "invalid_path", details: { path } });
  const selected = (yield* listPrefix(reader, path)).find((item) => item.path === path);
  return selected ? yield* readAllBytes(reader, selected) : null;
}

/** Loads only the manuscripts explicitly linked from the selected scene records. */
export function* attachSceneManuscripts(
  reader: SnapshotReader,
  story: LoadedKnowledgeSnapshot,
  selectedSceneIds?: ReadonlySet<string>,
): Generator<HostCall, LoadedKnowledgeSnapshot, unknown> {
  const scenes = [...story.entities.values()].filter((entity) => entity.type === "scene" &&
    (!selectedSceneIds || selectedSceneIds.has(entity.id)) && typeof entity.raw.manuscript === "string");
  if (!scenes.length) return story;
  const entries = new Map((yield* listPrefix(reader, "manuscript")).map((entry) => [entry.path, entry]));
  const entities = new Map(story.entities);
  const links = [...story.links];
  const files = new Map(story.files);
  const revisions = new Map(story.revisions);
  const diagnostics = [...story.diagnostics];
  for (const scene of scenes) {
    const path = scene.raw.manuscript as string;
    if (!validProjectPath(path) || !path.startsWith("manuscript/") || !path.endsWith(".md")) {
      diagnostics.push({ code: "invalid_path", path, entityId: scene.id, message: "Scene manuscript link is not a safe workspace path" });
      continue;
    }
    const entry = entries.get(path);
    if (!entry) {
      diagnostics.push({ code: "broken_reference", path, entityId: scene.id, message: `Scene manuscript file is missing: ${path}` });
      continue;
    }
    const file = yield* readAllBytes(reader, entry);
    const manuscript = parseStoryEntity(file);
    if (!manuscript) {
      diagnostics.push({ code: "unsupported_format", path, entityId: scene.id, message: "Manuscript frontmatter is malformed" });
      continue;
    }
    files.set(path, file);
    revisions.set(path, file.revision);
    entities.set(manuscript.id, manuscript);
    if (!links.some((link) => link.from === scene.id && link.kind === "manuscript")) {
      links.push({ from: scene.id, to: manuscript.id, kind: "manuscript" });
    }
  }
  return { ...story, entities, links, files, revisions, diagnostics };
}

/** Bind file operations to the exact Host-issued scope and snapshot on the action envelope. */
export function createSnapshotReader(context: ActionRequest, host: GuestHost, stagingSnapshot?: string): SnapshotReader {
  const snapshot = context.snapshot;
  return {
    snapshot,
    *list(input) {
      if (input.snapshot.id !== snapshot.id) throw new Error("snapshot_stale");
      const page = yield* host.request<FilePage>(HOST_OPERATIONS.list, {
        snapshot, prefix: input.prefix, ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit,
        ...(stagingSnapshot ? { staging_snapshot: stagingSnapshot } : {}),
      });
      return { entries: page.entries, next_cursor: page.next_cursor };
    },
    *read(input) {
      if (input.snapshot.id !== snapshot.id) throw new Error("snapshot_stale");
      const response = yield* host.request<HostFileChunk>(HOST_OPERATIONS.read, {
        snapshot, path: input.path, offset: input.offset, length: input.length,
        ...(stagingSnapshot ? { staging_snapshot: stagingSnapshot } : {}),
      });
      if (!Array.isArray(response.bytes) || response.bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error("invalid_input: Host returned malformed file bytes");
      }
      return { ...response, bytes: Uint8Array.from(response.bytes) };
    },
  };
}
