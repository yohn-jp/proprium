import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import type { ActionRequest } from "../../app/src/browser/proprium/authoring/types.js";
import { createGuest, withWarnings, type GuestHost, type HostCall } from "../shared/guest.js";
import { HOST_OPERATIONS, invokeAction, readFileVersioned, type FileEntry, type FilePage } from "../shared/operations.js";
import { ArtifactSink, Sha256, StoredZipArtifactWriter } from "./artifacts.js";
import {
  buildEpubScaffold,
  buildEpubSceneXhtml,
  buildPlaintextExport,
  collectPublishingScenes,
  composeVerticalPrintText,
  EXPORT_PREFLIGHT_ITEMS,
  plaintextSceneText,
  publishingFilename,
  safeRelativePath,
  type EpubBibleEntry,
  type PublishingChapter,
  type PublishingProject,
  type PublishingScene,
  type PublishingVolume,
  type PublishingScope,
} from "./domain.js";

const PLUGIN_ID = "proprium.publishing";
const NARRATIVE_ID = "proprium.narrative";
const TREE_ACTION = "proprium.narrative.hierarchy.tree";
const EPISODES_PATH = "meta/scriptorium/modules/publishing/episodes.yaml";
const GRANTS_PATH = "meta/scriptorium/modules/publishing/share-grants.jsonl";
const EPISODE_RECOVERY_PATHS = [
  "meta/publish-episodes.yaml",
  "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml",
] as const;
const LEGACY_GRANTS_RECOVERY_PATH = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
const MAX_PAGE = 200;
const MAX_RECOVERY_BYTES = 128 * 1024;

type Host = GuestHost;
type HostGenerator<T> = Generator<HostCall, T, unknown>;

interface TreeItem {
  id: string;
  kind: "volume" | "chapter" | "scene";
  title: string;
  order?: number;
  parent_id: string | null;
  metadata_path: string;
  metadata_revision: string;
  manuscript_path?: string;
}

interface TreeDiagnostic { code: string; path: string; message: string; severity: "error" | "warning" | "info" }
interface TreePage {
  parent_id: string | null;
  items: TreeItem[];
  next_cursor: string | null;
  tree_revision: string;
  diagnostics: TreeDiagnostic[];
}

interface TreeData {
  project: PublishingProject;
  treeRevision: string;
  volumes: Array<{ item: TreeItem; chapters: Array<{ item: TreeItem; scenes: TreeItem[] }> }>;
  diagnostics: TreeDiagnostic[];
}

interface TreeSelection {
  scope?: PublishingScope;
  id?: string;
  episode_chapter_ids?: ReadonlySet<string>;
  episode_scene_chapter_ids?: ReadonlySet<string>;
  include_project_metadata?: boolean;
}

interface EpisodeInput {
  id: string;
  number: number;
  title: string;
  scope: "volume" | "chapter";
  scope_id: string;
  published_at?: string | null;
  scene_ids?: string[] | null;
}

interface EpisodeValue extends EpisodeInput {
  published_at?: string;
  scene_ids?: string[];
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sanitizeShareRecord(value: Record<string, unknown>): Record<string, unknown> {
  const forbidden = ["owner", "user", "token", "bearer", "secret", "credential", "authorization", "authentication"];
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean);
    const object = record(item);
    if (!object) return item;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(object)) {
      const normalized = key.toLowerCase().replace(/[_-]/gu, "");
      if (normalized === "tokenhash") { output[key] = nested; continue; }
      if (forbidden.some(prefix => normalized.startsWith(prefix)) || (normalized.startsWith("auth") && !normalized.startsWith("author"))) continue;
      output[key] = clean(nested);
    }
    return output;
  };
  return clean(value) as Record<string, unknown>;
}

function parseShareGrant(value: unknown, line: number): Record<string, unknown> {
  const item = record(value);
  const scope = record(item?.scope);
  if (!item || item.version !== 1 || typeof item.id !== "string" || !item.id.trim() || item.id.length > 512 ||
      typeof item.tokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.tokenHash) ||
      !scope || !["project", "volume", "chapter", "scene"].includes(String(scope.kind)) ||
      typeof scope.id !== "string" || !scope.id.trim() || scope.id.length > 512 || typeof item.label !== "string" || item.label.length > 120 ||
      suspiciousShareLabel(item.label) ||
      typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
      typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)) ||
      (item.revokedAt !== undefined && (typeof item.revokedAt !== "string" || !Number.isFinite(Date.parse(item.revokedAt)))) ||
      (item.lastUsedAt !== undefined && (typeof item.lastUsedAt !== "string" || !Number.isFinite(Date.parse(item.lastUsedAt)))) ||
      (item.repositoryId !== undefined && (!Number.isSafeInteger(item.repositoryId) || (item.repositoryId as number) < 1)) ||
      (item.branch !== undefined && (typeof item.branch !== "string" || !item.branch)) ||
      ((item.repositoryId === undefined) !== (item.branch === undefined))) {
    return fail("unsupported_format", `Invalid share grant descriptor at line ${line}`, { path: GRANTS_PATH, reason: "invalid_source" });
  }
  return item;
}

function hasUnsafeShareFields(value: unknown): boolean {
  const unsafe = (key: string): boolean => {
    const normalized = key.toLowerCase().replace(/[_-]/gu, "");
    if (key === "tokenHash") return false;
    return ["token", "owner", "user", "bearer", "secret", "credential", "authorization", "authentication", "account"]
      .some(prefix => normalized.startsWith(prefix) || (prefix === "authorization" && normalized.startsWith("auth") && !normalized.startsWith("author")));
  };
  if (typeof value === "string") return /\bbearer\s+[^\s]{16,}/iu.test(value) ||
    /\bshare_[A-Za-z0-9_-]{32,}\b/u.test(value) || /\bgithub_pat_[A-Za-z0-9_]{30,}\b/u.test(value) ||
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u.test(value);
  if (Array.isArray(value)) return value.some(hasUnsafeShareFields);
  const object = record(value);
  return Boolean(object && Object.entries(object).some(([key, nested]) => unsafe(key) || hasUnsafeShareFields(nested)));
}

function suspiciousShareLabel(value: string): boolean {
  return /\bbearer\s+/iu.test(value) || /\b(?:token|secret|password|credential)\s*[=:]/iu.test(value) ||
    /^(?:share_)?[A-Za-z0-9_-]{40,}$/u.test(value.trim());
}

function validLegacyProjectId(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value) && !hasUnsafeShareFields(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (object) return `{${Object.entries(object).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

function legacyShareScope(value: unknown, legacyProjectId: string, repositoryId: number): Record<string, unknown> {
  if (typeof value === "string") {
    if (!value.trim()) return { kind: "project", id: String(repositoryId) };
    const match = /^(vol|ch|sc)-.+/u.exec(value);
    if (!match) return fail("unsupported_format", "Legacy share scope is not a recognized stable ID", { path: LEGACY_GRANTS_RECOVERY_PATH, reason: "invalid_scope" });
    const kind = match[1] === "vol" ? "volume" : match[1] === "ch" ? "chapter" : "scene";
    return { kind, id: value };
  }
  const scope = record(value);
  if (!scope || !["project", "volume", "chapter", "scene"].includes(String(scope.kind)) ||
      typeof scope.id !== "string" || !scope.id.trim() || scope.id.length > 512) {
    return fail("unsupported_format", "Legacy share scope is invalid", { path: LEGACY_GRANTS_RECOVERY_PATH, reason: "invalid_scope" });
  }
  if (scope.kind === "project") {
    if (scope.id !== "*" && scope.id !== legacyProjectId && scope.id !== String(repositoryId)) {
      return fail("ambiguous_identity", "Legacy project scope does not match the explicitly mapped project", { path: LEGACY_GRANTS_RECOVERY_PATH, reason: "foreign_project" });
    }
    return { ...scope, id: String(repositoryId) };
  }
  return { ...scope };
}

function mapLegacyShareGrant(value: unknown, line: number, legacyProjectId: string, repositoryId: number, branch: string): Record<string, unknown> {
  const item = record(value);
  if (!item || !validLegacyProjectId(legacyProjectId) || item.projectId !== legacyProjectId ||
      !validLegacyProjectId(String(item.projectId)) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 512 ||
      typeof item.tokenHash !== "string" || !/^[a-f0-9]{64}$/iu.test(item.tokenHash) ||
      typeof item.label !== "string" || item.label.length > 120 || suspiciousShareLabel(item.label) ||
      typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
      typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)) ||
      (item.revokedAt !== undefined && (typeof item.revokedAt !== "string" || !Number.isFinite(Date.parse(item.revokedAt)))) ||
      (item.lastUsedAt !== undefined && (typeof item.lastUsedAt !== "string" || !Number.isFinite(Date.parse(item.lastUsedAt)))) ||
      (item.version !== undefined && item.version !== 1) ||
      (item.grantVersion !== undefined && (!Number.isSafeInteger(item.grantVersion) || (item.grantVersion as number) < 1)) ||
      (item.revocationVersion !== undefined && (!Number.isSafeInteger(item.revocationVersion) || (item.revocationVersion as number) < 0))) {
    return fail("unsupported_format", `Invalid retained share grant at line ${line}`, { path: LEGACY_GRANTS_RECOVERY_PATH, reason: "invalid_source" });
  }
  if (hasUnsafeShareFields(item)) {
    return fail("unsupported_format", `Retained share grant at line ${line} contains account or bearer data`, { path: LEGACY_GRANTS_RECOVERY_PATH, reason: "unsafe_source" });
  }
  if ((item.repositoryId !== undefined && item.repositoryId !== repositoryId) ||
      (item.branch !== undefined && item.branch !== branch)) {
    return fail("ambiguous_identity", `Retained share grant at line ${line} is already bound to a different repository or branch`, { path: LEGACY_GRANTS_RECOVERY_PATH, reason: "foreign_repository" });
  }
  const mapped = {
    ...item,
    version: 1,
    grantVersion: item.grantVersion ?? 1,
    revocationVersion: item.revocationVersion ?? 0,
    tokenHash: item.tokenHash.toLowerCase(),
    scope: legacyShareScope(item.scope, legacyProjectId, repositoryId),
    repositoryId,
    branch,
  };
  return parseShareGrant(mapped, line);
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("invalid_encoding", `Invalid UTF-8 in ${path}`, { path }); }
}

function parseYamlRecord(text: string, path: string): Record<string, unknown> {
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) return fail("unsupported_format", `Invalid YAML in ${path}`, { path, reason: "invalid_source" });
  const value = document.toJS();
  const result = record(value);
  if (!result) return fail("unsupported_format", `Expected a YAML mapping in ${path}`, { path, reason: "invalid_source" });
  return result;
}

function* listFiles(host: Host, context: ActionRequest, prefix: string): HostGenerator<FileEntry[]> {
  const entries: FileEntry[] = [];
  const seenPaths = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: FilePage = yield* host.request<FilePage>(HOST_OPERATIONS.list, {
      snapshot: context.snapshot,
      prefix,
      cursor,
      limit: MAX_PAGE,
    });
    if (!page || !Array.isArray(page.entries) || (page.next_cursor !== null && typeof page.next_cursor !== "string")) {
      return fail("invalid_input", "Host returned an invalid file page");
    }
    for (const entry of page.entries) {
      if (!entry || typeof entry.path !== "string" || !safeRelativePath(entry.path) ||
          typeof entry.revision !== "string" || !/^[a-f0-9]{64}$/u.test(entry.revision) ||
          !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 ||
          seenPaths.has(entry.path)) return fail("invalid_input", "Host returned an invalid or duplicate file entry", { path: entry?.path });
      seenPaths.add(entry.path); entries.push(entry);
    }
    cursor = page.next_cursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) return fail("snapshot_stale", "File list cursor repeated");
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return entries;
}

function* readOptionalText(host: Host, context: ActionRequest, path: string): HostGenerator<{ text: string; entry?: FileEntry }> {
  const entry = (yield* listFiles(host, context, path)).find(item => item.path === path);
  if (!entry) return { text: "" };
  const source = yield* readFileVersioned(host, context.snapshot, path, entry.revision);
  return { text: decodeUtf8(source.bytes, path), entry };
}

function* readOptionalBytes(host: Host, context: ActionRequest, path: string): HostGenerator<{ bytes: Uint8Array; entry?: FileEntry }> {
  const entry = (yield* listFiles(host, context, path)).find(item => item.path === path);
  if (!entry) return { bytes: new Uint8Array() };
  const source = yield* readFileVersioned(host, context.snapshot, path, entry.revision);
  return { bytes: source.bytes, entry };
}

function* readRecoveryBytes(host: Host, context: ActionRequest, path: string): HostGenerator<{ bytes: Uint8Array; entry?: FileEntry }> {
  const entry = (yield* listFiles(host, context, path)).find(item => item.path === path);
  if (!entry) return { bytes: new Uint8Array() };
  if (entry.byte_length > MAX_RECOVERY_BYTES) return fail("capacity", "Publishing recovery file exceeds the bounded proposal size", { path });
  const source = yield* readFileVersioned(host, context.snapshot, path, entry.revision);
  return { bytes: source.bytes, entry };
}

function* treePage(host: Host, parentId: string | null, cursor: string | null, expectedTreeRevision?: string): HostGenerator<TreePage> {
  const input = {
    parent_id: parentId,
    ...(cursor ? { cursor } : {}),
    limit: MAX_PAGE,
    ...(expectedTreeRevision ? { expected_tree_revision: expectedTreeRevision } : {}),
  };
  return yield* invokeAction<TreePage>(host, NARRATIVE_ID, TREE_ACTION, input);
}

function* treeChildren(host: Host, parentId: string | null, expectedTreeRevision?: string): HostGenerator<{ items: TreeItem[]; treeRevision: string; diagnostics: TreeDiagnostic[] }> {
  const items: TreeItem[] = [];
  const diagnostics: TreeDiagnostic[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let treeRevision: string | undefined;
  do {
    const page: TreePage = yield* treePage(host, parentId, cursor, expectedTreeRevision ?? treeRevision);
    if (!page || !Array.isArray(page.items) || !Array.isArray(page.diagnostics) || typeof page.tree_revision !== "string") {
      return fail("invalid_input", "Narrative returned an invalid hierarchy page");
    }
    if (treeRevision && page.tree_revision !== treeRevision) return fail("snapshot_stale", "Narrative tree changed during the Publishing action");
    treeRevision = page.tree_revision;
    items.push(...page.items);
    diagnostics.push(...page.diagnostics);
    cursor = page.next_cursor;
    if (cursor !== null) {
      if (typeof cursor !== "string" || seenCursors.has(cursor)) return fail("snapshot_stale", "Narrative hierarchy cursor repeated");
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return { items, treeRevision: treeRevision ?? "", diagnostics };
}

function nodeOrder(item: TreeItem): number | undefined {
  return Number.isSafeInteger(item.order) ? item.order : undefined;
}

function* readTree(host: Host, context: ActionRequest, expectedTreeRevision?: string, selection: TreeSelection = {}): HostGenerator<TreeData> {
  const root = yield* treeChildren(host, null, expectedTreeRevision);
  if (!root.treeRevision) return fail("invalid_input", "Narrative omitted the tree revision");
  const diagnostics = [...root.diagnostics];
  const volumeItems = root.items.filter(item => item.kind === "volume");
  const volumes: Array<{ item: TreeItem; chapters: Array<{ item: TreeItem; scenes: TreeItem[] }> }> = [];
  for (const volumeItem of volumeItems.filter(item => selection.scope !== "volume" || !selection.id || item.id === selection.id)) {
    if (selection.episode_chapter_ids?.size === 0) {
      volumes.push({ item: volumeItem, chapters: [] });
      continue;
    }
    const chapterPage = yield* treeChildren(host, volumeItem.id, root.treeRevision);
    diagnostics.push(...chapterPage.diagnostics);
    const chapters: Array<{ item: TreeItem; scenes: TreeItem[] }> = [];
    const chapterItems = chapterPage.items.filter(item => item.kind === "chapter").filter(item => {
      if (selection.scope === "chapter") return !selection.id || item.id === selection.id;
      if (selection.episode_chapter_ids) return selection.episode_chapter_ids.has(item.id);
      return true;
    });
    for (const chapterItem of chapterItems) {
      const shouldReadScenes = !selection.episode_chapter_ids || selection.scope !== undefined ||
        selection.episode_scene_chapter_ids?.has(chapterItem.id) === true;
      let scenes: TreeItem[] = [];
      if (shouldReadScenes) {
        const scenePage = yield* treeChildren(host, chapterItem.id, root.treeRevision);
        diagnostics.push(...scenePage.diagnostics);
        scenes = scenePage.items.filter(item => item.kind === "scene");
      }
      chapters.push({ item: chapterItem, scenes });
    }
    volumes.push({ item: volumeItem, chapters });
  }
  let title = "Project";
  let subtitle: string | undefined;
  if (selection.include_project_metadata !== false) {
    const metadata = yield* readOptionalText(host, context, "meta/project.yaml");
    if (metadata.entry) {
      const projectRecord = parseYamlRecord(metadata.text, metadata.entry.path);
      const titleValue = [projectRecord.title, projectRecord.name].find(value => typeof value === "string" && value.trim());
      const candidate = typeof titleValue === "string" ? titleValue.trim() : "";
      if (candidate) title = candidate;
      if (typeof projectRecord.subtitle === "string" && projectRecord.subtitle.trim()) subtitle = projectRecord.subtitle.trim();
    }
  }
  const project: PublishingProject = {
    title,
    ...(subtitle ? { subtitle } : {}),
    volumes: volumes.map(({ item, chapters }) => ({
      id: item.id,
      title: item.title,
      ...(nodeOrder(item) === undefined ? {} : { order: nodeOrder(item) }),
      chapters: chapters.map(({ item: chapter, scenes }) => ({
        id: chapter.id,
        title: chapter.title,
        ...(nodeOrder(chapter) === undefined ? {} : { order: nodeOrder(chapter) }),
        scenes: scenes.map(scene => {
          const path = scene.manuscript_path;
          return {
            id: scene.id, title: scene.title, body: "", path: typeof path === "string" ? path : "", volumeId: item.id,
            chapterId: chapter.id, ...(nodeOrder(scene) === undefined ? {} : { order: nodeOrder(scene) }),
          };
        }),
      })),
    })),
  };
  return { project, treeRevision: root.treeRevision, volumes, diagnostics };
}

function assertSelectedTreeHealthy(data: TreeData, nodes: readonly TreeItem[]): void {
  const paths = new Set(nodes.flatMap(item => [item.metadata_path, ...(item.manuscript_path ? [item.manuscript_path] : [])]));
  const item = data.diagnostics.find(diagnostic => diagnostic.severity === "error" && paths.has(diagnostic.path));
  if (item) fail(item.code === "ambiguous_identity" ? item.code : "unsupported_format", item.message,
    { path: item.path, reason: "invalid_source" });
}

function validateTreeManuscriptPaths(scenes: readonly TreeItem[]): void {
  for (const scene of scenes) {
    const path = scene.manuscript_path;
    if (typeof path !== "string" || !safeRelativePath(path) || !path.toLowerCase().endsWith(".md")) {
      fail("invalid_path", `Narrative returned an invalid manuscript path for ${scene.id}`,
        { path: typeof path === "string" ? path : scene.metadata_path, reason: "invalid_source" });
    }
  }
}

function selectSceneIds(data: TreeData, scope: PublishingScope, id?: string): PublishingScene[] {
  if (scope !== "all" && scope !== "volume" && scope !== "chapter") {
    return fail("invalid_input", "Unsupported Publishing scope", { reason: "invalid_scope" });
  }
  if (scope === "all") {
    const nodes = data.volumes.flatMap(volume => [volume.item, ...volume.chapters.flatMap(chapter => [chapter.item, ...chapter.scenes])]);
    assertSelectedTreeHealthy(data, nodes);
    validateTreeManuscriptPaths(data.volumes.flatMap(volume => volume.chapters.flatMap(chapter => chapter.scenes)));
    const scenes = collectPublishingScenes(data.project, "all");
    if (scenes.length === 0) return fail("invalid_input", "The selected work has no scenes", { reason: "empty_scope" });
    validateManuscriptPaths(scenes);
    return scenes;
  }
  if (!id?.trim()) return fail("invalid_input", "A volume or chapter ID is required", { reason: "invalid_scope" });
  if (scope === "volume") {
    const matches = data.volumes.filter(volume => volume.item.id === id);
    if (matches.length > 1) return fail("ambiguous_identity", `Volume ID ${id} is ambiguous`);
    const selected = matches[0];
    if (!selected) return fail("invalid_input", `Volume ${id} was not found`, { reason: "invalid_scope" });
    assertSelectedTreeHealthy(data, [selected.item, ...selected.chapters.flatMap(chapter => [chapter.item, ...chapter.scenes])]);
    validateTreeManuscriptPaths(selected.chapters.flatMap(chapter => chapter.scenes));
    const project = { ...data.project, volumes: data.project.volumes.filter(volume => volume.id === id) };
    const scenes = collectPublishingScenes(project, "volume", id);
    if (scenes.length === 0) return fail("invalid_input", "The selected volume has no scenes", { reason: "empty_scope" });
    validateManuscriptPaths(scenes);
    return scenes;
  }
  const matches = data.volumes.flatMap(volume => volume.chapters.filter(chapter => chapter.item.id === id));
  if (matches.length > 1) return fail("ambiguous_identity", `Chapter ID ${id} is ambiguous`);
  if (matches.length === 0) return fail("invalid_input", `Chapter ${id} was not found`, { reason: "invalid_scope" });
  const selected = matches[0]!;
  const volume = data.volumes.find(candidate => candidate.chapters.includes(selected))!;
  assertSelectedTreeHealthy(data, [volume.item, selected.item, ...selected.scenes]);
  validateTreeManuscriptPaths(selected.scenes);
  const project = {
    ...data.project,
    volumes: data.project.volumes.filter(item => item.id === volume.item.id).map(item => ({
      ...item, chapters: item.chapters.filter(chapter => chapter.id === id),
    })),
  };
  const scenes = collectPublishingScenes(project, "chapter", id);
  if (scenes.length === 0) return fail("invalid_input", "The selected chapter has no scenes", { reason: "empty_scope" });
  validateManuscriptPaths(scenes);
  return scenes;
}

function validateManuscriptPaths(scenes: readonly PublishingScene[]): void {
  for (const scene of scenes) {
    if (!safeRelativePath(scene.path) || !scene.path.toLowerCase().endsWith(".md")) {
      fail("invalid_path", `Narrative returned an invalid manuscript path for ${scene.id}`,
        { path: scene.path || "unknown", reason: "invalid_source" });
    }
  }
}

function markdownBody(document: string, path: string): string {
  const opening = /^---[ \t]*\r?\n/u.exec(document);
  if (!opening) return document;
  const delimiter = /^---[ \t]*\r?$/gmu;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(document);
  if (!closing) return fail("unsupported_format", `Unclosed Markdown frontmatter in ${path}`, { path, reason: "invalid_source" });
  const yaml = document.slice(opening[0].length, closing.index);
  const parsed = parseDocument(yaml, { strict: true, uniqueKeys: true });
  if (parsed.errors.length > 0 || (parsed.toJS() !== null && !record(parsed.toJS()))) {
    return fail("unsupported_format", `Invalid Markdown frontmatter in ${path}`, { path, reason: "invalid_source" });
  }
  let bodyStart = closing.index + closing[0].length;
  if (document.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (document.startsWith("\n", bodyStart)) bodyStart++;
  return document.slice(bodyStart);
}

function* selectedBody(host: Host, context: ActionRequest, scene: PublishingScene): HostGenerator<string> {
  let bytes: Uint8Array;
  try { bytes = (yield* readFileVersioned(host, context.snapshot, scene.path)).bytes; }
  catch (error) {
    if ((error as { code?: unknown } | null)?.code === "file_not_found") {
      return fail("file_not_found", `Missing linked manuscript for ${scene.id}`, { path: scene.path, reason: "missing_source" });
    }
    throw error;
  }
  return markdownBody(decodeUtf8(bytes, scene.path), scene.path);
}

function* storePlaintext(input: Record<string, unknown>, context: ActionRequest, host: Host,
  markup: "raw" | "strip" | "kakuyomu" | "narou"): HostGenerator<unknown> {
  const scope = input.scope as PublishingScope;
  const id = typeof input.id === "string" && input.id ? input.id : undefined;
  if (scope !== "all" && scope !== "volume" && scope !== "chapter") return fail("invalid_input", "Unsupported Publishing scope", { reason: "invalid_scope" });
  const tree = yield* readTree(host, context, undefined, { scope, ...(id ? { id } : {}) });
  const scenes = selectSceneIds(tree, scope, id);
  const filename = publishingFilename(tree.project, scope, id, `plain-${markup}`);
  const sink = new ArtifactSink(host, context, filename, "text/plain; charset=utf-8");
  yield* sink.create();
  let sealed = false;
  try {
    let first = true;
    for (const scene of scenes) {
      const body = yield* selectedBody(host, context, scene);
      const text = plaintextSceneText(scene, body, markup);
      if (!text) continue;
      yield* sink.append(new TextEncoder().encode(`${first ? "" : "\n\n"}${text}`));
      first = false;
    }
    if (!first) yield* sink.append(new TextEncoder().encode("\n"));
    const artifact = yield* sink.seal();
    sealed = true;
    return {
      artifact_id: artifact.artifact_id,
      filename: artifact.filename,
      media_type: artifact.media_type,
      total_bytes: artifact.total_bytes,
      sha256: artifact.sha256,
      scope: { scope, ...(id ? { id } : {}) },
    };
  } finally {
    if (!sealed) yield* sink.discard();
  }
}

function* readBibleEntries(host: Host, context: ActionRequest): HostGenerator<EpubBibleEntry[]> {
  const entries: EpubBibleEntry[] = [];
  const specs: Array<{ type: EpubBibleEntry["type"]; prefix: string }> = [
    { type: "character", prefix: "bible/characters/" },
    { type: "lore", prefix: "bible/lore/" },
    { type: "location", prefix: "bible/locations/" },
  ];
  for (const { type, prefix } of specs) {
    for (const file of yield* listFiles(host, context, prefix)) {
      if (!/\.ya?ml$/iu.test(file.path)) continue;
      const relative = file.path.slice(prefix.length);
      if (type === "character" && relative.includes("/") && !/(^|\/)profile\.ya?ml$/iu.test(relative)) continue;
      const source = yield* readFileVersioned(host, context.snapshot, file.path, file.revision);
      const data = parseYamlRecord(decodeUtf8(source.bytes, file.path), file.path);
      if (typeof data.id !== "string" || !data.id.trim()) continue;
      const name = [data.name, data.title].find(value => typeof value === "string" && value.trim());
      const aliases = Array.isArray(data.aliases) ? data.aliases.filter((value): value is string => typeof value === "string") : [];
      entries.push({
        id: data.id, type, name: typeof name === "string" ? name.trim() : data.id,
        ...(aliases.length ? { aliases } : {}), ...(data.notes === undefined ? {} : { notes: data.notes }),
      });
    }
  }
  return entries;
}

const COVER_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
};

function* storeEpub(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const scope = input.scope as PublishingScope;
  const id = typeof input.id === "string" && input.id ? input.id : undefined;
  if (scope !== "all" && scope !== "volume" && scope !== "chapter") return fail("invalid_input", "Unsupported Publishing scope", { reason: "invalid_scope" });
  const tree = yield* readTree(host, context, undefined, { scope, ...(id ? { id } : {}) });
  const scenes = selectSceneIds(tree, scope, id);
  let cover: { path: string; bytes: Uint8Array } | undefined;
  const warnings: string[] = [];
  if (typeof input.cover_path === "string" && input.cover_path) {
    const path = input.cover_path;
    if (!safeRelativePath(path)) return fail("invalid_path", "Cover path must be workspace-relative", { path });
    const suffix = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (!COVER_TYPES[suffix]) warnings.push("unsupported_cover_type");
    else {
      const coverEntry = (yield* listFiles(host, context, path)).find(file => file.path === path);
      if (coverEntry) cover = { path, bytes: (yield* readFileVersioned(host, context.snapshot, path, coverEntry.revision)).bytes };
      else warnings.push("cover_unavailable");
    }
  }
  const bible = input.include_bible_appendix === true ? yield* readBibleEntries(host, context) : undefined;
  const options = {
    scope, ...(id ? { id } : {}),
    ...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim() } : {}),
    ...(typeof input.subtitle === "string" && input.subtitle.trim() ? { subtitle: input.subtitle.trim() } : {}),
    ...(cover ? { cover } : {}), ...(bible?.length ? { bible } : {}),
  } as const;
  const scaffold = buildEpubScaffold(tree.project, options);
  const filename = publishingFilename(tree.project, scope, id, "epub");
  const sink = new ArtifactSink(host, context, filename, "application/epub+zip");
  const zip = new StoredZipArtifactWriter(sink);
  yield* zip.start();
  let sealed = false;
  try {
    for (const [path, bytes] of scaffold.files) yield* zip.add(path, bytes);
    for (const item of scaffold.scenes) {
      const body = yield* selectedBody(host, context, item.scene);
      yield* zip.add(`OEBPS/${item.href}`, buildEpubSceneXhtml(item.scene, body));
    }
    const artifact = yield* zip.finish();
    sealed = true;
    return withWarnings({
      artifact_id: artifact.artifact_id,
      filename: artifact.filename,
      media_type: artifact.media_type,
      total_bytes: artifact.total_bytes,
      sha256: artifact.sha256,
      scope: { scope, ...(id ? { id } : {}) },
    }, warnings);
  } finally {
    if (!sealed) yield* sink.discard();
  }
}

function* storeVerticalPrint(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const scope = input.scope as PublishingScope;
  const id = typeof input.id === "string" && input.id ? input.id : undefined;
  if (scope !== "all" && scope !== "volume" && scope !== "chapter") return fail("invalid_input", "Unsupported Publishing scope", { reason: "invalid_scope" });
  const tree = yield* readTree(host, context, undefined, { scope, ...(id ? { id } : {}) });
  const scenes = selectSceneIds(tree, scope, id);
  const filename = publishingFilename(tree.project, scope, id, "vertical");
  const sink = new ArtifactSink(host, context, filename, "text/plain; charset=utf-8");
  yield* sink.create();
  let sealed = false;
  try {
    let first = true;
    for (const scene of scenes) {
      const body = yield* selectedBody(host, context, scene);
      const section = composeVerticalPrintText([{ id: scene.id, title: scene.title, body }]);
      if (!section) continue;
      yield* sink.append(new TextEncoder().encode(`${first ? "" : "\n"}${section}`));
      first = false;
    }
    const artifact = yield* sink.seal();
    sealed = true;
    return {
      artifact_id: artifact.artifact_id,
      filename: artifact.filename,
      media_type: artifact.media_type,
      total_bytes: artifact.total_bytes,
      sha256: artifact.sha256,
      scope: { scope, ...(id ? { id } : {}) },
    };
  } finally {
    if (!sealed) yield* sink.discard();
  }
}

function* readEpisodeDocument(host: Host, context: ActionRequest): HostGenerator<{ document: ReturnType<typeof parseDocument>; revision: string | null; entry?: FileEntry }> {
  const entry = (yield* listFiles(host, context, EPISODES_PATH)).find(file => file.path === EPISODES_PATH);
  const text = entry
    ? decodeUtf8((yield* readFileVersioned(host, context.snapshot, EPISODES_PATH, entry.revision)).bytes, EPISODES_PATH)
    : "episodes: []\n";
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) return fail("unsupported_format", `Invalid episode metadata in ${EPISODES_PATH}`, { path: EPISODES_PATH, reason: "invalid_source" });
  const root = document.contents;
  const episodes = root.get("episodes", true);
  if (episodes !== undefined && !isSeq(episodes)) return fail("unsupported_format", `Episode metadata must contain an episodes sequence`, { path: EPISODES_PATH, reason: "invalid_source" });
  return { document, revision: entry?.revision ?? null, ...(entry ? { entry } : {}) };
}

function publicEpisode(row: unknown, index: number, path = EPISODES_PATH): EpisodeValue {
  if (!isMap(row)) return fail("unsupported_format", `Invalid publication episode at index ${index}`, { path, reason: "invalid_source" });
  const data = row.toJSON() as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id.trim() || !Number.isSafeInteger(data.number) || (data.number as number) < 1 ||
      typeof data.title !== "string" || !data.title.trim() || (data.scope !== "volume" && data.scope !== "chapter") ||
      typeof data.scopeId !== "string" || !data.scopeId.trim() ||
      (data.publishedAt !== undefined && (typeof data.publishedAt !== "string" || !validPublicationDate(data.publishedAt))) ||
      (data.sceneIds !== undefined && (!Array.isArray(data.sceneIds) || data.sceneIds.some(id => typeof id !== "string" || !id.trim()) || new Set(data.sceneIds).size !== data.sceneIds.length))) {
    return fail("unsupported_format", `Invalid publication episode at index ${index}`, { path, reason: "invalid_source" });
  }
  return {
    id: data.id,
    number: data.number as number,
    title: data.title,
    scope: data.scope,
    scope_id: data.scopeId,
    ...(typeof data.publishedAt === "string" ? { published_at: data.publishedAt } : {}),
    ...(Array.isArray(data.sceneIds) ? { scene_ids: data.sceneIds as string[] } : {}),
  };
}

function episodeRows(document: ReturnType<typeof parseDocument>, path = EPISODES_PATH): EpisodeValue[] {
  if (!isMap(document.contents)) return fail("unsupported_format", `Invalid episode metadata in ${path}`, { path, reason: "invalid_source" });
  const sequence = document.contents.get("episodes", true);
  if (sequence !== undefined && !isSeq(sequence)) return fail("unsupported_format", `Episode metadata must contain an episodes sequence`, { path, reason: "invalid_source" });
  const rows = sequence && isSeq(sequence) ? sequence.items.map((row, index) => publicEpisode(row, index, path)) : [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const episode of rows) {
    if (ids.has(episode.id) || numbers.has(episode.number)) {
      return fail("unsupported_format", "Episode metadata contains duplicate IDs or numbers", { path, reason: "invalid_source" });
    }
    ids.add(episode.id); numbers.add(episode.number);
  }
  return rows.sort((left, right) => left.number - right.number || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function* recoveryInspect(_input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const active = yield* readOptionalBytes(host, context, EPISODES_PATH);
  const episode_sources: Array<Record<string, unknown>> = [];
  const importable_episode_sources: Array<Record<string, unknown>> = [];
  for (const sourcePath of EPISODE_RECOVERY_PATHS) {
    const source = yield* readOptionalBytes(host, context, sourcePath);
    if (!source.entry) {
      episode_sources.push({ source_path: sourcePath, label: `${sourcePath} — absent`, state: "absent", source_revision: null,
        target_revision: active.entry?.revision ?? null, episode_count: 0, detail: "" });
      continue;
    }
    let count: number;
    try {
      const text = decodeUtf8(source.bytes, sourcePath);
      const document = parseDocument(text, { strict: true, uniqueKeys: true });
      if (document.errors.length > 0 || !isMap(document.contents)) throw new Error("Invalid YAML mapping");
      count = episodeRows(document, sourcePath).length;
    } catch (error) {
      const cause = error as { code?: unknown };
      episode_sources.push({ source_path: sourcePath, label: `${sourcePath} — invalid`, state: "invalid", source_revision: source.entry.revision,
        target_revision: active.entry?.revision ?? null, episode_count: 0,
        detail: cause.code === "invalid_encoding" ? "invalid_utf8" : "invalid_episode_map" });
      continue;
    }
    const state = !active.entry ? "ready" : active.bytes.byteLength === source.bytes.byteLength && active.bytes.every((byte, index) => byte === source.bytes[index])
      ? "already_imported" : "conflict";
    const summary = { source_path: sourcePath, label: `${sourcePath} — ${state} (${count})`, state,
      source_revision: source.entry.revision, target_revision: active.entry?.revision ?? null, episode_count: count,
      detail: "" };
    episode_sources.push(summary);
    if (state === "ready") importable_episode_sources.push(summary);
  }
  const grantTarget = yield* listFiles(host, context, GRANTS_PATH);
  const grantTargetEntry = grantTarget.find(item => item.path === GRANTS_PATH);
  const grantSourcePage = yield* listFiles(host, context, LEGACY_GRANTS_RECOVERY_PATH);
  const grantSourceEntry = grantSourcePage.find(item => item.path === LEGACY_GRANTS_RECOVERY_PATH);
  const boundRepositoryId = context.scope.repository_id;
  const boundBranch = context.scope.branch;
  const mappingTarget = { repository_id: boundRepositoryId, branch: boundBranch };
  const grant_sources: Array<Record<string, unknown>> = [];
  const importable_grant_sources: Array<Record<string, unknown>> = [];
  const legacy_project_options: Array<{ value: string; label: string }> = [];
  let grant_import_available = false;
  if (!grantSourceEntry) {
    grant_sources.push({ source_path: LEGACY_GRANTS_RECOVERY_PATH, state: "absent", source_revision: null,
      target_revision: grantTargetEntry?.revision ?? null, grant_count: 0,
      project_ids: [], target_repository_id: boundRepositoryId, target_branch: boundBranch, detail: "" });
  } else if (grantSourceEntry.byte_length > MAX_RECOVERY_BYTES || !Number.isSafeInteger(boundRepositoryId) ||
      (boundRepositoryId as number) < 1 || !boundBranch) {
    const reason = grantSourceEntry.byte_length > MAX_RECOVERY_BYTES ? "source_too_large" : "repository_not_bound";
    grant_sources.push({ source_path: LEGACY_GRANTS_RECOVERY_PATH, state: "unavailable", source_revision: grantSourceEntry.revision,
      target_revision: grantTargetEntry?.revision ?? null, grant_count: 0,
      project_ids: [], target_repository_id: boundRepositoryId, target_branch: boundBranch, detail: reason });
  } else {
    try {
      const source = yield* readFileVersioned(host, context.snapshot, LEGACY_GRANTS_RECOVERY_PATH, grantSourceEntry.revision);
      const sourceText = decodeUtf8(source.bytes, LEGACY_GRANTS_RECOVERY_PATH);
      const idsByProject = new Map<string, Set<string>>();
      let grantCount = 0;
      let sourceValid = true;
      for (const [index, line] of sourceText.split(/\r?\n/u).entries()) {
        if (!line.trim()) continue;
        if (grantCount >= 1000) { sourceValid = false; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(line) as unknown; }
        catch { sourceValid = false; break; }
        const item = record(parsed);
        if (!item || typeof item.projectId !== "string" || !validLegacyProjectId(item.projectId)) {
          sourceValid = false; break;
        }
        try {
          const grant = mapLegacyShareGrant(item, index + 1, item.projectId, boundRepositoryId as number, boundBranch);
          const ids = idsByProject.get(item.projectId) ?? new Set<string>();
          if (ids.has(grant.id as string)) { sourceValid = false; break; }
          ids.add(grant.id as string); idsByProject.set(item.projectId, ids); grantCount++;
        } catch { sourceValid = false; break; }
      }
      const projectIds = [...idsByProject.keys()].sort();
      if (!sourceValid) {
        grant_sources.push({ source_path: LEGACY_GRANTS_RECOVERY_PATH, state: "invalid", source_revision: grantSourceEntry.revision,
          target_revision: grantTargetEntry?.revision ?? null, grant_count: 0,
          project_ids: [], target_repository_id: boundRepositoryId, target_branch: boundBranch,
          detail: "invalid_jsonl_or_unsafe_grant" });
      } else if (!grantCount) {
        grant_sources.push({ source_path: LEGACY_GRANTS_RECOVERY_PATH, state: "empty", source_revision: grantSourceEntry.revision,
          target_revision: grantTargetEntry?.revision ?? null, grant_count: 0,
          project_ids: [], target_repository_id: boundRepositoryId, target_branch: boundBranch, detail: "" });
      } else {
        const summary = { source_path: LEGACY_GRANTS_RECOVERY_PATH, state: "mapping_required", source_revision: grantSourceEntry.revision,
          target_revision: grantTargetEntry?.revision ?? null, grant_count: grantCount,
          project_ids: projectIds, target_repository_id: boundRepositoryId, target_branch: boundBranch,
          detail: "Confirm the legacy project ID and the displayed Host repository ID and branch before proposing." };
        grant_sources.push(summary);
        importable_grant_sources.push({ source_path: LEGACY_GRANTS_RECOVERY_PATH, label: LEGACY_GRANTS_RECOVERY_PATH });
        for (const projectId of projectIds) {
          legacy_project_options.push({ value: projectId, label: `${projectId} (${idsByProject.get(projectId)?.size ?? 0})` });
        }
        grant_import_available = true;
      }
    } catch (error) {
      const cause = error as { code?: unknown };
      grant_sources.push({ source_path: LEGACY_GRANTS_RECOVERY_PATH,
        state: cause.code === "snapshot_stale" ? "unavailable" : "invalid",
        source_revision: grantSourceEntry.revision, target_revision: grantTargetEntry?.revision ?? null,
        grant_count: 0, project_ids: [], target_repository_id: boundRepositoryId,
        target_branch: boundBranch, detail: cause.code === "snapshot_stale" ? "source_changed_during_inspection" : "invalid_encoding_or_source" });
    }
  }
  return {
    target_path: EPISODES_PATH,
    episode_sources,
    importable_episode_sources,
    import_available: importable_episode_sources.length > 0,
    grant_sources,
    importable_grant_sources,
    legacy_project_options,
    grant_import_available,
    mapping_target: mappingTarget,
    host_recovery_sources: ["app-state/share-tokens.json", "share-tokens.json"].map(source_path => ({
      source_path, state: "host_recovery_required",
      detail: "This browser-local source is outside repository file capabilities. Use Host's explicit recovery flow; it submits only sanitized hash-only descriptors for the bound repository and branch.",
    })),
  };
}

function* recoveryGrantPropose(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const legacyProjectId = input.legacy_project_id;
  const repositoryConfirmation = input.repository_id_confirmation;
  const branchConfirmation = input.branch_confirmation;
  const repositoryId = context.scope.repository_id;
  const branch = context.scope.branch;
  if (input.source_path !== LEGACY_GRANTS_RECOVERY_PATH || typeof legacyProjectId !== "string" ||
      !validLegacyProjectId(legacyProjectId) || !Number.isSafeInteger(repositoryId) ||
      (repositoryId as number) < 1 || repositoryConfirmation !== repositoryId ||
      typeof branch !== "string" || !branch || branchConfirmation !== branch) {
    return fail("ambiguous_identity", "Confirm a listed legacy project ID and the current Host repository ID and branch exactly", {
      path: LEGACY_GRANTS_RECOVERY_PATH, reason: "explicit_mapping_required",
    });
  }
  if (!context.idempotency_key) return fail("invalid_input", "Publishing recovery requires an idempotency key");
  const sourceEntry = (yield* listFiles(host, context, LEGACY_GRANTS_RECOVERY_PATH))
    .find(item => item.path === LEGACY_GRANTS_RECOVERY_PATH);
  if (!sourceEntry) return fail("file_not_found", "Retained share-grant recovery source is unavailable", {
    path: LEGACY_GRANTS_RECOVERY_PATH, reason: "missing_source",
  });
  if (sourceEntry.byte_length > MAX_RECOVERY_BYTES) return fail("capacity", "Retained share-grant source exceeds the proposal size limit", {
    path: LEGACY_GRANTS_RECOVERY_PATH,
  });
  const source = yield* readFileVersioned(host, context.snapshot, LEGACY_GRANTS_RECOVERY_PATH, sourceEntry.revision);
  const sourceText = decodeUtf8(source.bytes, LEGACY_GRANTS_RECOVERY_PATH);
  const mapped: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  let sourceProjectFound = false;
  for (const [index, line] of sourceText.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { return fail("unsupported_format", `Invalid retained share-grant JSONL at line ${index + 1}`, {
      path: LEGACY_GRANTS_RECOVERY_PATH, reason: "invalid_source",
    }); }
    const item = record(parsed);
    if (!item || typeof item.projectId !== "string" || !validLegacyProjectId(item.projectId)) return fail("unsupported_format",
      `Invalid retained share-grant descriptor at line ${index + 1}`, { path: LEGACY_GRANTS_RECOVERY_PATH, reason: "invalid_source" });
    if (item.projectId !== legacyProjectId) continue;
    sourceProjectFound = true;
    const grant = mapLegacyShareGrant(item, index + 1, legacyProjectId, repositoryId as number, branch);
    const grantId = grant.id as string;
    if (ids.has(grantId)) return fail("unsupported_format", `Duplicate retained share grant ID ${grantId}`, {
      path: LEGACY_GRANTS_RECOVERY_PATH, reason: "duplicate_id",
    });
    ids.add(grantId);
    if (grant.scope && (grant.scope as Record<string, unknown>).kind !== "project") {
      const scope = grant.scope as { kind: "volume" | "chapter" | "scene"; id: string };
      yield* validateShareScope(host, context, scope);
    }
    mapped.push(grant);
  }
  if (!sourceProjectFound || !mapped.length) return fail("ambiguous_identity", "The selected legacy project ID has no importable grant records", {
    path: LEGACY_GRANTS_RECOVERY_PATH, reason: "foreign_project",
  });
  const target = yield* readRecoveryBytes(host, context, GRANTS_PATH);
  if (target.entry) {
    const existing: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const [index, line] of decodeUtf8(target.bytes, GRANTS_PATH).split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; }
      catch { return fail("conflict", "Canonical share metadata is malformed; retained grants were not imported", {
        reason: "metadata_conflict", source_path: LEGACY_GRANTS_RECOVERY_PATH, source_revision: sourceEntry.revision,
        target_path: GRANTS_PATH, target_revision: target.entry.revision,
      }); }
      if (hasUnsafeShareFields(parsed)) return fail("conflict", "Canonical share metadata contains account or bearer data", {
        reason: "metadata_conflict", source_path: LEGACY_GRANTS_RECOVERY_PATH, source_revision: sourceEntry.revision,
        target_path: GRANTS_PATH, target_revision: target.entry.revision,
      });
      let item: Record<string, unknown>;
      try { item = parseShareGrant(parsed, index + 1); }
      catch { return fail("conflict", "Canonical share metadata contains an invalid descriptor", {
        reason: "metadata_conflict", source_path: LEGACY_GRANTS_RECOVERY_PATH, source_revision: sourceEntry.revision,
        target_path: GRANTS_PATH, target_revision: target.entry.revision,
      }); }
      const grantId = item.id as string;
      if (seen.has(grantId)) return fail("conflict", "Canonical share metadata contains duplicate grant IDs", {
        reason: "metadata_conflict", source_path: LEGACY_GRANTS_RECOVERY_PATH, source_revision: sourceEntry.revision,
        target_path: GRANTS_PATH, target_revision: target.entry.revision,
      });
      seen.add(grantId); existing.push(item);
    }
    if (canonicalJson(existing) === canonicalJson(mapped)) {
      return { status: "already_imported", source_path: LEGACY_GRANTS_RECOVERY_PATH, target_path: GRANTS_PATH,
        grant_count: mapped.length, legacy_project_id: legacyProjectId, repository_id: repositoryId, branch };
    }
    return fail("conflict", "A different canonical share-grant file already exists; no metadata was changed", {
      reason: "metadata_conflict", source_path: LEGACY_GRANTS_RECOVERY_PATH, source_revision: sourceEntry.revision,
      target_path: GRANTS_PATH, target_revision: target.entry.revision,
    });
  }
  const bytes = new TextEncoder().encode(mapped.map(grant => JSON.stringify(grant)).join("\n") + "\n");
  const id = `publishing-grant-recovery-${context.idempotency_key}`;
  const proposal = yield* host.request<{ proposal_id: string }>(HOST_OPERATIONS.propose, {
    changeset: {
      id, idempotency_key: context.idempotency_key, scope: context.scope, snapshot: context.snapshot,
      title: "旧共有権限を復旧",
      reason: "Restore explicitly mapped hash-only legacy Publishing grants through Host review.",
      read_set: [
        { path: LEGACY_GRANTS_RECOVERY_PATH, revision: sourceEntry.revision },
        { path: GRANTS_PATH, revision: null },
      ],
      units: [{
        id: `publishing-grant-recovery-unit-${context.idempotency_key}`, label: "旧共有権限を復旧", depends_on: [],
        operations: [{ id: `publishing-grant-recovery-write-${context.idempotency_key}`, kind: "create", path: GRANTS_PATH,
          expected_revision: null, content: Array.from(bytes) }],
      }],
      evidence: [],
      domain_evidence: [{ kind: "publishing.legacy_share_grants", source_path: LEGACY_GRANTS_RECOVERY_PATH,
        source_revision: sourceEntry.revision, target_path: GRANTS_PATH, target_revision: null,
        legacy_project_id: legacyProjectId, repository_id: repositoryId, branch, grant_count: mapped.length }],
    },
  });
  if (!proposal || typeof proposal.proposal_id !== "string") return fail("storage_unknown", "Host did not return a retained share-grant proposal receipt");
  return { change_set_id: id, proposal_id: proposal.proposal_id, status: "proposed",
    preview: { source_path: LEGACY_GRANTS_RECOVERY_PATH, target_path: GRANTS_PATH, legacy_project_id: legacyProjectId,
      repository_id: repositoryId, branch, grant_count: mapped.length } };
}

function* recoveryHostGrantPropose(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const sourceName = input.source_name;
  const sourceSha256 = input.source_sha256;
  const legacyProjectId = input.legacy_project_id;
  const repositoryId = context.scope.repository_id;
  const branch = context.scope.branch;
  if ((sourceName !== "app-state/share-tokens.json" && sourceName !== "share-tokens.json") ||
      typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sourceSha256) ||
      typeof legacyProjectId !== "string" || !validLegacyProjectId(legacyProjectId) ||
      !Number.isSafeInteger(repositoryId) || (repositoryId as number) < 1 ||
      input.repository_id_confirmation !== repositoryId || typeof branch !== "string" || !branch ||
      input.branch_confirmation !== branch || !Array.isArray(input.grants) || input.grants.length < 1 || input.grants.length > 1000) {
    return fail("invalid_input", "Host recovery data must include a source digest, explicit legacy project mapping, and bounded hash-only grants", {
      reason: "invalid_host_recovery_input",
    });
  }
  if (!context.idempotency_key) return fail("invalid_input", "Publishing recovery requires an idempotency key");
  const grants: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const [index, value] of input.grants.entries()) {
    const item = record(value);
    if (!item || item.projectId !== legacyProjectId) return fail("ambiguous_identity",
      `Host recovery grant ${index + 1} does not match the explicitly selected legacy project ID`, { reason: "foreign_project" });
    const grant = mapLegacyShareGrant(item, index + 1, legacyProjectId, repositoryId as number, branch);
    const grantId = grant.id as string;
    if (ids.has(grantId)) return fail("unsupported_format", `Duplicate Host recovery grant ID ${grantId}`, { reason: "duplicate_id" });
    ids.add(grantId);
    if ((grant.scope as Record<string, unknown>).kind !== "project") {
      yield* validateShareScope(host, context, grant.scope as { kind: "volume" | "chapter" | "scene"; id: string });
    }
    grants.push(grant);
  }
  const target = yield* readRecoveryBytes(host, context, GRANTS_PATH);
  const existing: Record<string, unknown>[] = [];
  const existingById = new Map<string, Record<string, unknown>>();
  for (const [index, line] of decodeUtf8(target.bytes, GRANTS_PATH).split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { return fail("conflict", "Canonical share metadata is malformed; Host recovery did not change it", {
      reason: "metadata_conflict", source_name: sourceName, source_sha256: sourceSha256,
      target_path: GRANTS_PATH, target_revision: target.entry?.revision ?? null,
    }); }
    if (hasUnsafeShareFields(parsed)) return fail("conflict", "Canonical share metadata contains account or bearer data", {
      reason: "metadata_conflict", source_name: sourceName, source_sha256: sourceSha256,
      target_path: GRANTS_PATH, target_revision: target.entry?.revision ?? null,
    });
    let item: Record<string, unknown>;
    try { item = parseShareGrant(parsed, index + 1); }
    catch { return fail("conflict", "Canonical share metadata contains an invalid descriptor", {
      reason: "metadata_conflict", source_name: sourceName, source_sha256: sourceSha256,
      target_path: GRANTS_PATH, target_revision: target.entry?.revision ?? null,
    }); }
    const grantId = item.id as string;
    if (existingById.has(grantId)) return fail("conflict", "Canonical share metadata contains duplicate grant IDs", {
      reason: "metadata_conflict", source_name: sourceName, source_sha256: sourceSha256,
      target_path: GRANTS_PATH, target_revision: target.entry?.revision ?? null,
    });
    existingById.set(grantId, item); existing.push(item);
  }
  if (target.entry) {
    if (canonicalJson(existing) === canonicalJson(grants)) return {
      status: "already_imported", source_name: sourceName, source_sha256: sourceSha256,
      legacy_project_id: legacyProjectId, repository_id: repositoryId, branch,
      target_path: GRANTS_PATH, grant_count: grants.length, added_count: 0,
    };
    return fail("conflict", "A different canonical share-grant file already exists; Host recovery did not concatenate or overwrite it", {
      reason: "metadata_conflict", source_name: sourceName, source_sha256: sourceSha256,
      target_path: GRANTS_PATH, target_revision: target.entry.revision,
    });
  }
  const content = new TextEncoder().encode(grants.map(grant => JSON.stringify(grant)).join("\n") + "\n");
  if (content.byteLength > MAX_RECOVERY_BYTES) return fail("capacity", "Restored share metadata exceeds the proposal size limit", { path: GRANTS_PATH });
  const id = `publishing-host-grant-recovery-${context.idempotency_key}`;
  const proposal = yield* host.request<{ proposal_id: string }>(HOST_OPERATIONS.propose, {
    changeset: {
      id, idempotency_key: context.idempotency_key, scope: context.scope, snapshot: context.snapshot,
      title: "Host-local の旧共有権限を復旧",
      reason: "Restore explicitly mapped hash-only Host-local Publishing grants through Host review.",
      read_set: [{ path: GRANTS_PATH, revision: null }],
      units: [{
        id: `publishing-host-grant-recovery-unit-${context.idempotency_key}`, label: "旧共有権限を復旧", depends_on: [],
        operations: [{ id: `publishing-host-grant-recovery-write-${context.idempotency_key}`,
          kind: "create", path: GRANTS_PATH,
          expected_revision: null, content: Array.from(content) }],
      }],
      evidence: [],
      domain_evidence: [{ kind: "publishing.host_local_share_grants", source_name: sourceName,
        source_sha256: sourceSha256, legacy_project_id: legacyProjectId, repository_id: repositoryId,
        branch, target_path: GRANTS_PATH, target_revision: null,
        grant_count: grants.length, added_count: grants.length }],
    },
  });
  if (!proposal || typeof proposal.proposal_id !== "string") return fail("storage_unknown", "Host did not return a local share-grant recovery receipt");
  return { change_set_id: id, proposal_id: proposal.proposal_id, status: "proposed",
    preview: { source_name: sourceName, source_sha256: sourceSha256, legacy_project_id: legacyProjectId,
      repository_id: repositoryId, branch, target_path: GRANTS_PATH, grant_count: grants.length, added_count: grants.length } };
}

function* recoveryPropose(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const sourcePath = input.source_path;
  if (typeof sourcePath !== "string" || !EPISODE_RECOVERY_PATHS.includes(sourcePath as typeof EPISODE_RECOVERY_PATHS[number])) {
    return fail("invalid_input", "Unsupported Publishing recovery source path");
  }
  if (!context.idempotency_key) return fail("invalid_input", "Publishing recovery requires an idempotency key");
  const source = yield* readRecoveryBytes(host, context, sourcePath);
  if (!source.entry) return fail("file_not_found", `Publishing recovery source is unavailable: ${sourcePath}`, { path: sourcePath, reason: "missing_source" });
  if (source.bytes.byteLength > MAX_RECOVERY_BYTES) return fail("capacity", "Publishing recovery source exceeds the proposal size limit", { path: sourcePath });
  const text = decodeUtf8(source.bytes, sourcePath);
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) return fail("unsupported_format", `Invalid episode metadata in ${sourcePath}`, { path: sourcePath, reason: "invalid_source" });
  const episodes = episodeRows(document, sourcePath);
  const target = yield* readRecoveryBytes(host, context, EPISODES_PATH);
  if (target.entry) {
    const identical = target.bytes.byteLength === source.bytes.byteLength && target.bytes.every((byte, index) => byte === source.bytes[index]);
    if (identical) return { status: "already_imported", source_path: sourcePath, target_path: EPISODES_PATH, episode_count: episodes.length };
    return fail("conflict", "A different canonical episode map already exists; no data was changed", {
      reason: "metadata_conflict", source_path: sourcePath, source_revision: source.entry.revision,
      target_path: EPISODES_PATH, target_revision: target.entry.revision,
    });
  }
  const id = `publishing-recovery-${context.idempotency_key}`;
  const proposal = yield* host.request<{ proposal_id: string }>(HOST_OPERATIONS.propose, {
    changeset: {
      id, idempotency_key: context.idempotency_key, scope: context.scope, snapshot: context.snapshot,
      title: "公開回マップを復旧",
      reason: "Import the exact validated legacy Publishing episode-map bytes through Host review.",
      read_set: [
        { path: sourcePath, revision: source.entry.revision },
        { path: EPISODES_PATH, revision: null },
      ],
      units: [{
        id: `publishing-recovery-unit-${context.idempotency_key}`, label: "公開回マップを復旧", depends_on: [],
        operations: [{
          id: `publishing-recovery-write-${context.idempotency_key}`, kind: "create", path: EPISODES_PATH,
          expected_revision: null, content: Array.from(source.bytes),
        }],
      }],
      evidence: [],
      domain_evidence: [{ kind: "publishing.legacy_episode_map", source_path: sourcePath,
        source_revision: source.entry.revision, target_path: EPISODES_PATH, target_revision: null, episode_count: episodes.length }],
    },
  });
  if (!proposal || typeof proposal.proposal_id !== "string") return fail("storage_unknown", "Host did not return a Publishing recovery proposal receipt");
  return {
    change_set_id: id, proposal_id: proposal.proposal_id, status: "proposed",
    preview: { source_path: sourcePath, target_path: EPISODES_PATH, episode_count: episodes.length },
  };
}

function validPublicationDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) return false;
  const day = value.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) return false;
  return !value.includes("T") || Number.isFinite(Date.parse(value));
}

function* episodeRead(_input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const source = yield* readEpisodeDocument(host, context);
  const rows = episodeRows(source.document);
  const recoveryPaths = [
    "meta/publish-episodes.yaml", "app-state/share-tokens.json", "share-tokens.json",
    "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml",
    "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl",
  ];
  let recoveryAvailable = false;
  for (const path of recoveryPaths) if ((yield* listFiles(host, context, path)).some(file => file.path === path)) recoveryAvailable = true;
  return {
    episodes: rows,
    source_path: EPISODES_PATH,
    source_revision: source.revision,
    recovery_available: recoveryAvailable,
  };
}

function validateEpisodeInputs(value: unknown): EpisodeInput[] {
  if (!Array.isArray(value)) return fail("invalid_input", "episodes must be an array");
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const result: EpisodeInput[] = value.map((candidate, index) => {
    const item = record(candidate);
    if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 128 ||
        !Number.isSafeInteger(item.number) || (item.number as number) < 1 ||
        typeof item.title !== "string" || !item.title.trim() || item.title.length > 200 ||
        (item.scope !== "volume" && item.scope !== "chapter") || typeof item.scope_id !== "string" || !item.scope_id.trim() ||
        (item.published_at !== undefined && item.published_at !== null &&
          (typeof item.published_at !== "string" || (item.published_at !== "" && !validPublicationDate(item.published_at)))) ||
        (item.scene_ids !== undefined && item.scene_ids !== null &&
          (!Array.isArray(item.scene_ids) || item.scene_ids.some(id => typeof id !== "string" || !id.trim())))) {
      return fail("invalid_input", `Invalid episode input at index ${index}`);
    }
    if (ids.has(item.id) || numbers.has(item.number as number)) return fail("invalid_input", "Episode IDs and numbers must be unique");
    ids.add(item.id); numbers.add(item.number as number);
    if (Array.isArray(item.scene_ids)) {
      const sceneIds = item.scene_ids as string[];
      if (new Set(sceneIds).size !== sceneIds.length) return fail("invalid_input", "Episode scene IDs must be unique");
    }
    if (item.scope !== "chapter" && item.scene_ids !== undefined && item.scene_ids !== null) {
      return fail("invalid_input", "Scene annotations require a chapter-scoped episode");
    }
    return {
      id: item.id, number: item.number as number, title: item.title.trim(), scope: item.scope,
      scope_id: item.scope_id.trim(),
      ...(item.published_at === undefined ? {} : { published_at: item.published_at === "" ? null : item.published_at as string | null }),
      ...(item.scene_ids === undefined ? {} : { scene_ids: Array.isArray(item.scene_ids) && item.scene_ids.length === 0 ? null : item.scene_ids as string[] | null }),
    };
  });
  return result.sort((left, right) => left.number - right.number || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function validateEpisodeTargets(inputs: readonly EpisodeInput[], tree: TreeData): string[] {
  const readPaths = new Set<string>();
  const volumesById = new Map<string, typeof tree.volumes>();
  for (const volume of tree.volumes) {
    const matches = volumesById.get(volume.item.id) ?? [];
    matches.push(volume); volumesById.set(volume.item.id, matches);
  }
  const chaptersById = new Map<string, Array<{ volume: typeof tree.volumes[number]; chapter: typeof tree.volumes[number]["chapters"][number] }>>();
  for (const volume of tree.volumes) for (const chapter of volume.chapters) {
    const matching = chaptersById.get(chapter.item.id) ?? [];
    matching.push({ volume, chapter }); chaptersById.set(chapter.item.id, matching);
  }
  const addPath = (path: string) => {
    if (!safeRelativePath(path)) return fail("invalid_path", "Narrative returned an unsafe metadata path", { path, reason: "invalid_source" });
    readPaths.add(path);
  };
  for (const episode of inputs) {
    if (episode.scope === "volume") {
      const matches = volumesById.get(episode.scope_id) ?? [];
      if (matches.length > 1) return fail("ambiguous_identity", `Episode volume ${episode.scope_id} is ambiguous`);
      const volume = matches[0];
      if (!volume) return fail("invalid_input", `Unknown episode volume ${episode.scope_id}`, { reason: "invalid_source" });
      assertSelectedTreeHealthy(tree, [volume.item]);
      addPath(volume.item.metadata_path);
      continue;
    }
    const chapters = chaptersById.get(episode.scope_id) ?? [];
    if (chapters.length > 1) return fail("ambiguous_identity", `Episode chapter ${episode.scope_id} is ambiguous`);
    const match = chapters[0];
    if (!match) return fail("invalid_input", `Unknown episode chapter ${episode.scope_id}`, { reason: "invalid_source" });
    const sceneIds = episode.scene_ids;
    const scenes = sceneIds?.length ? match.chapter.scenes.filter(scene => sceneIds.includes(scene.id)) : [];
    if (sceneIds && scenes.length !== sceneIds.length) {
      return fail("invalid_input", `Episode ${episode.id} contains a scene outside chapter ${episode.scope_id}`, { reason: "invalid_source" });
    }
    assertSelectedTreeHealthy(tree, [match.volume.item, match.chapter.item, ...scenes]);
    addPath(match.volume.item.metadata_path);
    addPath(match.chapter.item.metadata_path);
    for (const scene of scenes) addPath(scene.metadata_path);
  }
  return [...readPaths].sort();
}

function mergedEpisodeDocument(document: ReturnType<typeof parseDocument>, inputs: readonly EpisodeInput[]): string {
  if (!isMap(document.contents)) return fail("unsupported_format", `Invalid episode metadata in ${EPISODES_PATH}`, { path: EPISODES_PATH });
  const root = document.contents;
  let sequenceNode: unknown = root.get("episodes", true);
  if (sequenceNode === undefined) {
    const created = document.createNode([]) as unknown as YAMLSeq;
    sequenceNode = created;
    root.set("episodes", created);
  }
  if (!isSeq(sequenceNode)) return fail("unsupported_format", `Episode metadata must contain an episodes sequence`, { path: EPISODES_PATH });
  const sequence = sequenceNode as YAMLSeq;
  const prior = new Map<string, YAMLMap>();
  for (const row of sequence.items) {
    if (!isMap(row)) continue;
    const id = row.get("id");
    if (typeof id === "string") prior.set(id, row as YAMLMap);
  }
  const rows: YAMLMap[] = [];
  for (const episode of inputs) {
    const row = prior.get(episode.id) ?? document.createNode({}) as YAMLMap;
    if (!isMap(row)) return fail("unsupported_format", "Could not create an episode YAML mapping");
    row.set("id", episode.id);
    row.set("number", episode.number);
    row.set("title", episode.title);
    row.set("scope", episode.scope);
    row.set("scopeId", episode.scope_id);
    if (episode.published_at === null) row.delete("publishedAt");
    else if (typeof episode.published_at === "string") row.set("publishedAt", episode.published_at);
    if (episode.scene_ids === null) row.delete("sceneIds");
    else if (Array.isArray(episode.scene_ids)) row.set("sceneIds", episode.scene_ids);
    rows.push(row as YAMLMap);
  }
  sequence.items = rows;
  return document.toString({ lineWidth: 0 });
}

function* episodePropose(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  if (!context.idempotency_key) return fail("invalid_input", "Episode proposals require an idempotency key");
  const episodes = validateEpisodeInputs(input.episodes);
  const expectedRevision = input.expected_metadata_revision;
  if (expectedRevision !== null && typeof expectedRevision !== "string") return fail("invalid_input", "expected_metadata_revision must be a revision or null");
  const expectedTreeRevision = input.expected_tree_revision;
  if (typeof expectedTreeRevision !== "string" || !expectedTreeRevision) return fail("invalid_input", "expected_tree_revision is required");
  const current = yield* readEpisodeDocument(host, context);
  if (current.revision !== expectedRevision) return fail("snapshot_stale", "Episode metadata changed since it was read", { path: EPISODES_PATH, reason: "metadata_conflict" });
  episodeRows(current.document);
  const episodeChapterIds = new Set(episodes.filter(episode => episode.scope === "chapter").map(episode => episode.scope_id));
  const episodeSceneChapterIds = new Set(episodes.filter(episode => episode.scope === "chapter" && Array.isArray(episode.scene_ids) && episode.scene_ids.length > 0)
    .map(episode => episode.scope_id));
  const tree = yield* readTree(host, context, expectedTreeRevision, {
    episode_chapter_ids: episodeChapterIds,
    episode_scene_chapter_ids: episodeSceneChapterIds,
    include_project_metadata: false,
  });
  const hierarchyPaths = validateEpisodeTargets(episodes, tree);
  const content = new TextEncoder().encode(mergedEpisodeDocument(current.document, episodes));
  if (content.byteLength > 128 * 1024) return fail("capacity", "Episode metadata exceeds the Host proposal limit");
  const id = `publishing-episodes-${context.idempotency_key}`;
  const changeset = {
    id,
    idempotency_key: context.idempotency_key,
    scope: context.scope,
    snapshot: context.snapshot,
    title: "公開回マッピングを更新",
    reason: "Author-approved Publishing episode metadata change",
    read_set: [
      { path: EPISODES_PATH, revision: current.revision },
      ...hierarchyPaths.map(path => {
        const item = tree.volumes.flatMap(volume => [volume.item, ...volume.chapters.flatMap(chapter => [chapter.item, ...chapter.scenes])])
          .find(candidate => candidate.metadata_path === path);
        return { path, revision: item?.metadata_revision ?? null };
      }),
    ],
    units: [{
      id: `episode-map-${context.idempotency_key}`,
      label: "公開回マッピング",
      depends_on: [],
      operations: [{
        id: `episode-map-write-${context.idempotency_key}`,
        kind: current.revision === null ? "create" : "replace",
        path: EPISODES_PATH,
        expected_revision: current.revision,
        content: Array.from(content),
      }],
    }],
    evidence: [],
  } as const;
  const proposal = yield* host.request<{ proposal_id: string }>(HOST_OPERATIONS.propose, { changeset });
  if (!proposal || typeof proposal.proposal_id !== "string") return fail("storage_unknown", "Host did not return an episode proposal receipt");
  return {
    change_set_id: id,
    proposal_id: proposal.proposal_id,
    status: "proposed",
    preview: { episode_count: episodes.length, changed_ids: episodes.map(episode => episode.id), target_path: EPISODES_PATH },
  };
}

function scopeValue(scope: unknown): { kind: "volume" | "chapter" | "scene"; id: string } {
  const input = record(scope);
  if (!input || !["volume", "chapter", "scene"].includes(String(input.kind)) || typeof input.id !== "string" || !input.id.trim()) {
    return fail("invalid_input", "Share scope is invalid");
  }
  return { kind: input.kind as "volume" | "chapter" | "scene", id: input.id.trim() };
}

function capabilityQuery(context: ActionRequest): Record<string, unknown> {
  return {
    repository_id: context.scope.repository_id,
    branch: context.scope.branch,
    remote_commit: context.snapshot.remote_commit ?? null,
  };
}

function* validateShareScope(host: Host, context: ActionRequest, scope: { kind: "volume" | "chapter" | "scene"; id: string }): HostGenerator<void> {
  const selection: TreeSelection = scope.kind === "scene"
    ? { include_project_metadata: false }
    : { scope: scope.kind, id: scope.id, include_project_metadata: false };
  const tree = yield* readTree(host, context, undefined, selection);
  if (scope.kind === "volume") {
    const volumes = tree.volumes.filter(volume => volume.item.id === scope.id);
    if (volumes.length > 1) return fail("ambiguous_identity", `Share volume ${scope.id} is ambiguous`);
    const volume = volumes[0];
    if (!volume) return fail("invalid_input", `Share volume ${scope.id} was not found`, { reason: "invalid_scope" });
    assertSelectedTreeHealthy(tree, [volume.item, ...volume.chapters.flatMap(chapter => [chapter.item, ...chapter.scenes])]);
    return;
  }
  if (scope.kind === "chapter") {
    const matches = tree.volumes.flatMap(volume => volume.chapters.filter(chapter => chapter.item.id === scope.id).map(chapter => ({ volume, chapter })));
    if (matches.length > 1) return fail("ambiguous_identity", `Share chapter ${scope.id} is ambiguous`);
    const selected = matches[0];
    if (!selected) return fail("invalid_input", `Share chapter ${scope.id} was not found`, { reason: "invalid_scope" });
    assertSelectedTreeHealthy(tree, [selected.volume.item, selected.chapter.item, ...selected.chapter.scenes]);
    return;
  }
  const matches = tree.volumes.flatMap(volume => volume.chapters.flatMap(chapter =>
    chapter.scenes.filter(scene => scene.id === scope.id).map(scene => ({ volume, chapter, scene }))));
  if (matches.length > 1) return fail("ambiguous_identity", `Share scene ${scope.id} is ambiguous`);
  const selected = matches[0];
  if (!selected) return fail("invalid_input", `Share scene ${scope.id} was not found`, { reason: "invalid_scope" });
  assertSelectedTreeHealthy(tree, [selected.volume.item, selected.chapter.item, selected.scene]);
}

function* shareList(_input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const source = (yield* readOptionalText(host, context, GRANTS_PATH));
  const grants: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const [index, line] of source.text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line) as unknown; }
    catch { return fail("unsupported_format", `Invalid share grant JSONL at line ${index + 1}`, { path: GRANTS_PATH, reason: "invalid_source" }); }
    const item = parseShareGrant(value, index + 1);
    const grantId = item.id as string;
    if (ids.has(grantId)) return fail("unsupported_format", `Duplicate share grant ID ${grantId}`, { path: GRANTS_PATH, reason: "invalid_source" });
    ids.add(grantId);
    grants.push(item);
  }
  let providerConfigured = false;
  try {
    const capability = yield* host.request<{ available?: boolean }>("workspace.capabilities.query", { capability_id: "publishing.share-reader.v1" });
    providerConfigured = capability?.available === true;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "missing_capability" && code !== "capability_denied" && code !== "unsupported_operation") throw error;
  }
  const identity = yield* host.request<{
    publication?: { remote_commit: string | null; files: Array<{ path: string; revision: string | null; remote_confirmed: boolean }> };
  }>("workspace.identity.read", { paths: [GRANTS_PATH] });
  const publication = record(identity?.publication);
  const remoteCommit = typeof publication?.remote_commit === "string" ? publication.remote_commit : null;
  const remoteFiles = Array.isArray(publication?.files) ? publication.files : [];
  const remoteGrantFile = remoteFiles.find(file => record(file)?.path === GRANTS_PATH);
  const sourceRevision = source.entry?.revision ?? null;
  const remoteConfirmed = Boolean(context.snapshot.remote_commit &&
    remoteCommit === context.snapshot.remote_commit &&
    record(remoteGrantFile)?.revision === sourceRevision &&
    record(remoteGrantFile)?.remote_confirmed === true);
  const now = Date.now();
  return {
    provider_configured: providerConfigured,
    shares: grants.map(item => {
      const revoked = typeof item.revokedAt === "string";
      const expiry = Date.parse(String(item.expiresAt));
      const expired = Number.isFinite(expiry) && expiry <= now;
      const status = revoked ? (remoteConfirmed ? "revoked" : "revocation_pending") : expired ? "expired" :
        !providerConfigured ? "provider_unavailable" : remoteConfirmed ? "active" : "pending_publish";
      return {
        id: item.id,
        scope: { kind: (item.scope as Record<string, unknown>).kind, id: (item.scope as Record<string, unknown>).id },
        label: item.label,
        created_at: item.createdAt,
        expires_at: item.expiresAt,
        ...(revoked ? { revoked_at: item.revokedAt } : {}),
        status,
      };
    }),
    source_path: GRANTS_PATH,
    source_revision: source.entry?.revision ?? null,
    remote_snapshot: {
      repository_id: context.scope.repository_id,
      branch: context.scope.branch,
      remote_commit: remoteCommit,
    },
  };
}

function* shareCreate(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const scope = scopeValue({ kind: input.kind, id: input.id });
  const labelValue = typeof input.label === "string" ? input.label.trim().slice(0, 120) : "";
  const label = labelValue || "共有リンク";
  const hours = input.expires_in_hours === undefined ? 24 : input.expires_in_hours;
  if (!Number.isSafeInteger(hours) || (hours as number) < 1 || (hours as number) > 87600) return fail("invalid_input", "Share expiry must be between 1 and 87600 hours");
  if (!context.idempotency_key) return fail("invalid_input", "Share proposals require an idempotency key");
  if (!Number.isSafeInteger(context.scope.repository_id) || (context.scope.repository_id as number) < 1 || !context.snapshot.remote_commit) {
    return fail("provider_unavailable", "Sharing requires a remotely bound repository at a confirmed commit");
  }
  yield* validateShareScope(host, context, scope);
  const current = yield* readOptionalText(host, context, GRANTS_PATH);
  const grants: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const [index, line] of current.text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { return fail("unsupported_format", `Invalid share grant JSONL at line ${index + 1}`, { path: GRANTS_PATH, reason: "invalid_source" }); }
    const item = parseShareGrant(parsed, index + 1);
    const existingId = item.id as string;
    if (ids.has(existingId)) return fail("unsupported_format", `Duplicate share grant ID ${existingId}`, { path: GRANTS_PATH, reason: "invalid_source" });
    ids.add(existingId);
    grants.push(sanitizeShareRecord(item));
  }
  const idDigest = new Sha256().update(new TextEncoder().encode(
    `${context.scope.repository_id}\n${context.scope.branch}\n${context.idempotency_key}`)).digest();
  const grantId = `grant-${idDigest.slice(0, 32)}`;
  if (ids.has(grantId)) return fail("idempotency_conflict", "Share ID already exists for this operation");
  const capability = yield* host.request<{ available?: boolean; max_expiry_hours?: number }>(
    "publishing.share-reader.v1.capabilities", capabilityQuery(context));
  if (!capability?.available) return fail("provider_unavailable", "A trusted Publishing share provider is not configured");
  if (!Number.isSafeInteger(capability.max_expiry_hours) || (capability.max_expiry_hours as number) < 1 ||
      (capability.max_expiry_hours as number) > 87600) return fail("storage_unknown", "Host returned an invalid provider expiry limit");
  if ((hours as number) > (capability.max_expiry_hours as number)) {
    return fail("invalid_input", "Share expiry exceeds the configured provider limit");
  }
  const clock = yield* host.request<{ timestamp: string }>("workspace.change.timestamp", {});
  if (!clock || typeof clock.timestamp !== "string" || !Number.isFinite(Date.parse(clock.timestamp))) {
    return fail("storage_unknown", "Host did not return a stable share timestamp");
  }
  const createdAt = new Date(clock.timestamp).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + (hours as number) * 60 * 60 * 1000).toISOString();
  const secret = yield* host.request<{ handle: string; sha256: string }>("secret.token.create", {
    purpose: "publishing.share", scope, expires_at: expiresAt,
  });
  if (!secret || typeof secret.handle !== "string" || !/^[a-f0-9]{64}$/u.test(secret.sha256)) {
    return fail("storage_unknown", "Host did not return a safe Publishing token handle");
  }
  grants.push({
    version: 1,
    id: grantId,
    tokenHash: secret.sha256,
    scope,
    label,
    createdAt,
    expiresAt,
    repositoryId: context.scope.repository_id,
    branch: context.scope.branch,
  });
  const content = new TextEncoder().encode(grants.map(item => JSON.stringify(sanitizeShareRecord(item))).join("\n") + "\n");
  if (content.byteLength > 128 * 1024) return fail("capacity", "Share metadata exceeds the Host proposal limit");
  const changesetId = `publishing-share-create-${context.idempotency_key}`;
  const changeset = {
    id: changesetId,
    idempotency_key: context.idempotency_key,
    scope: context.scope,
    snapshot: context.snapshot,
    title: "共有リンクを作成",
    reason: "Author-approved Publishing share grant metadata change",
    read_set: [{ path: GRANTS_PATH, revision: current.entry?.revision ?? null }],
    units: [{
      id: `share-create-${context.idempotency_key}`, label: "共有リンク設定", depends_on: [],
      operations: [{ id: `share-create-write-${context.idempotency_key}`, kind: current.entry ? "replace" : "create", path: GRANTS_PATH,
        expected_revision: current.entry?.revision ?? null, content: Array.from(content) }],
    }],
    evidence: [],
  } as const;
  // The Host binds the one-use secret created in this action to this exact
  // ChangeSet before acknowledging the proposal. It never appears in payloads.
  const proposal = yield* host.request<{ proposal_id: string }>(HOST_OPERATIONS.propose, { changeset });
  if (!proposal || typeof proposal.proposal_id !== "string") return fail("storage_unknown", "Host did not return a share proposal receipt");
  return {
    change_set_id: changesetId,
    proposal_id: proposal.proposal_id,
    status: "proposed",
    preview: { grant_id: grantId, scope, label, expires_at: expiresAt, activation: "after_remote_publish" },
  };
}

function* shareRevoke(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  const id = input.id;
  if (typeof id !== "string" || !id) return fail("invalid_input", "Share ID is required");
  const current = yield* readOptionalText(host, context, GRANTS_PATH);
  const expected = input.expected_metadata_revision;
  if (expected !== null && typeof expected !== "string") return fail("invalid_input", "Expected share metadata revision must be a revision or null");
  if ((current.entry?.revision ?? null) !== expected) return fail("snapshot_stale", "Share metadata changed since it was read", { path: GRANTS_PATH });
  const records: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  let found = false;
  let alreadyRevoked = false;
  for (const [index, line] of current.text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { return fail("unsupported_format", `Invalid share grant JSONL at line ${index + 1}`, { path: GRANTS_PATH, reason: "invalid_source" }); }
    const item = sanitizeShareRecord(parseShareGrant(parsed, index + 1));
    if (typeof item.id !== "string") return fail("unsupported_format", `Invalid share grant at line ${index + 1}`, { path: GRANTS_PATH, reason: "invalid_source" });
    if (ids.has(item.id)) return fail("unsupported_format", `Duplicate share grant ID ${item.id}`, { path: GRANTS_PATH, reason: "invalid_source" });
    ids.add(item.id);
    if (item.id === id) {
      found = true;
      if (typeof item.revokedAt === "string") alreadyRevoked = true;
    }
    records.push(item);
  }
  if (!found) return fail("file_not_found", `Share grant ${id} was not found`, { kind: "share_not_found" });
  if (alreadyRevoked) return { status: "already_revoked", id };
  if (!context.idempotency_key) return fail("invalid_input", "Share revoke proposals require an idempotency key");
  const clock = yield* host.request<{ timestamp: string }>("workspace.change.timestamp", {});
  if (!clock || typeof clock.timestamp !== "string" || !Number.isFinite(Date.parse(clock.timestamp))) {
    return fail("storage_unknown", "Host did not return a stable change timestamp");
  }
  const revokedAt = new Date(clock.timestamp).toISOString();
  const target = records.find(item => item.id === id)!;
  target.revokedAt = revokedAt;
  const bytes = new TextEncoder().encode(records.map(item => JSON.stringify(item)).join("\n") + (records.length ? "\n" : ""));
  const changeset = {
    id: `publishing-share-revoke-${context.idempotency_key}`,
    idempotency_key: context.idempotency_key,
    scope: context.scope,
    snapshot: context.snapshot,
    title: "共有リンクを失効",
    reason: "Author-approved Publishing share revocation metadata change",
    read_set: [{ path: GRANTS_PATH, revision: current.entry?.revision ?? null }],
    units: [{
      id: `share-revoke-${context.idempotency_key}`, label: "共有リンク失効", depends_on: [],
      operations: [{ id: `share-revoke-write-${context.idempotency_key}`, kind: current.entry ? "replace" : "create", path: GRANTS_PATH,
        expected_revision: current.entry?.revision ?? null, content: Array.from(bytes) }],
    }],
    evidence: [],
  } as const;
  const proposal = yield* host.request<{ proposal_id: string }>(HOST_OPERATIONS.propose, { changeset });
  if (!proposal || typeof proposal.proposal_id !== "string") return fail("storage_unknown", "Host did not return a share revocation receipt");
  return { change_set_id: changeset.id, proposal_id: proposal.proposal_id, status: "proposed", preview: { id, activation: "after_remote_publish" } };
}

function* projectTree(input: Record<string, unknown>, _context: ActionRequest, host: Host): HostGenerator<unknown> {
  const parentId = input.parent_id === null || input.parent_id === undefined ? null : input.parent_id;
  if (parentId !== null && typeof parentId !== "string") return fail("invalid_input", "parent_id must be a string or null");
  const cursor = typeof input.cursor === "string" ? input.cursor : null;
  const expectedTreeRevision = typeof input.expected_tree_revision === "string" ? input.expected_tree_revision : undefined;
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE) return fail("invalid_input", "Tree page limit is invalid");
  return yield* invokeAction(host, NARRATIVE_ID, TREE_ACTION, {
    parent_id: parentId, ...(cursor ? { cursor } : {}), limit,
    ...(expectedTreeRevision ? { expected_tree_revision: expectedTreeRevision } : {}),
  });
}

function* exportVerticalPrint(input: Record<string, unknown>, context: ActionRequest, host: Host): HostGenerator<unknown> {
  return yield* storeVerticalPrint(input, context, host);
}

export const guest = createGuest(PLUGIN_ID, {
  "proprium.publishing.project.tree": projectTree,
  "proprium.publishing.export.plaintext": (input, context, host) => storePlaintext(input, context, host, input.markup as "raw" | "strip" | "kakuyomu" | "narou"),
  "proprium.publishing.export.epub": storeEpub,
  "proprium.publishing.export.vertical-print": exportVerticalPrint,
  "proprium.publishing.episodes.read": episodeRead,
  "proprium.publishing.episodes.propose": episodePropose,
  "proprium.publishing.recovery.inspect": recoveryInspect,
  "proprium.publishing.recovery.propose": recoveryPropose,
  "proprium.publishing.recovery.grants.propose": recoveryGrantPropose,
  "proprium.publishing.recovery.hostgrants.propose": recoveryHostGrantPropose,
  "proprium.publishing.shares.list": shareList,
  "proprium.publishing.shares.create": shareCreate,
  "proprium.publishing.shares.revoke": shareRevoke,
});
