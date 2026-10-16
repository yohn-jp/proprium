import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ModelUsageEvent, ModelUsageStore, RepositoryIdentity } from "@scriptorium/contracts";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_TIMING_MS = 24 * 60 * 60 * 1_000;
const EVENT_FIELDS = new Set([
  "id", "repository", "feature", "provider", "model", "startedAt", "completedAt", "state",
  "inputTokens", "outputTokens", "cost", "cacheHit", "promptVersion", "durationMs", "queueWaitMs", "errorCode",
]);
const REPOSITORY_FIELDS = new Set(["provider", "repositoryId", "defaultBranch", "ownerScope", "url"]);

export class HistoricalModelUsageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HistoricalModelUsageError";
  }
}

/** Host-owned append-only history. Construction is inert; filesystem access begins on append/list. */
export class HistoricalModelUsageStore implements ModelUsageStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (typeof directory !== "string" || !directory.trim()) {
      throw new HistoricalModelUsageError("model_usage_path_invalid", "A model usage history directory is required");
    }
    this.directory = resolve(directory);
  }

  async append(value: ModelUsageEvent): Promise<void> {
    const event = normalizeEvent(value);
    const root = this.directory;
    await ensureRoot(root);
    const directory = join(root, repositoryKey(event.repository));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(directory);
    await syncDirectory(root);

    const filename = `${hash(event.id)}.json`;
    const destination = join(directory, filename);
    const temporary = join(directory, `.tmp-${randomBytes(16).toString("hex")}`);
    const serialized = `${JSON.stringify(event)}\n`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      try {
        // A hard link publishes the complete, synced file atomically and refuses to replace an ID.
        await link(temporary, destination);
        await syncDirectory(directory);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const existing = await readEvent(destination);
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new HistoricalModelUsageError("model_usage_event_id_conflict", "A model usage event ID already has different immutable content");
        }
        // An earlier writer may have linked the file but failed while syncing this directory.
        // An exact retry is only acknowledged after the directory entry is durable.
        await syncDirectory(directory);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async list(repository: RepositoryIdentity, query: { from?: string; to?: string; limit?: number; cursor?: string } = {}): Promise<{
    events: ModelUsageEvent[];
    nextCursor?: string;
  }> {
    const identity = normalizeRepository(repository);
    const page = normalizeQuery(query);
    const key = repositoryKey(identity);
    if (page.cursor && page.cursor.partition !== key) {
      throw new HistoricalModelUsageError("model_usage_cursor_invalid", "Model usage history cursor belongs to another repository");
    }
    const directory = join(this.directory, key);
    try {
      await assertPrivateDirectory(this.directory);
    } catch (error) {
      if (isCode(error, "ENOENT")) return { events: [] };
      throw error;
    }
    try {
      await assertPrivateDirectory(directory);
    } catch (error) {
      if (isCode(error, "ENOENT")) return { events: [] };
      throw error;
    }

    const events: ModelUsageEvent[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) continue;
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile()) {
        throw new HistoricalModelUsageError("model_usage_history_corrupt", "Model usage history contains an unexpected filesystem entry");
      }
      const event = await readEvent(join(directory, entry.name));
      if (repositoryKey(event.repository) !== key || `${hash(event.id)}.json` !== entry.name) {
        throw new HistoricalModelUsageError("model_usage_history_corrupt", "A model usage history record does not match its repository or event identity");
      }
      if ((!page.from || event.startedAt >= page.from) && (!page.to || event.startedAt <= page.to)) events.push(event);
    }

    events.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
    const afterCursor = page.cursor
      ? events.filter((event) => event.startedAt > page.cursor!.startedAt ||
        event.startedAt === page.cursor!.startedAt && event.id > page.cursor!.id)
      : events;
    const result = afterCursor.slice(0, page.limit);
    const hasMore = afterCursor.length > result.length;
    return {
      events: result,
      ...(hasMore && result.length > 0 ? {
        nextCursor: encodeCursor({
          partition: key,
          from: page.from ?? null,
          to: page.to ?? null,
          startedAt: result.at(-1)!.startedAt,
          id: result.at(-1)!.id,
        }),
      } : {}),
    };
  }
}

function normalizeEvent(value: unknown): ModelUsageEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, EVENT_FIELDS)) invalidEvent();
  const repository = normalizeRepository(value.repository);
  const id = boundedText(value.id, 1, 128, /^[A-Za-z0-9._:-]+$/u, "event ID");
  const feature = boundedText(value.feature, 1, 128, /^[A-Za-z0-9._:-]+$/u, "feature");
  const provider = boundedText(value.provider, 1, 128, /^[A-Za-z0-9._:-]+$/u, "provider");
  const model = boundedText(value.model, 1, 192, /^[A-Za-z0-9._:+/-]+$/u, "model");
  const startedAt = timestamp(value.startedAt, "startedAt");
  const completedAt = timestamp(value.completedAt, "completedAt");
  if (completedAt < startedAt) invalidEvent("Model usage timestamps are out of order");
  if (value.state !== "completed" && value.state !== "aborted" && value.state !== "failed") invalidEvent();
  const event: ModelUsageEvent = {
    id, repository, feature, provider, model, startedAt, completedAt, state: value.state,
    ...(value.inputTokens === undefined ? {} : { inputTokens: boundedInteger(value.inputTokens, "inputTokens") }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: boundedInteger(value.outputTokens, "outputTokens") }),
    ...(value.cost === undefined ? {} : { cost: boundedCost(value.cost) }),
    ...(value.cacheHit === undefined ? {} : { cacheHit: boundedBoolean(value.cacheHit, "cacheHit") }),
    ...(value.promptVersion === undefined ? {} : { promptVersion: boundedText(value.promptVersion, 0, 128, /^[A-Za-z0-9._:-]*$/u, "prompt version") }),
    ...(value.durationMs === undefined ? {} : { durationMs: boundedDuration(value.durationMs, "durationMs") }),
    ...(value.queueWaitMs === undefined ? {} : { queueWaitMs: boundedDuration(value.queueWaitMs, "queueWaitMs") }),
    ...(value.errorCode === undefined ? {} : { errorCode: boundedText(value.errorCode, 1, 128, /^[A-Za-z0-9._:-]+$/u, "error code") }),
  };
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_EVENT_BYTES) invalidEvent("Model usage event exceeds the storage limit");
  return event;
}

function normalizeRepository(value: unknown): RepositoryIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, REPOSITORY_FIELDS)) {
    throw new HistoricalModelUsageError("model_usage_event_invalid", "Model usage repository identity is invalid");
  }
  if (value.provider !== "github" && value.provider !== "local") {
    throw new HistoricalModelUsageError("model_usage_event_invalid", "Model usage repository provider is invalid");
  }
  const repositoryId = boundedText(value.repositoryId, 1, 256, /^[A-Za-z0-9._:-]+$/u, "repository ID");
  const defaultBranch = boundedText(value.defaultBranch, 1, 256, /^[^\x00-\x1f\x7f]+$/u, "default branch");
  const ownerScope = boundedText(value.ownerScope, 1, 256, /^[^\x00-\x1f\x7f]+$/u, "owner scope");
  const url = boundedText(value.url, 1, 2_048, /^[^\x00-\x1f\x7f]+$/u, "repository URL");
  if (value.provider === "github") {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new HistoricalModelUsageError("model_usage_event_invalid", "Model usage repository URL is invalid"); }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new HistoricalModelUsageError("model_usage_event_invalid", "Model usage GitHub URL is not a credential-free repository identity");
    }
  } else if (!isAbsolute(url)) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new HistoricalModelUsageError("model_usage_event_invalid", "Model usage local repository URL is invalid"); }
    if (!["file:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new HistoricalModelUsageError("model_usage_event_invalid", "Model usage local URL is not a credential-free repository identity");
    }
  }
  return { provider: value.provider, repositoryId, defaultBranch, ownerScope, url };
}

function normalizeQuery(query: unknown): { from?: string; to?: string; limit: number; cursor?: { partition: string; startedAt: string; id: string } } {
  if (!isRecord(query) || !hasOnlyKeys(query, new Set(["from", "to", "limit", "cursor"]))) {
    throw new HistoricalModelUsageError("model_usage_query_invalid", "Model usage history query is invalid");
  }
  const from = query.from === undefined ? undefined : timestamp(query.from, "from");
  const to = query.to === undefined ? undefined : timestamp(query.to, "to");
  if (from && to && from > to) throw new HistoricalModelUsageError("model_usage_query_invalid", "Model usage history range is reversed");
  const limit = query.limit === undefined ? DEFAULT_PAGE_SIZE : query.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE_SIZE) {
    throw new HistoricalModelUsageError("model_usage_query_invalid", `Model usage history limit must be from 1 to ${MAX_PAGE_SIZE}`);
  }
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: limit as number,
    ...(query.cursor === undefined ? {} : { cursor: decodeCursor(query.cursor, from, to) }),
  };
}

function decodeCursor(value: unknown, from?: string, to?: string): { partition: string; startedAt: string; id: string } {
  if (typeof value !== "string" || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new HistoricalModelUsageError("model_usage_cursor_invalid", "Model usage history cursor is invalid");
  }
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) throw new Error("non-canonical cursor");
    const decoded: unknown = JSON.parse(json);
    if (!isRecord(decoded) || !hasOnlyKeys(decoded, new Set(["partition", "from", "to", "startedAt", "id"])) ||
        typeof decoded.partition !== "string" || !/^[a-f0-9]{64}$/u.test(decoded.partition) ||
        decoded.from !== (from ?? null) || decoded.to !== (to ?? null)) throw new Error("cursor scope mismatch");
    return {
      partition: decoded.partition,
      startedAt: timestamp(decoded.startedAt, "cursor timestamp"),
      id: boundedText(decoded.id, 1, 128, /^[A-Za-z0-9._:-]+$/u, "cursor event ID"),
    };
  } catch (error) {
    if (error instanceof HistoricalModelUsageError) throw error;
    throw new HistoricalModelUsageError("model_usage_cursor_invalid", "Model usage history cursor is invalid or belongs to another query");
  }
}

function encodeCursor(cursor: { partition: string; from: string | null; to: string | null; startedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function repositoryKey(repository: RepositoryIdentity): string {
  return hash(`${repository.provider}\0${repository.ownerScope}\0${repository.repositoryId}`);
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    invalidEvent(`Model usage ${field} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalidEvent(`Model usage ${field} must be a valid timestamp`);
  return parsed.toISOString();
}

function boundedText(value: unknown, min: number, max: number, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !pattern.test(value)) {
    invalidEvent(`Model usage ${field} is invalid`);
  }
  return value as string;
}

function boundedInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000_000) invalidEvent(`Model usage ${field} is invalid`);
  return value as number;
}

function boundedCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) invalidEvent("Model usage cost is invalid");
  return value;
}

function boundedBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalidEvent(`Model usage ${field} is invalid`);
  return value;
}

function boundedDuration(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_TIMING_MS) {
    invalidEvent(`Model usage ${field} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function invalidEvent(message = "Model usage event is invalid"): never {
  throw new HistoricalModelUsageError("model_usage_event_invalid", message);
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function ensureRoot(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
  const parent = resolve(directory, "..");
  await syncDirectory(parent);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new HistoricalModelUsageError("model_usage_path_invalid", "Model usage storage path must be a real directory");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new HistoricalModelUsageError("model_usage_path_permissions", "Model usage storage directories must be private to the host user");
  }
}

async function readEvent(path: string): Promise<ModelUsageEvent> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_EVENT_BYTES || (info.mode & 0o077) !== 0) {
      throw new HistoricalModelUsageError("model_usage_history_corrupt", "Model usage history record is not a bounded regular file");
    }
    const decoded: unknown = JSON.parse(await handle.readFile("utf8"));
    return normalizeEvent(decoded);
  } catch (error) {
    if (error instanceof HistoricalModelUsageError && error.code === "model_usage_history_corrupt") throw error;
    if (isCode(error, "ENOENT")) throw error;
    throw new HistoricalModelUsageError("model_usage_history_corrupt", "Model usage history record cannot be read safely");
  } finally {
    await handle?.close().catch(() => undefined);
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
