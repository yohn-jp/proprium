import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  RecentActivityDeviceType,
  RecentActivityInput as ContractRecentActivityInput,
  RecentActivityItem as ContractRecentActivityItem,
  RepositoryIdentity,
} from "@scriptorium/contracts";

export type { RecentActivityDeviceType } from "@scriptorium/contracts";
export type RecentActivityDevice = RecentActivityDeviceType;
export type RecentActivityInput = ContractRecentActivityInput;
export type RecentActivityItem = ContractRecentActivityItem;

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_LEGACY_ADOPTION_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_KEYS = 20_000;
const MAX_ITEMS_PER_KEY = 100;
const ITEM_FIELDS = new Set(["sceneId", "sentenceOffset", "pageIndex", "deviceType", "updatedAt"]);
const INPUT_FIELDS = new Set(["sceneId", "sentenceOffset", "pageIndex", "deviceType"]);
const STATE_FIELDS = new Set(["version", "entries", "legacySources"]);
const ENTRY_FIELDS = new Set(["key", "ownerKey", "repository", "items"]);
const REPOSITORY_FIELDS = new Set(["provider", "repositoryId", "defaultBranch", "ownerScope", "url"]);

export interface LegacyRecentActivityImportOptions {
  workspaceDataRoot: string;
  usageDirectory: string;
  /** Exact source project ID to a host-verified stable repository identity. */
  legacyRepositoryMappings: Readonly<Record<string, RepositoryIdentity>>;
  /** Exact source user ID to the current single API owner. */
  legacyUserMappings: Readonly<Record<string, "owner">>;
}

export interface LegacyRecentActivityImportReport {
  sourceHash: string;
  bytes: number;
  archived: true;
  adoptedItems: number;
  preservedNewerItems: number;
  alreadyImported?: boolean;
  mappingRequired: Array<{ projectKey: string | null; userId: string | null; itemCount: number }>;
  sourcePath?: "app-state/recent-activity.json" | "recent-activity.json" | "multiple";
  sourceFiles?: Array<{ sourcePath: "app-state/recent-activity.json" | "recent-activity.json"; sourceHash: string; bytes: number }>;
  adoptionBlocked?: "adoption_size_limit" | "invalid_json" | "invalid_shape" | "invalid_record" | "history_full";
}

interface StoredEntry {
  key: string;
  ownerKey: string;
  repository: RepositoryIdentity;
  items: RecentActivityItem[];
}

interface StoredState {
  version: 1;
  entries: StoredEntry[];
  legacySources: string[];
}

interface LegacyCandidate {
  ownerScope: string;
  repository: RepositoryIdentity;
  items: Map<RecentActivityDevice, RecentActivityItem>;
}

export class RecentActivityStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RecentActivityStoreError";
  }
}

const queues = new Map<string, Promise<void>>();

/** Host-owned recent editor/reader cursors. Construction performs no filesystem access. */
export class RecentActivityStore {
  private readonly root: string;
  private readonly directory: string;
  private readonly filePath: string;

  constructor(usageDirectory: string) {
    if (typeof usageDirectory !== "string" || !usageDirectory.trim()) {
      throw new RecentActivityStoreError("recent_activity_path_invalid", "A host history directory is required");
    }
    this.root = resolve(usageDirectory);
    this.directory = join(this.root, "recent-activity");
    this.filePath = join(this.directory, "recent-activity-state.json");
  }

  async list(ownerScope: string, repository: RepositoryIdentity): Promise<RecentActivityItem[]> {
    const ownerKey = hash(validateOwnerScope(ownerScope));
    const identity = normalizeRepository(repository);
    const key = partitionKey(ownerKey, identity);
    const state = await this.readState();
    const entry = state.entries.find((candidate) => candidate.key === key);
    if (!entry) return [];
    assertEntryScope(entry, ownerKey, identity);
    return entry.items.map((item) => ({ ...item })).sort(newestFirst);
  }

  async upsert(ownerScope: string, repository: RepositoryIdentity, input: RecentActivityInput): Promise<RecentActivityItem[]> {
    const owner = validateOwnerScope(ownerScope);
    const ownerKey = hash(owner);
    const identity = normalizeRepository(repository);
    const normalizedInput = normalizeInput(input);
    return exclusive(this.filePath, async () => {
      const state = await this.readState();
      const key = partitionKey(ownerKey, identity);
      let entry = state.entries.find((candidate) => candidate.key === key);
      if (entry) {
        assertEntryScope(entry, ownerKey, identity);
        entry.repository = identity;
      } else {
        entry = { key, ownerKey, repository: identity, items: [] };
        state.entries.push(entry);
      }
      const existing = entry.items.find((item) => item.deviceType === normalizedInput.deviceType);
      const item: RecentActivityItem = {
        sceneId: normalizedInput.sceneId,
        sentenceOffset: normalizedInput.sentenceOffset,
        pageIndex: normalizedInput.pageIndex !== undefined ? normalizedInput.pageIndex : existing?.pageIndex ?? null,
        deviceType: normalizedInput.deviceType,
        updatedAt: new Date().toISOString(),
      };
      entry.items = entry.items.filter((candidate) => candidate.deviceType !== item.deviceType);
      entry.items.push(item);
      await this.persist(state);
      return entry.items.map((candidate) => ({ ...candidate })).sort(newestFirst);
    });
  }

  async adoptArchivedLegacy(
    sourceHash: string,
    legacyRepositoryMappings: Readonly<Record<string, RepositoryIdentity>>,
    legacyUserMappings: Readonly<Record<string, "owner">>,
  ): Promise<LegacyRecentActivityImportReport> {
    return this.adoptArchivedLegacySources([sourceHash], legacyRepositoryMappings, legacyUserMappings);
  }

  async adoptArchivedLegacySources(
    sourceHashes: readonly string[],
    legacyRepositoryMappings: Readonly<Record<string, RepositoryIdentity>>,
    legacyUserMappings: Readonly<Record<string, "owner">>,
  ): Promise<LegacyRecentActivityImportReport> {
    return exclusive(this.filePath, async () => {
      const hashes = [...new Set(sourceHashes)];
      if (hashes.length === 0 || hashes.some((sourceHash) => !/^[a-f0-9]{64}$/u.test(sourceHash))) {
        throw new RecentActivityStoreError("legacy_recent_activity_source_invalid", "Recent activity archive identity is invalid");
      }
      const sources = await Promise.all(hashes.map(async (sourceHash) => {
        const archivePath = join(this.directory, "legacy", `${sourceHash}.json`);
        const raw = await readPrivateFile(archivePath, MAX_LEGACY_ARCHIVE_BYTES, "legacy_recent_activity_archive_corrupt");
        if (!raw || hashBytes(raw) !== sourceHash) {
          throw new RecentActivityStoreError("legacy_recent_activity_archive_corrupt", "Recent activity archive is unavailable or failed integrity verification");
        }
        return { sourceHash, raw };
      }));
      const state = await this.readState();
      const report: LegacyRecentActivityImportReport = {
        sourceHash: hashes[0]!,
        bytes: sources.reduce((sum, source) => sum + source.raw.byteLength, 0),
        archived: true,
        adoptedItems: 0,
        preservedNewerItems: 0,
        mappingRequired: [],
      };
      if (hashes.every((sourceHash) => state.legacySources.includes(sourceHash))) return { ...report, alreadyImported: true };
      if (sources.some(({ raw }) => raw.byteLength > MAX_LEGACY_ADOPTION_BYTES)) return { ...report, adoptionBlocked: "adoption_size_limit" };

      const required = new Map<string, { projectKey: string | null; userId: string | null; itemCount: number }>();
      const candidates = new Map<string, LegacyCandidate>();
      let invalidRecords = 0;
      for (const { raw } of sources) {
        let decoded: unknown;
        try { decoded = JSON.parse(raw.toString("utf8")) as unknown; }
        catch { return { ...report, adoptionBlocked: "invalid_json" }; }
        // Match the source store's permissive persisted shape, then expose only the
        // known cursor DTO fields through the target API.
        if (!isRecord(decoded) || !isRecord(decoded.byKey) ||
            Object.keys(decoded.byKey).length > MAX_LEGACY_KEYS) {
          return { ...report, adoptionBlocked: "invalid_shape" };
        }
        for (const [sourceKey, rawItems] of Object.entries(decoded.byKey).sort(([left], [right]) => left.localeCompare(right))) {
          const separator = sourceKey.indexOf(":");
          const userId = separator > 0 ? sourceKey.slice(0, separator) : null;
          const projectKey = separator > 0 && separator < sourceKey.length - 1 ? sourceKey.slice(separator + 1) : null;
          const values = Array.isArray(rawItems) ? rawItems : null;
          if (!values || values.length > MAX_ITEMS_PER_KEY) { invalidRecords += 1; continue; }
          const count = values.length;
          const repositoryValue = projectKey === null ? undefined : ownValue(legacyRepositoryMappings, projectKey);
          const ownerValue = userId === null ? undefined : ownValue(legacyUserMappings, userId);
          if (ownerValue !== "owner" || !isRepositoryIdentity(repositoryValue)) {
            const mappingKey = JSON.stringify([projectKey, userId]);
            const current = required.get(mappingKey) ?? { projectKey, userId, itemCount: 0 };
            current.itemCount += count;
            required.set(mappingKey, current);
            continue;
          }

          let items: RecentActivityItem[];
          try {
            items = values.map((item) => normalizeLegacyItem(item, true));
            if (new Set(items.map(({ deviceType }) => deviceType)).size !== items.length) throw new Error("duplicate device row");
          } catch {
            invalidRecords += 1;
            continue;
          }
          const repository = normalizeRepository(repositoryValue);
          const ownerKey = hash("owner");
          const key = partitionKey(ownerKey, repository);
          let candidate = candidates.get(key);
          if (!candidate) {
            candidate = { ownerScope: "owner", repository, items: new Map() };
            candidates.set(key, candidate);
          }
          for (const item of items) {
            const previous = candidate.items.get(item.deviceType);
            if (!previous || Date.parse(item.updatedAt) > Date.parse(previous.updatedAt)) {
              candidate.items.set(item.deviceType, item);
            } else if (Date.parse(item.updatedAt) === Date.parse(previous.updatedAt) && !sameCursor(item, previous)) {
              invalidRecords += 1;
            }
          }
        }
      }
      report.mappingRequired = [...required.values()].sort((left, right) =>
        (left.projectKey ?? "").localeCompare(right.projectKey ?? "") || (left.userId ?? "").localeCompare(right.userId ?? ""));
      if (invalidRecords > 0) return { ...report, adoptionBlocked: "invalid_record" };

      for (const candidate of candidates.values()) {
        const ownerKey = hash(candidate.ownerScope);
        const key = partitionKey(ownerKey, candidate.repository);
        let entry = state.entries.find((value) => value.key === key);
        if (!entry) {
          entry = { key, ownerKey, repository: candidate.repository, items: [] };
          state.entries.push(entry);
        } else {
          assertEntryScope(entry, ownerKey, candidate.repository);
          entry.repository = candidate.repository;
        }
        for (const item of candidate.items.values()) {
          const existing = entry.items.find((value) => value.deviceType === item.deviceType);
          if (existing && Date.parse(item.updatedAt) <= Date.parse(existing.updatedAt)) {
            report.preservedNewerItems += 1;
            continue;
          }
          entry.items = entry.items.filter((value) => value.deviceType !== item.deviceType);
          entry.items.push({ ...item });
          report.adoptedItems += 1;
        }
      }
      if (report.mappingRequired.length === 0) {
        for (const sourceHash of hashes) if (!state.legacySources.includes(sourceHash)) state.legacySources.push(sourceHash);
      }
      if (state.entries.length > MAX_LEGACY_KEYS || Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) {
        return { ...report, adoptedItems: 0, preservedNewerItems: 0, adoptionBlocked: "history_full" };
      }
      if (report.adoptedItems > 0 || report.mappingRequired.length === 0) await this.persist(state);
      return report;
    });
  }

  private async readState(): Promise<StoredState> {
    try { await assertPrivateDirectory(this.root); }
    catch (error) { if (isCode(error, "ENOENT")) return emptyState(); throw error; }
    try { await assertPrivateDirectory(this.directory); }
    catch (error) { if (isCode(error, "ENOENT")) return emptyState(); throw error; }
    const bytes = await readPrivateFile(this.filePath, MAX_STATE_BYTES, "recent_activity_state_corrupt", true);
    if (!bytes) return emptyState();
    let decoded: unknown;
    try { decoded = JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { throw new RecentActivityStoreError("recent_activity_state_corrupt", "Recent activity history is not valid JSON"); }
    return normalizeState(decoded);
  }

  private async persist(state: StoredState): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(this.directory);
    await syncDirectory(this.root);
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new RecentActivityStoreError("recent_activity_history_full", "Recent activity history exceeds its storage limit");
    }
    const temporary = join(this.directory, `.tmp-${randomBytes(16).toString("hex")}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      await syncDirectory(this.directory);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}

/** Archives the source bytes exactly and imports only explicitly mapped owner/repository rows. */
export async function importLegacyRecentActivity(options: LegacyRecentActivityImportOptions): Promise<LegacyRecentActivityImportReport> {
  if (!options.workspaceDataRoot?.trim() || !options.usageDirectory?.trim()) {
    throw new RecentActivityStoreError("legacy_recent_activity_path_invalid", "Legacy and host history directories are required");
  }
  if (!isRecord(options.legacyRepositoryMappings) || !isRecord(options.legacyUserMappings)) {
    throw new RecentActivityStoreError("legacy_recent_activity_mapping_invalid", "Explicit legacy repository and owner mappings are required");
  }
  const workspaceDataRoot = resolve(options.workspaceDataRoot);
  const usageDirectory = resolve(options.usageDirectory);
  if (isWithin(workspaceDataRoot, usageDirectory) || isWithin(usageDirectory, workspaceDataRoot)) {
    throw new RecentActivityStoreError("legacy_recent_activity_path_invalid", "Legacy recent activity must be archived outside the disposable workspace data root");
  }
  await assertPrivateDirectory(workspaceDataRoot);
  const sourceDirectory = join(workspaceDataRoot, "app-state");
  try { await assertPrivateDirectory(sourceDirectory); }
  catch (error) { if (!isCode(error, "ENOENT")) throw error; }
  const canonicalBytes = await readPrivateFile(join(sourceDirectory, "recent-activity.json"), MAX_LEGACY_ARCHIVE_BYTES, "legacy_recent_activity_file_invalid", true);
  const aliasBytes = await readPrivateFile(join(workspaceDataRoot, "recent-activity.json"), MAX_LEGACY_ARCHIVE_BYTES, "legacy_recent_activity_file_invalid", true);
  if (!canonicalBytes && !aliasBytes) {
    throw new RecentActivityStoreError("legacy_recent_activity_file_unavailable", "Legacy recent activity file is unavailable");
  }
  const sourceFiles: NonNullable<LegacyRecentActivityImportReport["sourceFiles"]> = [];
  if (canonicalBytes) sourceFiles.push({ sourcePath: "app-state/recent-activity.json", sourceHash: hashBytes(canonicalBytes), bytes: canonicalBytes.byteLength });
  if (aliasBytes) sourceFiles.push({ sourcePath: "recent-activity.json", sourceHash: hashBytes(aliasBytes), bytes: aliasBytes.byteLength });
  for (const source of sourceFiles) {
    const bytes = source.sourcePath === "app-state/recent-activity.json" ? canonicalBytes! : aliasBytes!;
    await archiveLegacySource(usageDirectory, source.sourceHash, bytes);
  }

  const store = new RecentActivityStore(usageDirectory);
  const sourceHashes = sourceFiles.map(({ sourceHash }) => sourceHash);
  const report = await store.adoptArchivedLegacySources(sourceHashes, options.legacyRepositoryMappings, options.legacyUserMappings);
  return {
    ...report,
    bytes: sourceFiles.reduce((sum, source) => sum + source.bytes, 0),
    sourcePath: sourceFiles.length > 1 ? "multiple" : sourceFiles[0]!.sourcePath,
    sourceFiles,
  };
}

async function archiveLegacySource(usageDirectory: string, sourceHash: string, sourceBytes: Buffer): Promise<void> {
  const root = resolve(usageDirectory);
  const directory = join(root, "recent-activity");
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(directory);
  const legacyDirectory = join(directory, "legacy");
  await ensurePrivateDirectory(legacyDirectory);
  await syncDirectory(root);
  await syncDirectory(directory);
  await archiveImmutable(join(legacyDirectory, `${sourceHash}.json`), legacyDirectory, sourceBytes);
}

function normalizeInput(value: unknown): RecentActivityInput {
  if (!isRecord(value) || !hasOnlyKeys(value, INPUT_FIELDS)) invalidRecord("Recent activity input is invalid");
  const sceneId = boundedText(value.sceneId, 1, 512, /^[^\x00-\x1f\x7f]+$/u, "scene ID");
  const sentenceOffset = value.sentenceOffset;
  if (sentenceOffset !== null && !Number.isSafeInteger(sentenceOffset)) invalidRecord("Recent activity sentence offset is invalid");
  if (value.deviceType !== "desktop" && value.deviceType !== "mobile") invalidRecord("Recent activity device type is invalid");
  if (value.pageIndex !== undefined && value.pageIndex !== null && (!Number.isSafeInteger(value.pageIndex) || (value.pageIndex as number) < 0)) {
    invalidRecord("Recent activity page index is invalid");
  }
  return {
    sceneId,
    sentenceOffset: sentenceOffset as number | null,
    ...(value.pageIndex === undefined ? {} : { pageIndex: value.pageIndex as number | null }),
    deviceType: value.deviceType,
  };
}

function normalizeLegacyItem(value: unknown, stripUnknownFields = false): RecentActivityItem {
  if (!isRecord(value) || (!stripUnknownFields && !hasOnlyKeys(value, ITEM_FIELDS))) invalidRecord("Legacy recent activity item is invalid");
  const input = normalizeInput({
    sceneId: value.sceneId,
    sentenceOffset: value.sentenceOffset,
    ...(value.pageIndex === undefined ? {} : { pageIndex: value.pageIndex }),
    deviceType: value.deviceType,
  });
  if (typeof value.updatedAt !== "string" || !value.updatedAt.trim()) invalidRecord("Legacy recent activity timestamp is invalid");
  const updatedAt = timestamp(value.updatedAt);
  return {
    sceneId: input.sceneId,
    sentenceOffset: input.sentenceOffset,
    pageIndex: input.pageIndex ?? null,
    deviceType: input.deviceType,
    updatedAt,
  };
}

function normalizeState(value: unknown): StoredState {
  if (!isRecord(value) || !hasOnlyKeys(value, STATE_FIELDS) || value.version !== 1 ||
      !Array.isArray(value.entries) || value.entries.length > MAX_LEGACY_KEYS || !Array.isArray(value.legacySources)) {
    throw new RecentActivityStoreError("recent_activity_state_corrupt", "Recent activity history contains invalid metadata");
  }
  const entries = value.entries.map((raw): StoredEntry => {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ENTRY_FIELDS) || typeof raw.key !== "string" || !/^[a-f0-9]{64}$/u.test(raw.key) ||
        typeof raw.ownerKey !== "string" || !/^[a-f0-9]{64}$/u.test(raw.ownerKey) || !isRepositoryIdentity(raw.repository) ||
        !Array.isArray(raw.items) || raw.items.length > 2) corruptState();
    const repository = normalizeRepository(raw.repository);
    const items = raw.items.map((item) => normalizeLegacyItem(item));
    if (new Set(items.map(({ deviceType }) => deviceType)).size !== items.length || raw.key !== partitionKey(raw.ownerKey, repository)) corruptState();
    return { key: raw.key, ownerKey: raw.ownerKey, repository, items };
  });
  if (new Set(entries.map(({ key }) => key)).size !== entries.length) corruptState();
  const legacySources = value.legacySources.map((source) => {
    if (typeof source !== "string" || !/^[a-f0-9]{64}$/u.test(source)) corruptState();
    return source;
  });
  if (new Set(legacySources).size !== legacySources.length) corruptState();
  return { version: 1, entries, legacySources };
}

function assertEntryScope(entry: StoredEntry, ownerKey: string, repository: RepositoryIdentity): void {
  if (entry.ownerKey !== ownerKey || partitionKey(entry.ownerKey, entry.repository) !== entry.key ||
      partitionKey(ownerKey, repository) !== entry.key) {
    throw new RecentActivityStoreError("recent_activity_identity_conflict", "Recent activity belongs to a different owner or repository identity");
  }
}

function normalizeRepository(value: RepositoryIdentity): RepositoryIdentity {
  if (!isRepositoryIdentity(value)) invalidRecord("Repository identity is invalid");
  const identity: RepositoryIdentity = {
    provider: value.provider,
    repositoryId: boundedText(value.repositoryId, 1, 256, /^[A-Za-z0-9._:-]+$/u, "repository ID"),
    defaultBranch: boundedText(value.defaultBranch, 1, 256, /^[^\x00-\x1f\x7f]+$/u, "default branch"),
    ownerScope: boundedText(value.ownerScope, 1, 256, /^[^\x00-\x1f\x7f]+$/u, "repository owner scope"),
    url: boundedText(value.url, 1, 2_048, /^[^\x00-\x1f\x7f]+$/u, "repository URL"),
  };
  if (identity.provider === "github") {
    let parsed: URL;
    try { parsed = new URL(identity.url); } catch { invalidRecord("Repository URL is invalid"); }
    if (parsed!.protocol !== "https:" || parsed!.hostname !== "github.com" || parsed!.username || parsed!.password || parsed!.search || parsed!.hash) {
      invalidRecord("GitHub repository identity is invalid");
    }
  }
  return identity;
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  return isRecord(value) && hasOnlyKeys(value, REPOSITORY_FIELDS) &&
    (value.provider === "github" || value.provider === "local") &&
    typeof value.repositoryId === "string" && typeof value.defaultBranch === "string" &&
    typeof value.ownerScope === "string" && typeof value.url === "string";
}

function validateOwnerScope(value: unknown): string {
  return boundedText(value, 1, 256, /^[^\x00-\x1f\x7f]+$/u, "owner scope");
}

function partitionKey(ownerKey: string, repository: RepositoryIdentity): string {
  return hash(`${ownerKey}\0${repository.provider}\0${repository.ownerScope}\0${repository.repositoryId}`);
}

function newestFirst(left: RecentActivityItem, right: RecentActivityItem): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.deviceType.localeCompare(right.deviceType);
}

function sameCursor(left: RecentActivityItem, right: RecentActivityItem): boolean {
  return left.sceneId === right.sceneId && left.sentenceOffset === right.sentenceOffset && left.pageIndex === right.pageIndex && left.deviceType === right.deviceType;
}

function emptyState(): StoredState { return { version: 1, entries: [], legacySources: [] }; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.has(key));
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function boundedText(value: unknown, min: number, max: number, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !pattern.test(value)) {
    invalidRecord(`Recent activity ${field} is invalid`);
  }
  return value as string;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    invalidRecord("Recent activity timestamp is invalid");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalidRecord("Recent activity timestamp is invalid");
  return parsed.toISOString();
}

function isWithin(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !/^[A-Za-z]:/u.test(path));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function hashBytes(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function invalidRecord(message = "Recent activity metadata is invalid"): never {
  throw new RecentActivityStoreError("recent_activity_record_invalid", message);
}

function corruptState(): never {
  throw new RecentActivityStoreError("recent_activity_state_corrupt", "Recent activity history contains invalid metadata");
}

async function exclusive<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  queues.set(path, current);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (queues.get(path) === current) queues.delete(path);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RecentActivityStoreError("recent_activity_path_invalid", "Recent activity history must use real directories");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new RecentActivityStoreError("recent_activity_path_permissions", "Recent activity history directories must be private");
  }
}

async function readPrivateFile(path: string, maxBytes: number, code: string, optional = false): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0) {
      throw new RecentActivityStoreError(code, "Recent activity file must be private, regular, and within its size limit");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof RecentActivityStoreError) throw error;
    if (optional && isCode(error, "ENOENT")) return undefined;
    throw new RecentActivityStoreError(code, "Recent activity file cannot be read safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function archiveImmutable(targetPath: string, directory: string, bytes: Buffer): Promise<void> {
  const temporary = join(directory, `.legacy-${randomBytes(16).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await link(temporary, targetPath); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const retained = await readPrivateFile(targetPath, MAX_LEGACY_ARCHIVE_BYTES, "legacy_recent_activity_archive_corrupt");
      if (!retained?.equals(bytes)) throw new RecentActivityStoreError("legacy_recent_activity_archive_conflict", "Immutable recent activity archive identity already contains different bytes");
    }
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
