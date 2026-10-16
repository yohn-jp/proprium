import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { CONTRACT_VERSION, MODEL_USAGE_CAPABILITY, snapshotKey, type ActionDescriptor, type ActionResult, type ChangeOperation, type ChangeProposal, type HttpContribution, type ModelUsageStore, type ModuleAction, type ModuleActionContext, type ModuleId, type ModuleStatus, type ProposalEvidence, type SnapshotId, type ValueSchema } from "@scriptorium/contracts";
import type { CoreStore, CreateHierarchyInput, HierarchyTarget, Project, ReorderHierarchyInput } from "@scriptorium/core";
import { ModuleRuntime, type ActionHostContext, type ModuleLoader, type ModuleRuntimeOptions, type WorkerJobLifecycleSnapshot } from "@scriptorium/module-runtime";
import { HistoricalModelUsageStore } from "./historical-store.js";
import { JobHistoryError, JobHistoryStore } from "./job-history-store.js";

export { importLegacyJobHistory, type LegacyJobHistoryImportOptions, type LegacyJobHistoryImportReport } from "./job-history-store.js";

const SESSION_COOKIE = "scriptorium_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 1000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCRATCH_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const API_DRAIN_TIMEOUT_MS = 5_000;
const API_VERSION = "0.1.0";
const STYLE_NONCES = new WeakMap<IncomingMessage, string>();
const PUBLIC_READER_MODULES = new Set(["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"]);

interface Session {
  expiresAt: number;
}

export interface ApiServerOptions {
  store: CoreStore;
  authToken: string;
  /** Defaults to `<cwd>/app/dist`. */
  staticDir?: string;
  /** Trust X-Forwarded-Proto when TLS terminates at a reverse proxy. */
  trustProxy?: boolean;
  /** A deployment-selected, metadata-first runtime. Omitted modules are never imported. */
  runtime?: ModuleRuntime;
  /** Trusted profile composition; loaders remain lazy until their module is activated. */
  runtimeOptions?: Omit<ModuleRuntimeOptions, "cacheDirectory"> & { cacheDirectory?: string };
  /** Host-owned historical model usage, independent from Core's disposable cache. */
  usageDirectory?: string;
  profile?: string;
}

interface HttpFailure {
  status: number;
  code: string;
  message: string;
}

function httpFailure(status: number, code: string, message: string): HttpFailure {
  return { status, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== "string") return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requestProtocol(request: IncomingMessage, trustProxy: boolean): "http:" | "https:" {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-proto"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",", 1)[0]?.trim();
    if (first === "https") return "https:";
  }
  return (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted ? "https:" : "http:";
}

function sameOrigin(request: IncomingMessage, trustProxy: boolean): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    const parsed = new URL(origin);
    const target = new URL(`${requestProtocol(request, trustProxy)}//${host}`);
    return parsed.origin === target.origin && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function setSecurityHeaders(response: ServerResponse, styleNonce: string): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'self' 'nonce-${styleNonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage, parsedBody?: unknown): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw httpFailure(415, "JSON_REQUIRED", "Send a JSON request body");
  }
  if (parsedBody !== undefined) return parsedBody;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BYTES) throw httpFailure(413, "BODY_TOO_LARGE", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw httpFailure(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function isHttpFailure(error: unknown): error is HttpFailure {
  return isRecord(error) && typeof error.status === "number" && typeof error.code === "string" && typeof error.message === "string";
}

function sendError(response: ServerResponse, error: unknown): void {
  if (isHttpFailure(error)) {
    sendJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  if (isRecord(error) && typeof error.status === "number" && typeof error.code === "string" && typeof error.message === "string") {
    sendJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  console.error("Unhandled Scriptorium API error", error);
  sendJson(response, 500, { error: "Internal server error", code: "INTERNAL_ERROR" });
}

function cookieHeader(request: IncomingMessage, token: string, trustProxy: boolean): string {
  const secure = requestProtocol(request, trustProxy) === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

function clearCookie(request: IncomingMessage, trustProxy: boolean): string {
  const secure = requestProtocol(request, trustProxy) === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function parseProjectId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpFailure(400, "INVALID_ID", "Project identifier is invalid");
  }
}

function parseSceneId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpFailure(400, "INVALID_ID", "Scene identifier is invalid");
  }
}

function isPublicReaderPath(pathname: string): boolean {
  const parts = pathname.split("/");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "r" ||
      !/^\d{1,32}$/u.test(parts[3] ?? "") || !/^[A-Za-z0-9._~-]{1,128}$/u.test(parts[4] ?? "")) return false;
  let moduleId: string;
  try { moduleId = decodeURIComponent(parts[2] ?? ""); }
  catch { return false; }
  return PUBLIC_READER_MODULES.has(moduleId);
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  staticDir: string,
  styleNonce: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = requestPath(request);
  const publicReaderPath = isPublicReaderPath(path);
  const files: Record<string, { filename: string; contentType: string }> = {
    "/": { filename: "index.html", contentType: "text/html; charset=utf-8" },
    "/main.js": { filename: "main.js", contentType: "text/javascript; charset=utf-8" },
    "/api.js": { filename: "api.js", contentType: "text/javascript; charset=utf-8" },
    "/drafts.js": { filename: "drafts.js", contentType: "text/javascript; charset=utf-8" },
    "/styles.css": { filename: "styles.css", contentType: "text/css; charset=utf-8" },
  };
  let file = files[path] ?? (publicReaderPath ? files["/"] : undefined);
  if (!file && path.startsWith("/assets/")) {
    const name = path.slice("/assets/".length);
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return false;
    const extension = extname(name).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
      ".avif": "image/avif", ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2",
      ".ttf": "font/ttf", ".otf": "font/otf", ".ico": "image/x-icon",
    };
    if (!contentTypes[extension] || !/^[A-Za-z0-9._-]{1,180}$/u.test(name)) return false;
    file = { filename: resolve(staticDir, "assets", name), contentType: contentTypes[extension] };
  }
  if (!file) return false;
  try {
    const target = file.filename.startsWith(sep) ? file.filename : resolve(staticDir, file.filename);
    const root = await realpath(staticDir);
    const assetsDirectory = path.startsWith("/assets/") ? resolve(staticDir, "assets") : undefined;
    if (assetsDirectory && (await lstat(assetsDirectory)).isSymbolicLink()) {
      sendJson(response, 404, { error: "Page not found", code: "NOT_FOUND" });
      return true;
    }
    const originalStat = await lstat(target);
    if (!originalStat.isFile() || originalStat.isSymbolicLink()) {
      sendJson(response, 404, { error: "Page not found", code: "NOT_FOUND" });
      return true;
    }
    const resolvedTarget = await realpath(target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
      sendJson(response, 404, { error: "Page not found", code: "NOT_FOUND" });
      return true;
    }
    const original = await readFile(resolvedTarget);
    const content = path === "/" || resolvedTarget === resolve(staticDir, "index.html")
      ? Buffer.from(original.toString("utf8").replaceAll("__SCRIPTORIUM_STYLE_NONCE__", styleNonce))
      : original;
    if (publicReaderPath) {
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
    response.writeHead(200, { "Content-Type": file.contentType, "Content-Length": content.length });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (path.startsWith("/assets/") && (code === "ENOENT" || code === "ENOTDIR")) {
      sendJson(response, 404, { error: "Page not found", code: "NOT_FOUND" });
    } else {
      sendJson(response, 503, { error: "Writing application is not built", code: "APP_NOT_BUILT" });
    }
  }
  return true;
}

function queryOf(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).searchParams;
}

function projectPathId(value: string): string { return parseProjectId(value); }

function optionalSnapshot(query: URLSearchParams): { view: "remote" | "checkpoint"; pinned?: string } {
  const rawView = query.get("view");
  const view = rawView === null ? "remote" : rawView;
  if (view !== "remote" && view !== "checkpoint") throw httpFailure(400, "INVALID_VIEW", "Snapshot view must be remote or checkpoint");
  const pinned = query.get("snapshot") ?? undefined;
  if (pinned !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pinned)) {
    throw httpFailure(400, "INVALID_SNAPSHOT", "Snapshot must be a full Git commit ID");
  }
  return { view, ...(pinned ? { pinned } : {}) };
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw httpFailure(400, "INVALID_LIMIT", "Limit must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw httpFailure(400, "INVALID_LIMIT", `Limit must be from ${min} to ${max}`);
  return parsed;
}

type ProposalStatus = {
  proposal: ChangeProposal;
  state: "proposed" | "partially_approved" | "approved" | "checkpointed";
  approvedOperationIds: string[];
  checkpoints: import("@scriptorium/contracts").CheckpointReceipt[];
  stale: boolean;
};

type ProjectSyncEvent = {
  id: string;
  type: "project-sync";
  projectId: string;
  reason: "manual";
  phase: "started" | "completed" | "failed";
  at: string;
  status?: Awaited<ReturnType<CoreStore["sync"]>>;
  observation?: { snapshot: SnapshotId; state: string; observedAt: string; pendingCount: number };
  updated?: boolean;
  error?: { code: string; retryable: boolean };
};

type CoreStoreApi = CoreStore & {
  detachProject?: (projectId: string) => Promise<void>;
  reconstructProject?: (projectId: string) => Promise<Project>;
  listManuscriptSnapshots?: (projectId: string, manuscriptId: string, sceneId?: string, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; snapshots: unknown[] }>;
  readManuscriptSnapshot?: (projectId: string, manuscriptId: string, snapshotId: string, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; manuscript: unknown } | null>;
  listProposals?: (projectId: string) => Promise<ProposalStatus[]>;
  getProposal?: (projectId: string, proposalId: string) => Promise<ProposalStatus | null>;
  searchSnapshot?: (projectId: string, query: string, limit?: number, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; results: unknown[] }>;
  writingStatsSnapshot?: (projectId: string, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; stats: unknown }>;
};

type RuntimeHttpHost = ModuleRuntime & {
  metadata?: () => unknown;
  httpContributions?: (id: string) => readonly Omit<HttpContribution, "handle">[];
  invokeHttp?: (id: string, contributionId: string, request: Request, host: ActionHostContext) => Promise<Response>;
};

type HttpContributionDescriptor = Omit<HttpContribution, "handle">;

type ApiActionHost = Omit<ActionHostContext, "propose"> & {
  actions?: readonly { module: ModuleId | "core"; action: ModuleAction }[];
  linkedReader?: (repositoryId: string) => Promise<ModuleActionContext["reader"]>;
  access?: "owner" | "public";
  propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, signal?: AbortSignal): Promise<ChangeProposal>;
};

export function createServer(options: ApiServerOptions): Server {
  if (options.authToken.length < 32 || options.authToken.trim() !== options.authToken) {
    throw new Error("SCRIPTORIUM_AUTH_TOKEN must contain at least 32 characters");
  }
  const staticDir = options.staticDir ?? resolve(process.cwd(), "app/dist");
  const trustProxy = options.trustProxy ?? false;
  const configuredUsageDirectory = options.usageDirectory ?? process.env.SCRIPTORIUM_USAGE_DIR ?? resolve(process.env.SCRIPTORIUM_DATA_DIR ?? "./data", "host-history");
  if (!configuredUsageDirectory.trim()) throw new Error("Model usage history requires a non-empty usage directory");
  const usageDirectory = resolve(configuredUsageDirectory);
  const jobHistory = new JobHistoryStore(usageDirectory);
  const sessions = new Map<string, Session>();
  const requestControllers = new Set<AbortController>();
  const projectEventStreams = new Set<ServerResponse>();
  const jobEventStreams = new Set<ServerResponse>();
  const coreStore = options.store as CoreStoreApi;
  const capabilityProviders = {
    ...(options.runtimeOptions?.capabilityProviders ?? {}),
    [MODEL_USAGE_CAPABILITY]: { create: (): ModelUsageStore => new HistoricalModelUsageStore(usageDirectory) },
  };
  const hostCapabilities = [...new Set([
    ...(options.runtimeOptions?.hostCapabilities ?? Object.keys(capabilityProviders)),
    MODEL_USAGE_CAPABILITY,
  ])];
  const runtime: RuntimeHttpHost = options.runtime ?? new ModuleRuntime({
    manifests: options.runtimeOptions?.manifests ?? [],
    enabled: options.runtimeOptions?.enabled ?? [],
    ...(options.runtimeOptions ?? {}),
    hostCapabilities,
    capabilityProviders,
    cacheDirectory: options.runtimeOptions?.cacheDirectory ?? resolve(process.cwd(), "data/module-cache"),
  });
  const profile = options.profile ?? process.env.SCRIPTORIUM_PROFILE ?? "core";
  if (profile === "full" && !options.runtime && !options.runtimeOptions) {
    throw new Error("The full profile requires trusted runtime manifests and lazy loaders");
  }
  const app: FastifyInstance = Fastify({ logger: false, trustProxy });
  let unsubscribeJobLifecycle = (): void => undefined;
  let shuttingDown = false;
  let activeRequests = 0;
  let started = false;
  let lastPendingLocalCheckpoints: number | null = null;
  let closed = false;
  let runtimeShutdownPromise: Promise<void> | undefined;
  const shutdownRuntime = (): Promise<void> => {
    runtimeShutdownPromise ??= Promise.resolve().then(() => runtime.shutdown()).finally(async () => {
      unsubscribeJobLifecycle();
      await jobHistory.flush();
    });
    return runtimeShutdownPromise;
  };

  unsubscribeJobLifecycle = runtime.subscribeJobLifecycle(async (lifecycle: WorkerJobLifecycleSnapshot) => {
    try {
      const event = await jobHistory.record(lifecycle);
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const response of jobEventStreams) {
        if (!response.destroyed && !response.writableEnded) response.write(frame);
      }
    } catch (error) {
      const code = error instanceof JobHistoryError ? error.code : "storage_failure";
      console.error(`Scriptorium worker lifecycle history was not retained (${code}).`);
    }
  });

  const emitProjectEvent = (event: ProjectSyncEvent): void => {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of projectEventStreams) {
      if (!response.destroyed && !response.writableEnded) response.write(frame);
    }
  };

  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: MAX_JSON_BYTES }, (_request, body, done) => {
    try { done(null, JSON.parse(body as string) as unknown); }
    catch {
      const error = new Error("Request body must be valid JSON") as Error & { status: number; code: string };
      error.status = 400;
      error.code = "INVALID_JSON";
      done(error);
    }
  });
  app.addHook("onRequest", (request, reply, done) => {
    const nonce = randomBytes(18).toString("base64");
    STYLE_NONCES.set(request.raw, nonce);
    setSecurityHeaders(reply.raw, nonce);
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as Error & { statusCode?: number }).statusCode;
    if (status === 413) sendJson(reply.raw, 413, { error: "Request body is too large", code: "BODY_TOO_LARGE" });
    else if (status === 415) sendJson(reply.raw, 415, { error: "Send a JSON request body", code: "JSON_REQUIRED" });
    else sendError(reply.raw, error);
  });
  app.addHook("onClose", async () => {
    if (!closed) await shutdownRuntime();
  });

  const fail = (response: ServerResponse, status: number, code: string, message: string): void => {
    sendJson(response, status, { error: message, code });
  };
  const abortSignalFor = (request: IncomingMessage, response: ServerResponse): AbortSignal => {
    const controller = new AbortController();
    requestControllers.add(controller);
    const abort = () => controller.abort(new Error("HTTP request was cancelled"));
    const cleanup = () => requestControllers.delete(controller);
    request.once("aborted", () => { abort(); cleanup(); });
    response.once("close", () => { if (!response.writableEnded) abort(); cleanup(); });
    response.once("finish", cleanup);
    return controller.signal;
  };
  const freshReader = async (projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: string) => {
    return options.store.reader(projectId, view, pinned);
  };
  const searchSnapshot = async (projectId: string, term: string, limit: number, selected: ReturnType<typeof optionalSnapshot>) => {
    if (!coreStore.searchSnapshot) throw httpFailure(503, "SEARCH_UNAVAILABLE", "Snapshot search is not available in this Core version");
    const result = await coreStore.searchSnapshot(projectId, term, limit, selected.view, selected.pinned);
    return { snapshot: result.snapshot, query: term, results: result.results };
  };
  const writingStatsSnapshot = async (projectId: string, selected: ReturnType<typeof optionalSnapshot>) => {
    if (!coreStore.writingStatsSnapshot) throw httpFailure(503, "WRITING_STATS_UNAVAILABLE", "Snapshot writing statistics are not available in this Core version");
    return coreStore.writingStatsSnapshot(projectId, selected.view, selected.pinned);
  };
  const buildCoreActions = (projectId: string): Array<{ module: "core"; action: ModuleAction }> => {
    const jsonSchema: ValueSchema = {
      parse(value: unknown): unknown {
        let encoded: string;
        try { encoded = JSON.stringify(value); } catch { throw new Error("Core result is not JSON serializable"); }
        if (Buffer.byteLength(encoded ?? "", "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("Core result exceeds the allowed size");
        return value;
      },
    };
    const emptyInput: ValueSchema = { parse(value: unknown) {
      if (value === undefined) return {};
      if (!isRecord(value) || Object.keys(value).length !== 0) throw new Error("This action accepts an empty object");
      return {};
    } };
    const proposalInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.proposalId !== "string" || value.proposalId.length < 1 || value.proposalId.length > 128) throw new Error("proposalId is required");
      return { proposalId: value.proposalId };
    } };
    const sceneInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.sceneId !== "string" || value.sceneId.length < 1 || value.sceneId.length > 256) throw new Error("sceneId is required");
      return { sceneId: value.sceneId };
    } };
    const manuscriptSnapshotsInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.manuscriptId !== "string" || !value.manuscriptId || value.manuscriptId.length > 256 ||
          (value.sceneId !== undefined && (typeof value.sceneId !== "string" || !value.sceneId || value.sceneId.length > 256))) {
        throw new Error("manuscriptId and an optional sceneId are required");
      }
      return { manuscriptId: value.manuscriptId, ...(typeof value.sceneId === "string" ? { sceneId: value.sceneId } : {}) };
    } };
    const manuscriptSnapshotInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.manuscriptId !== "string" || !value.manuscriptId || value.manuscriptId.length > 256 ||
          typeof value.snapshotId !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.snapshotId)) {
        throw new Error("manuscriptId and a full snapshotId are required");
      }
      return { manuscriptId: value.manuscriptId, snapshotId: value.snapshotId };
    } };
    const searchInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.query !== "string" || !value.query.trim() || value.query.length > 512) throw new Error("query must contain 1 to 512 characters");
      const limit = value.limit === undefined ? 20 : value.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
      return { query: value.query, limit };
    } };
    const optionalProposalId = (value: Record<string, unknown>): string | undefined => {
      if (value.proposalId === undefined) return undefined;
      if (typeof value.proposalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.proposalId)) throw new Error("proposalId must contain 1 to 128 letters, numbers, underscores, or hyphens");
      return value.proposalId;
    };
    const hierarchyCreateInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.kind !== "string" || !["volume", "chapter", "scene"].includes(value.kind) ||
          typeof value.id !== "string" || typeof value.title !== "string") throw new Error("kind, id, and title are required for hierarchy creation");
      const proposalId = optionalProposalId(value);
      if (value.kind === "volume") return { kind: value.kind, id: value.id, title: value.title, ...(proposalId ? { proposalId } : {}) };
      if (typeof value.volumeId !== "string") throw new Error("volumeId is required for chapter or scene creation");
      if (value.kind === "chapter") return { kind: value.kind, id: value.id, title: value.title, volumeId: value.volumeId, ...(proposalId ? { proposalId } : {}) };
      if (typeof value.chapterId !== "string" || (value.manuscriptBody !== undefined && typeof value.manuscriptBody !== "string")) {
        throw new Error("chapterId and an optional string manuscriptBody are required for scene creation");
      }
      return { kind: value.kind, id: value.id, title: value.title, volumeId: value.volumeId, chapterId: value.chapterId,
        ...(typeof value.manuscriptBody === "string" ? { manuscriptBody: value.manuscriptBody } : {}), ...(proposalId ? { proposalId } : {}) };
    } };
    const hierarchyDeleteInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || !isRecord(value.target) || typeof value.target.kind !== "string" ||
          !["volume", "chapter", "scene"].includes(value.target.kind) || typeof value.target.id !== "string") {
        throw new Error("A volume, chapter, or scene target is required for hierarchy deletion");
      }
      const proposalId = optionalProposalId(value);
      if (value.target.kind === "volume") return { target: { kind: value.target.kind, id: value.target.id }, ...(proposalId ? { proposalId } : {}) };
      if (typeof value.target.volumeId !== "string") throw new Error("volumeId is required for chapter or scene deletion");
      if (value.target.kind === "chapter") return { target: { kind: value.target.kind, id: value.target.id, volumeId: value.target.volumeId }, ...(proposalId ? { proposalId } : {}) };
      if (typeof value.target.chapterId !== "string") throw new Error("chapterId is required for scene deletion");
      return { target: { kind: value.target.kind, id: value.target.id, volumeId: value.target.volumeId, chapterId: value.target.chapterId }, ...(proposalId ? { proposalId } : {}) };
    } };
    const hierarchyReorderInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.kind !== "string" || !["volume", "chapter", "scene"].includes(value.kind) ||
          !Array.isArray(value.orderedIds) || !value.orderedIds.every((id) => typeof id === "string")) {
        throw new Error("kind and an ordered sibling ID list are required for hierarchy reorder");
      }
      const proposalId = optionalProposalId(value);
      if (value.kind === "volume") return { kind: value.kind, orderedIds: value.orderedIds, ...(proposalId ? { proposalId } : {}) };
      if (typeof value.volumeId !== "string") throw new Error("volumeId is required for chapter or scene reorder");
      if (value.kind === "chapter") return { kind: value.kind, volumeId: value.volumeId, orderedIds: value.orderedIds, ...(proposalId ? { proposalId } : {}) };
      if (typeof value.chapterId !== "string") throw new Error("chapterId is required for scene reorder");
      return { kind: value.kind, volumeId: value.volumeId, chapterId: value.chapterId, orderedIds: value.orderedIds, ...(proposalId ? { proposalId } : {}) };
    } };
    const restoreInput: ValueSchema = { parse(value: unknown) {
      if (!isRecord(value) || typeof value.operationId !== "string" || !value.operationId || value.operationId.length > 128) throw new Error("operationId is required for restore");
      const proposalId = optionalProposalId(value);
      return { operationId: value.operationId, ...(proposalId ? { proposalId } : {}) };
    } };
    const search = async (reader: Awaited<ReturnType<typeof freshReader>>, term: string, limit: number) => {
      if (!coreStore.searchSnapshot) throw httpFailure(503, "SEARCH_UNAVAILABLE", "Snapshot search is not available in this Core version");
      const result = await coreStore.searchSnapshot(projectId, term, limit, "remote", reader.snapshot.remoteCommit);
      return { query: term, results: result.results };
    };
    const make = (id: string, inputSchema: ValueSchema, read: (context: ModuleActionContext, input: unknown) => Promise<unknown>): ModuleAction => ({
      id,
      effect: "read",
      inputSchema,
      outputSchema: jsonSchema,
      async invoke(input, context) {
        try {
          const before = await options.store.observe(projectId);
          if (context.signal.aborted) return { ok: false, snapshot: context.reader.snapshot, error: { code: "action_cancelled", message: "Action was cancelled", retryable: false } };
          if (snapshotKey(before.snapshot) !== snapshotKey(context.reader.snapshot)) {
            return { ok: false, snapshot: context.reader.snapshot, error: { code: "snapshot_changed", message: "The repository changed before this read completed", retryable: true } };
          }
          const data = await read(context, input);
          if (context.signal.aborted) return { ok: false, snapshot: context.reader.snapshot, error: { code: "action_cancelled", message: "Action was cancelled", retryable: false } };
          const after = await options.store.observe(projectId);
          if (snapshotKey(after.snapshot) !== snapshotKey(context.reader.snapshot)) {
            return { ok: false, snapshot: context.reader.snapshot, error: { code: "snapshot_changed", message: "The repository changed during this read", retryable: true } };
          }
          return { ok: true, snapshot: context.reader.snapshot, data };
        } catch (error) {
          const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; status?: unknown };
          return { ok: false, snapshot: context.reader.snapshot, error: {
            code: typeof candidate?.code === "string" ? candidate.code : "core_read_failed",
            message: typeof candidate?.message === "string" ? candidate.message.slice(0, 512) : "Core read failed",
            retryable: candidate?.retryable === true || candidate?.status === 502,
          } };
        }
      },
    });
    const makeProposal = (
      id: string,
      inputSchema: ValueSchema,
      build: (context: ModuleActionContext, input: unknown) => Promise<{ snapshot: SnapshotId; operation: ChangeOperation }>,
    ): ModuleAction => ({
      id,
      effect: "propose",
      inputSchema,
      outputSchema: jsonSchema,
      async invoke(input, context) {
        const failAction = (code: string, message: string, retryable = false): ActionResult => ({
          ok: false, snapshot: context.reader.snapshot, error: { code, message: message.slice(0, 512), retryable },
        });
        try {
          if (context.signal.aborted) return failAction("action_cancelled", "Action was cancelled");
          const built = await build(context, input);
          if (context.signal.aborted) return failAction("action_cancelled", "Action was cancelled");
          if (snapshotKey(built.snapshot) !== snapshotKey(context.reader.snapshot)) {
            return failAction("snapshot_changed", "The proposed operation was built from a different snapshot", true);
          }
          const proposalId = isRecord(input) && typeof input.proposalId === "string" ? input.proposalId : undefined;
          const proposal = await context.propose([built.operation], undefined, proposalId);
          return { ok: true, snapshot: context.reader.snapshot, data: { proposal } };
        } catch (error) {
          const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; status?: unknown };
          return failAction(
            typeof candidate?.code === "string" ? candidate.code : "core_proposal_failed",
            typeof candidate?.message === "string" ? candidate.message : "Core could not build the requested proposal",
            candidate?.retryable === true || candidate?.status === 502,
          );
        }
      },
    });
    return [
      { module: "core", action: makeProposal("core.hierarchy.create", hierarchyCreateInput, (context, input) =>
        options.store.buildCreateHierarchyOperation(projectId, input as CreateHierarchyInput, "remote", context.reader.snapshot.remoteCommit)) },
      { module: "core", action: makeProposal("core.hierarchy.delete", hierarchyDeleteInput, (context, input) =>
        options.store.buildDeleteHierarchyOperation(projectId, (input as { target: HierarchyTarget }).target, "remote", context.reader.snapshot.remoteCommit)) },
      { module: "core", action: makeProposal("core.hierarchy.reorder", hierarchyReorderInput, (context, input) =>
        options.store.buildReorderHierarchyOperation(projectId, input as ReorderHierarchyInput, "remote", context.reader.snapshot.remoteCommit)) },
      { module: "core", action: makeProposal("core.operation.restore", restoreInput, (context, input) =>
        options.store.buildRestoreOperation(projectId, (input as { operationId: string }).operationId, "remote", context.reader.snapshot.remoteCommit)) },
      { module: "core", action: make("core.status", emptyInput, async () => options.store.status(projectId)) },
      { module: "core", action: make("core.history", emptyInput, async () => options.store.history(projectId)) },
      { module: "core", action: make("core.observation", emptyInput, async () => options.store.observe(projectId)) },
      { module: "core", action: make("core.tree", emptyInput, async (context) => options.store.readTreeSnapshot(projectId, "remote", context.reader.snapshot.remoteCommit)) },
      { module: "core", action: make("core.scene.context", sceneInput, async (context, input) => options.store.readSceneSnapshot(projectId, (input as { sceneId: string }).sceneId, "remote", context.reader.snapshot.remoteCommit)) },
      { module: "core", action: make("core.manuscript-snapshots", manuscriptSnapshotsInput, async (context, input) => {
        if (!coreStore.listManuscriptSnapshots) throw httpFailure(503, "SNAPSHOT_HISTORY_UNAVAILABLE", "Manuscript snapshot history is not available in this Core version");
        const parsed = input as { manuscriptId: string; sceneId?: string };
        return coreStore.listManuscriptSnapshots(projectId, parsed.manuscriptId, parsed.sceneId, "remote", context.reader.snapshot.remoteCommit);
      }) },
      { module: "core", action: make("core.manuscript-snapshot", manuscriptSnapshotInput, async (context, input) => {
        if (!coreStore.readManuscriptSnapshot) throw httpFailure(503, "SNAPSHOT_HISTORY_UNAVAILABLE", "Manuscript snapshot history is not available in this Core version");
        const parsed = input as { manuscriptId: string; snapshotId: string };
        const result = await coreStore.readManuscriptSnapshot(projectId, parsed.manuscriptId, parsed.snapshotId, "remote", context.reader.snapshot.remoteCommit);
        if (!result) throw httpFailure(404, "MANUSCRIPT_SNAPSHOT_NOT_FOUND", "Manuscript snapshot is not reachable from the selected commit");
        return result;
      }) },
      { module: "core", action: make("core.proposals.list", emptyInput, async () => {
        if (!coreStore.listProposals) throw httpFailure(503, "PROPOSAL_STATUS_UNAVAILABLE", "Proposal review is not available in this Core version");
        const proposals = await coreStore.listProposals(projectId);
        return { proposals: proposals.slice(0, 1000) };
      }) },
      { module: "core", action: make("core.proposals.get", proposalInput, async (_context, input) => {
        if (!coreStore.getProposal) throw httpFailure(503, "PROPOSAL_STATUS_UNAVAILABLE", "Proposal review is not available in this Core version");
        const status = await coreStore.getProposal(projectId, (input as { proposalId: string }).proposalId);
        if (!status) throw httpFailure(404, "PROPOSAL_NOT_FOUND", "Proposal not found");
        return { proposal: status };
      }) },
      { module: "core", action: make("core.search", searchInput, async (context, input) => {
        const parsed = input as { query: string; limit: number };
        return search(context.reader, parsed.query, parsed.limit);
      }) },
      { module: "core", action: make("core.writing-stats", emptyInput, async (context) => {
        if (!coreStore.writingStatsSnapshot) throw httpFailure(503, "WRITING_STATS_UNAVAILABLE", "Snapshot writing statistics are not available in this Core version");
        const result = await coreStore.writingStatsSnapshot(projectId, "remote", context.reader.snapshot.remoteCommit);
        return result.stats;
      }) },
      { module: "core", action: make("core.repositories.list", emptyInput, async () => {
        const repositories = [];
        for (const project of await options.store.listProjects()) {
          const observation = await options.store.observe(project.id);
          repositories.push({ projectId: project.id, repository: observation.snapshot.repository, snapshot: observation.snapshot });
        }
        return { repositories };
      }) },
    ];
  };

  const enabledStatuses = async (): Promise<ModuleStatus[]> => runtime.statuses();
  const activateEnabled = async (): Promise<void> => {
    for (const status of await enabledStatuses()) {
      if (status.availability === "enabled-idle" || status.availability === "active") await runtime.activate(status.id);
    }
  };
  const listActionDescriptors = async (projectId: string, signal: AbortSignal): Promise<ActionDescriptor[]> => {
    const reader = await freshReader(projectId);
    return runtime.listActions(actionHost(projectId, reader, signal, "author"));
  };
  const proposeAs = async (
    projectId: string,
    snapshot: SnapshotId,
    operations: ChangeOperation[],
    source: ChangeProposal["source"],
    evidence?: ProposalEvidence[],
    requestedId?: string,
  ): Promise<ChangeProposal> => options.store.propose(projectId, {
    id: requestedId ?? randomBytes(16).toString("hex"), snapshot, operations, source,
    ...(evidence?.length ? { evidence } : {}),
  });
  const actionHost = (
    projectId: string,
    reader: Awaited<ReturnType<typeof freshReader>>,
    signal: AbortSignal,
    source: ChangeProposal["source"],
    access: "owner" | "public" = "owner",
  ): ApiActionHost => {
    const host: ApiActionHost = {
      projectId,
      reader,
      signal,
      actions: access === "public" ? [] : buildCoreActions(projectId),
      propose: async (operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, proposalSignal?: AbortSignal) => {
        if (access === "public") throw httpFailure(403, "PUBLIC_PROPOSAL_DENIED", "Public module requests cannot propose changes");
        if (proposalId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(proposalId)) throw httpFailure(400, "INVALID_PROPOSAL_ID", "Proposal ID must contain 1 to 128 letters, numbers, underscores, or hyphens");
        const requestSignal = proposalSignal ?? signal;
        if (signal.aborted || requestSignal.aborted) throw httpFailure(499, "ACTION_CANCELLED", "Proposal request was cancelled");
        const proposal = await proposeAs(projectId, reader.snapshot, operations, source, evidence, proposalId);
        if (signal.aborted || requestSignal.aborted) throw httpFailure(499, "ACTION_CANCELLED", "Proposal request was cancelled");
        return proposal;
      },
      access,
    };
    if (access !== "public") {
      host.linkedReader = async (repositoryId: string) => {
        for (const project of await options.store.listProjects()) {
          const observation = await options.store.observe(project.id);
          if (observation.snapshot.repository.repositoryId === repositoryId) return freshReader(project.id, "remote", observation.snapshot.remoteCommit);
        }
        throw httpFailure(404, "REPOSITORY_NOT_FOUND", "Linked repository is not registered to this owner");
      };
    }
    return host;
  };

  const serveModuleResponse = async (response: Response, raw: ServerResponse, signal: AbortSignal, publicResponse = false): Promise<void> => {
    if (response.status < 200 || response.status > 599) throw httpFailure(502, "MODULE_HTTP_INVALID_RESPONSE", "Module returned an invalid HTTP response");
    const forbiddenHeaders = new Set(["set-cookie", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "cache-control", "connection", "keep-alive", "content-length", "trailer", "transfer-encoding", "upgrade"]);
    response.headers.forEach((value, key) => {
      if (publicResponse && key.toLowerCase() === "referrer-policy" && value.trim().toLowerCase() === "no-referrer") {
        raw.setHeader(key, "no-referrer");
        return;
      }
      if (!forbiddenHeaders.has(key.toLowerCase()) && !key.toLowerCase().startsWith("access-control-")) raw.setHeader(key, value);
    });
    raw.statusCode = response.status;
    if (response.body === null) {
      raw.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body as never), raw, { signal });
  };
  const makeWebRequest = (request: IncomingMessage, body: unknown, signal: AbortSignal, relativePath?: string): Request => {
    const method = request.method ?? "GET";
    const host = request.headers.host ?? "localhost";
    const originalUrl = new URL(request.url ?? "/", `${requestProtocol(request, trustProxy)}//${host}`);
    if (relativePath !== undefined) originalUrl.pathname = `/${relativePath.replace(/^\/+/, "")}`;
    const url = originalUrl.href;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ["host", "connection", "cookie", "authorization", "proxy-authorization"].includes(name.toLowerCase())) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    const init: RequestInit = { method, headers, signal };
    if (body !== undefined && !["GET", "HEAD"].includes(method)) init.body = JSON.stringify(body);
    return new Request(url, init);
  };
  const matchTemplate = (template: string, relative: string): boolean => {
    const expected = template.replace(/^\/+|\/+$/gu, "").split("/").filter(Boolean);
    const actual = relative.replace(/^\/+|\/+$/gu, "").split("/").filter(Boolean);
    if (expected.length !== actual.length) return false;
    return expected.every((part, index) => {
      const value = actual[index]!;
      try {
        const decoded = decodeURIComponent(value);
        if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") return false;
      } catch { return false; }
      if (part.startsWith(":")) return /^[A-Za-z0-9._~-]{1,256}$/u.test(decodeURIComponent(value));
      return part === value;
    });
  };
  const contributionFor = async (moduleId: string, relative: string, method: string): Promise<HttpContributionDescriptor | undefined> => {
    try { await runtime.activate(moduleId); }
    catch (error) {
      const candidate = error as { code?: unknown; message?: unknown };
      if (candidate?.code === "module_disabled" || candidate?.code === "redeployment_required" || candidate?.code === "unknown_module_id") return undefined;
      throw error;
    }
    const contributions: readonly HttpContributionDescriptor[] = runtime.httpContributions?.(moduleId) ?? [];
    return contributions.find((contribution) => contribution.methods.includes(method as HttpContribution["methods"][number]) && matchTemplate(contribution.path, relative));
  };

  const createScratch = async (projectId: string, value: unknown, isCookie: boolean, response: ServerResponse): Promise<void> => {
    if (!isCookie) throw httpFailure(403, "AUTHOR_SESSION_REQUIRED", "Scratch checkpoints require an owner session");
    if (!isRecord(value) || typeof value.text !== "string" || value.text.length > 100_000 ||
        (value.source !== undefined && !["voice", "camera", "text"].includes(String(value.source))) ||
        (value.sceneId !== undefined && (typeof value.sceneId !== "string" || !value.sceneId || value.sceneId.length > 256)) ||
        (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 8))) {
      throw httpFailure(400, "INVALID_SCRATCH", "Scratch text, source, scene, or attachment fields are invalid");
    }
    const text = value.text;
    const source = typeof value.source === "string" ? value.source : undefined;
    const sceneId = typeof value.sceneId === "string" ? value.sceneId : undefined;
    const inputs = (value.attachments ?? []) as unknown[];
    const createdAt = new Date().toISOString();
    const id = `scratch-${createdAt.slice(0, 10).replaceAll("-", "")}-${randomBytes(6).toString("hex")}`;
    const attachments: Array<{ filename: string; path: string; mimeType: string; content: Buffer }> = [];
    let totalBytes = 0;
    for (const item of inputs) {
      if (!isRecord(item) || typeof item.filename !== "string" || !item.filename.trim() || item.filename.length > 256 ||
          typeof item.mimeType !== "string" || !/^[A-Za-z0-9!#$&^_.+-]{1,128}\/[A-Za-z0-9!#$&^_.+-]{1,128}$/u.test(item.mimeType) ||
          typeof item.dataBase64 !== "string" || !item.dataBase64 || item.dataBase64.length > Math.ceil(MAX_SCRATCH_ATTACHMENT_BYTES * 4 / 3) + 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.dataBase64)) {
        throw httpFailure(400, "INVALID_SCRATCH_ATTACHMENT", "Scratch attachment fields are invalid");
      }
      const content = Buffer.from(item.dataBase64, "base64");
      if (content.length === 0) throw httpFailure(400, "EMPTY_SCRATCH_ATTACHMENT", "Scratch attachments cannot be empty");
      if (content.toString("base64") !== item.dataBase64) throw httpFailure(400, "INVALID_SCRATCH_ATTACHMENT", "Scratch attachment base64 is not canonical");
      totalBytes += content.length;
      if (content.length > MAX_SCRATCH_ATTACHMENT_BYTES || totalBytes > MAX_SCRATCH_ATTACHMENT_BYTES) {
        throw httpFailure(413, "SCRATCH_ATTACHMENT_TOO_LARGE", "Scratch attachments exceed the 8 MiB total limit");
      }
      const baseName = item.filename.split(/[\\/]/u).at(-1) ?? "";
      const filename = baseName.replace(/[^\w.\-()\u3040-\u30ff\u4e00-\u9fff]+/gu, "_").slice(0, 120) || "attachment.bin";
      attachments.push({ filename, path: `meta/scratch/files/${id}-${filename}`, mimeType: item.mimeType, content });
    }
    if (!text.trim() && attachments.length === 0) throw httpFailure(400, "INVALID_SCRATCH", "Scratch text or at least one attachment is required");
    const filePath = `meta/scratch/${id}.md`;
    const reader = await freshReader(projectId, "remote");
    const old = await reader.read(filePath);
    const markdownLines = ["---", `id: ${JSON.stringify(id)}`, `createdAt: ${JSON.stringify(createdAt)}`,
      ...(source ? [`source: ${JSON.stringify(source)}`] : []), ...(sceneId ? [`sceneId: ${JSON.stringify(sceneId)}`] : [])];
    if (attachments.length) {
      markdownLines.push("attachments:");
      for (const attachment of attachments) markdownLines.push(`  - filename: ${JSON.stringify(attachment.filename)}`, `    path: ${JSON.stringify(attachment.path)}`, `    mimeType: ${JSON.stringify(attachment.mimeType)}`);
    }
    markdownLines.push("---", "", ...(text.trimEnd() ? [text.trimEnd(), ""] : []));
    for (const attachment of attachments) markdownLines.push(`${attachment.mimeType.startsWith("image/") ? "!" : ""}[${attachment.filename}](${attachment.path})`, "");
    const markdown = markdownLines.join("\n");
    const writes: ChangeOperation["writes"] = [{ path: filePath, revision: old?.revision ?? null, content: markdown }];
    for (const attachment of attachments) {
      const previous = await reader.read(attachment.path, "base64");
      writes.push({ path: attachment.path, revision: previous?.revision ?? null, content: attachment.content.toString("base64"), encoding: "base64" });
    }
    const operation: ChangeOperation = {
      id: randomBytes(16).toString("hex"), generation: 0, repository: reader.snapshot.repository, baseRemoteCommit: reader.snapshot.remoteCommit,
      effect: "metadata", reads: writes.map(({ path, revision }) => ({ path, revision })), writes, message: `scratch: ${id}`,
    };
    const proposal = await options.store.propose(projectId, { id: randomBytes(16).toString("hex"), snapshot: reader.snapshot, operations: [operation], source: "author" });
    await options.store.approve(projectId, { proposalId: proposal.id, operationIds: [operation.id], authorScope: "owner" });
    const receipt = await options.store.checkpoint(projectId, operation);
    sendJson(response, 201, {
      id, path: filePath, createdAt, ...(source ? { source } : {}), sceneId: sceneId ?? null,
      attachments: attachments.map(({ filename, path, mimeType }) => ({ filename, path, mimeType })), proposal, receipt,
    });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, parsedBody?: unknown): Promise<void> => {
    const styleNonce = STYLE_NONCES.get(request) ?? randomBytes(18).toString("base64");
    if (!response.headersSent) setSecurityHeaders(response, styleNonce);
    const routePath = requestPath(request);
    const method = request.method ?? "GET";
    const query = queryOf(request);
    const isRead = method === "GET" || method === "HEAD";
    const publicRead = isRead && ["/api/health", "/api/ready", "/api/version", "/health/live", "/health/ready", "/health/startup"].includes(routePath);
    const publicModuleRoute = routePath.startsWith("/api/public/repos/") && routePath.includes("/modules/");

    if (method === "OPTIONS") {
      response.writeHead(204, { Allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" });
      response.end();
      return;
    }
    if (routePath === "/api/health" && isRead) { sendJson(response, 200, { status: "ok" }); return; }
    if (routePath === "/api/ready" && isRead) { sendJson(response, shuttingDown ? 503 : 200, { ok: !shuttingDown, pendingRequests: activeRequests, pendingLocalCheckpoints: lastPendingLocalCheckpoints }); return; }
    if (routePath === "/health/live" && isRead) { sendJson(response, 200, { ok: true }); return; }
    if (routePath === "/health/startup" && isRead) { sendJson(response, started && !closed ? 200 : 503, { ok: started && !closed, started }); return; }
    if (routePath === "/health/ready" && isRead) { sendJson(response, shuttingDown ? 503 : 200, { ok: !shuttingDown, pendingRequests: activeRequests, pendingLocalCheckpoints: lastPendingLocalCheckpoints }); return; }

    if (routePath === "/api/login" && method === "POST") {
      if (!sameOrigin(request, trustProxy)) { fail(response, 403, "CROSS_ORIGIN_REQUEST", "Request origin must match this application"); return; }
      const body = await readJson(request, parsedBody);
      const token = isRecord(body) && typeof body.token === "string" ? body.token : "";
      if (!constantTimeEqual(token, options.authToken)) { fail(response, 401, "UNAUTHORIZED", "Invalid access token"); return; }
      for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
      const sessionId = randomBytes(32).toString("base64url");
      sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL_MS });
      response.setHeader("Set-Cookie", cookieHeader(request, sessionId, trustProxy));
      sendJson(response, 200, { authenticated: true });
      return;
    }
    if (routePath === "/api/version" && isRead) {
      sendJson(response, 200, {
        name: "scriptorium", version: API_VERSION, contractVersion: CONTRACT_VERSION,
        profile, auth: ["cookie-owner", "bearer-read-compute-propose"], runtime: { name: "@scriptorium/module-runtime", contractVersion: CONTRACT_VERSION, ...(runtime.metadata ? { metadata: runtime.metadata() } : {}) },
        modules: await enabledStatuses(),
      });
      return;
    }
    const sessionId = cookieValue(request, SESSION_COOKIE);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const isCookie = Boolean(session && session.expiresAt > Date.now());
    if (sessionId && !isCookie) sessions.delete(sessionId);
    const authHeader = request.headers.authorization;
    const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const isBearer = !isCookie && bearer.length > 0 && constantTimeEqual(bearer, options.authToken);
    const hasAuth = isCookie || isBearer;
    if (routePath.startsWith("/api/") && !publicRead && !publicModuleRoute && !hasAuth) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="scriptorium", Cookie realm="scriptorium"');
      fail(response, 401, "UNAUTHORIZED", "Authentication required");
      return;
    }
    if (isCookie) session!.expiresAt = Date.now() + SESSION_TTL_MS;
    if (isCookie && !isRead && routePath.startsWith("/api/") && !sameOrigin(request, trustProxy)) {
      fail(response, 403, "CROSS_ORIGIN_REQUEST", "Request origin must match this application");
      return;
    }
    if (shuttingDown && routePath.startsWith("/api/") && !isRead) {
      fail(response, 503, "SHUTTING_DOWN", "The server is draining and is not accepting new mutations");
      return;
    }

    const signal = abortSignalFor(request, response);
    if (routePath === "/api/nlp/features" && method === "GET") {
      const modules = await enabledStatuses();
      const nlpModules = modules.filter((module) => ["nlp", "semantic", "speaker", "assistant"].includes(module.id));
      sendJson(response, 200, {
        providerKind: "none",
        features: nlpModules.map((module) => ({
          id: module.id,
          label: module.id,
          locality: module.id === "assistant" ? "external" : "local",
          ...(module.id === "assistant" ? { enabled: false } : {}),
        })),
        settings: { externalEnabled: {} },
        modules: nlpModules,
      });
      return;
    }
    if (routePath === "/api/session" && method === "GET") {
      sendJson(response, 200, { authenticated: true, authorScope: isCookie ? "owner" : "" });
      return;
    }
    if (routePath === "/api/logout" && method === "POST") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Only an owner session can log out"); return; }
      if (sessionId) sessions.delete(sessionId);
      response.setHeader("Set-Cookie", clearCookie(request, trustProxy));
      sendJson(response, 200, { authenticated: false });
      return;
    }
    if (routePath === "/api/projects/events" && method === "GET") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      projectEventStreams.add(response);
      response.once("close", () => projectEventStreams.delete(response));
      return;
    }
    if (routePath === "/api/jobs/events" && method === "GET") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Job events require an owner session"); return; }
      if (jobEventStreams.size >= 100) throw httpFailure(503, "JOB_EVENT_STREAM_LIMIT", "Too many job event streams are open");
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(": ok\n\n");
      jobEventStreams.add(response);
      const cleanup = (): void => { jobEventStreams.delete(response); };
      response.once("close", cleanup);
      response.once("finish", cleanup);
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n");
      }, 30_000);
      heartbeat.unref();
      response.once("close", () => clearInterval(heartbeat));
      response.once("finish", () => clearInterval(heartbeat));
      return;
    }
    if (routePath === "/api/jobs" && method === "GET") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Job history requires an owner session"); return; }
      try { sendJson(response, 200, await jobHistory.listJobs()); }
      catch { throw httpFailure(503, "JOB_HISTORY_UNAVAILABLE", "Job history is temporarily unavailable"); }
      return;
    }
    const jobMatch = routePath.match(/^\/api\/jobs\/([^/]+)$/u);
    if (jobMatch && method === "GET") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Job history requires an owner session"); return; }
      const jobId = parseProjectId(jobMatch[1]!);
      try {
        const job = await jobHistory.getJob(jobId);
        if (!job) throw httpFailure(404, "JOB_NOT_FOUND", "Job was not found");
        sendJson(response, 200, job);
      } catch (error) {
        if (isHttpFailure(error)) throw error;
        throw httpFailure(503, "JOB_HISTORY_UNAVAILABLE", "Job history is temporarily unavailable");
      }
      return;
    }
    if (routePath === "/api/inbox" && method === "GET") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Inbox requires an owner session"); return; }
      try { sendJson(response, 200, await jobHistory.listInbox({ unreadOnly: query.get("unread") === "1" })); }
      catch { throw httpFailure(503, "JOB_HISTORY_UNAVAILABLE", "Inbox is temporarily unavailable"); }
      return;
    }
    if (routePath === "/api/inbox/read-all" && method === "POST") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Inbox updates require an owner session"); return; }
      try { sendJson(response, 200, { marked: await jobHistory.markAllInboxRead() }); }
      catch { throw httpFailure(503, "JOB_HISTORY_UNAVAILABLE", "Inbox is temporarily unavailable"); }
      return;
    }
    const inboxReadMatch = routePath.match(/^\/api\/inbox\/([^/]+)\/read$/u);
    if (inboxReadMatch && method === "POST") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Inbox updates require an owner session"); return; }
      const inboxId = parseProjectId(inboxReadMatch[1]!);
      try {
        const item = await jobHistory.markInboxRead(inboxId);
        if (!item) throw httpFailure(404, "INBOX_ITEM_NOT_FOUND", "Inbox item was not found");
        sendJson(response, 200, { item });
      } catch (error) {
        if (isHttpFailure(error)) throw error;
        throw httpFailure(503, "JOB_HISTORY_UNAVAILABLE", "Inbox is temporarily unavailable");
      }
      return;
    }
    if (routePath === "/api/projects" && method === "GET") { sendJson(response, 200, await options.store.listProjects()); return; }
    if (routePath === "/api/projects" && method === "POST") {
      if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Repository registration requires an owner session"); return; }
      const body = await readJson(request, parsedBody);
      if (!isRecord(body) || typeof body.url !== "string" || !body.url.trim()) throw httpFailure(400, "INVALID_PROJECT", "Repository URL is required");
      if (body.branch !== undefined && typeof body.branch !== "string") throw httpFailure(400, "INVALID_PROJECT", "Branch must be a string");
      const project = await options.store.registerProject({ url: body.url.trim(), ...(typeof body.branch === "string" && body.branch.trim() ? { branch: body.branch.trim() } : {}) });
      sendJson(response, 201, project); return;
    }
    if (routePath === "/api/review-queue" && method === "GET") {
      if (!coreStore.listProposals) throw httpFailure(503, "PROPOSAL_STATUS_UNAVAILABLE", "Proposal review is not available in this Core version");
      const items: Array<{ projectId: string; proposal: ProposalStatus }> = [];
      for (const project of await options.store.listProjects()) {
        for (const proposal of await coreStore.listProposals(project.id)) {
          if (proposal.state !== "checkpointed") items.push({ projectId: project.id, proposal });
        }
      }
      sendJson(response, 200, { unresolvedCount: items.length, items: items.slice(0, 1000) });
      return;
    }

    const projectRoot = routePath.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/u);
    if (projectRoot) {
      const projectId = projectPathId(projectRoot[1]!);
      const suffix = projectRoot[2] ?? "";
      if (suffix === "" && method === "GET") {
        const project = (await options.store.listProjects()).find((candidate) => candidate.id === projectId);
        if (!project) throw httpFailure(404, "PROJECT_NOT_FOUND", "Project not found");
        const observation = await options.store.observe(projectId);
        sendJson(response, 200, { project, observation });
        return;
      }
      if (suffix === "" && method === "PUT") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Project reconstruction requires an owner session"); return; }
        if (!coreStore.reconstructProject) throw httpFailure(503, "PROJECT_RECONSTRUCTION_UNAVAILABLE", "Core cannot safely reconstruct registered projects in this version");
        const currentProject = (await options.store.listProjects()).find((candidate) => candidate.id === projectId);
        if (!currentProject) throw httpFailure(404, "PROJECT_NOT_FOUND", "Project not found");
        let requestedUrl: string | undefined;
        let requestedBranch: string | undefined;
        if (parsedBody !== undefined) {
          const body = await readJson(request, parsedBody);
          if (!isRecord(body)) throw httpFailure(400, "INVALID_PROJECT", "Project reconstruction accepts only an optional registered URL and default branch");
          const unsupported = Object.keys(body).filter((key) => !["url", "repoUrl", "branch"].includes(key));
          if (unsupported.length > 0) {
            throw httpFailure(400, "REGISTER_REPOSITORY_FIRST", "Credentials and mutable repository settings are host-managed. Register a separate repository, then detach this project when safe.");
          }
          const urlFields = [body.url, body.repoUrl].filter((value) => value !== undefined);
          if (urlFields.some((value) => typeof value !== "string" || !value.trim()) || (body.url !== undefined && body.repoUrl !== undefined && body.url !== body.repoUrl)) {
            throw httpFailure(400, "INVALID_PROJECT", "The registered repository URL is invalid");
          }
          requestedUrl = typeof body.url === "string" ? body.url.trim() : typeof body.repoUrl === "string" ? body.repoUrl.trim() : undefined;
          if (requestedUrl !== undefined && requestedUrl !== currentProject.url) {
            throw httpFailure(409, "REGISTER_REPOSITORY_FIRST", "Project re-registration cannot replace its remote. Register the new repository separately, then detach this project when safe.");
          }
          if (body.branch !== undefined && (typeof body.branch !== "string" || !body.branch.trim())) {
            throw httpFailure(400, "INVALID_PROJECT", "The default branch is invalid");
          }
          requestedBranch = typeof body.branch === "string" ? body.branch.trim() : undefined;
        }
        const project = await coreStore.reconstructProject(projectId);
        if (requestedBranch !== undefined && requestedBranch !== project.branch) {
          throw httpFailure(409, "DEFAULT_BRANCH_MISMATCH", "Reconstruction uses the repository's current default branch; branch overrides are not supported");
        }
        sendJson(response, 200, { project });
        return;
      }
      if (suffix === "" && method === "DELETE") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Project detachment requires an owner session"); return; }
        if (!coreStore.detachProject) throw httpFailure(503, "PROJECT_DETACH_UNAVAILABLE", "Core cannot safely detach registered projects in this version");
        await coreStore.detachProject(projectId);
        response.writeHead(204);
        response.end();
        return;
      }
      if (suffix === "" && method === "PATCH") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Project settings require an owner session"); return; }
        throw httpFailure(410, "AUTO_MERGE_RETIRED", "Automatic merge settings are not supported. Synchronization and publication use the explicit Core workflow.");
      }
      if (suffix === "modules" && method === "GET") { sendJson(response, 200, await enabledStatuses()); return; }
      if (suffix === "contributions" && method === "GET") {
        await activateEnabled();
        const contributions = (await enabledStatuses())
          .filter((status) => status.availability === "enabled-idle" || status.availability === "active")
          .flatMap((status) => runtime.contributions(status.id));
        sendJson(response, 200, contributions); return;
      }
      if (suffix === "tree" && method === "GET") {
        const selected = optionalSnapshot(query);
        sendJson(response, 200, await options.store.readTreeSnapshot(projectId, selected.view, selected.pinned));
        return;
      }
      const sceneMatch = suffix.match(/^scenes\/([^/]+)$/u);
      if (sceneMatch && method === "GET") {
        const sceneId = parseSceneId(sceneMatch[1]!);
        const selected = optionalSnapshot(query);
        sendJson(response, 200, await options.store.readSceneSnapshot(projectId, sceneId, selected.view, selected.pinned));
        return;
      }
      if (sceneMatch && method === "PUT") {
        throw httpFailure(410, "SCENE_PROPOSAL_REQUIRED", "Direct scene saves are retired. Submit a revision-bound proposal, then approve and checkpoint it.");
      }
      if (suffix === "snapshot" && method === "GET") {
        const selected = optionalSnapshot(query);
        const reader = await freshReader(projectId, selected.view, selected.pinned);
        const paths = await reader.list("");
        if (paths.length > MAX_SNAPSHOT_FILES) throw httpFailure(413, "SNAPSHOT_TOO_LARGE", `Snapshot contains more than ${MAX_SNAPSHOT_FILES} files`);
        let total = 0;
        const files = [];
        for (const filePath of paths) {
          const file = await reader.read(filePath);
          if (!file) continue;
          total += Buffer.byteLength(file.content, "utf8");
          if (total > MAX_SNAPSHOT_BYTES) throw httpFailure(413, "SNAPSHOT_TOO_LARGE", "Snapshot exceeds the allowed response size");
          files.push({ path: filePath, content: file.content, revision: file.revision });
        }
        sendJson(response, 200, { snapshot: reader.snapshot, files });
        return;
      }
      if (suffix === "history" && method === "GET") { sendJson(response, 200, await options.store.history(projectId)); return; }
      if (suffix === "status" && method === "GET") { sendJson(response, 200, await options.store.status(projectId)); return; }
      if (suffix === "observation" && method === "GET") { sendJson(response, 200, await options.store.observe(projectId)); return; }
      if (suffix === "sync" && method === "POST") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Workspace synchronization requires an owner session"); return; }
        const id = randomBytes(16).toString("hex");
        emitProjectEvent({ id, type: "project-sync", projectId, reason: "manual", phase: "started", at: new Date().toISOString() });
        try {
          const before = await options.store.observe(projectId);
          const status = await options.store.sync(projectId);
          const after = await options.store.observe(projectId);
          const beforePending = before.pending.map(({ operationId }) => operationId).sort().join("\n");
          const afterPending = after.pending.map(({ operationId }) => operationId).sort().join("\n");
          emitProjectEvent({
            id,
            type: "project-sync",
            projectId,
            reason: "manual",
            phase: "completed",
            at: new Date().toISOString(),
            status,
            observation: { snapshot: after.snapshot, state: after.state, observedAt: after.observedAt, pendingCount: after.pending.length },
            updated: snapshotKey(before.snapshot) !== snapshotKey(after.snapshot) || before.checkpointHead !== after.checkpointHead || beforePending !== afterPending,
          });
          sendJson(response, 200, status);
        } catch (error) {
          const failure = error as { code?: unknown; retryable?: unknown };
          emitProjectEvent({
            id,
            type: "project-sync",
            projectId,
            reason: "manual",
            phase: "failed",
            at: new Date().toISOString(),
            error: { code: typeof failure?.code === "string" ? failure.code : "SYNC_FAILED", retryable: failure?.retryable === true },
          });
          throw error;
        }
        return;
      }
      if (suffix === "reconcile" && method === "POST") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Checkpoint reconciliation requires an owner session"); return; }
        sendJson(response, 200, await options.store.reconcile(projectId)); return;
      }
      if (suffix === "publish" && method === "POST") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Publishing requires an owner session"); return; }
        const body = await readJson(request, parsedBody);
        if (!isRecord(body) || typeof body.batchId !== "string" || !body.batchId) throw httpFailure(400, "INVALID_BATCH", "A publish batch ID is required");
        sendJson(response, 200, await options.store.publish(projectId, body.batchId)); return;
      }
      if (suffix === "proposals" && method === "POST") {
        const body = await readJson(request, parsedBody);
        if (!isRecord(body) || !isRecord(body.snapshot) || !Array.isArray(body.operations) || !body.operations.length) throw httpFailure(400, "INVALID_PROPOSAL", "A proposal snapshot and at least one operation are required");
        if (signal.aborted) throw httpFailure(499, "ACTION_CANCELLED", "Proposal request was cancelled");
        const suppliedId = typeof body.id === "string" ? body.id : typeof body.proposalId === "string" ? body.proposalId : undefined;
        const requestedId = suppliedId || undefined;
        let source: ChangeProposal["source"] = isBearer ? "mcp" : "author";
        if (requestedId !== undefined) {
          if (!coreStore.getProposal) throw httpFailure(503, "PROPOSAL_IDENTITY_UNAVAILABLE", "Core cannot verify an existing proposal identity for this retry");
          const existing = await coreStore.getProposal(projectId, requestedId);
          if (signal.aborted) throw httpFailure(499, "ACTION_CANCELLED", "Proposal request was cancelled");
          if (existing) {
            if (existing.proposal.id !== requestedId) throw httpFailure(503, "PROPOSAL_IDENTITY_INVALID", "Core returned a mismatched proposal identity");
            // Preserve only Core's immutable source for an existing identity; Core still checks the full original digest below.
            source = existing.proposal.source;
          }
        }
        const proposal: ChangeProposal = {
          id: requestedId || randomBytes(16).toString("hex"),
          snapshot: body.snapshot as unknown as SnapshotId,
          operations: body.operations as ChangeOperation[],
          source,
          ...(Array.isArray(body.evidence) ? { evidence: body.evidence as ProposalEvidence[] } : {}),
        };
        const stored = await options.store.propose(projectId, proposal);
        if (signal.aborted) throw httpFailure(499, "ACTION_CANCELLED", "Proposal request was cancelled");
        sendJson(response, 201, stored); return;
      }
      if (suffix === "proposals" && method === "GET") {
        if (!coreStore.listProposals) throw httpFailure(503, "PROPOSAL_STATUS_UNAVAILABLE", "Proposal review is not available in this Core version");
        sendJson(response, 200, { proposals: (await coreStore.listProposals(projectId)).slice(0, 1000) }); return;
      }
      const proposalMatch = suffix.match(/^proposals\/([^/]+)$/u);
      if (proposalMatch && method === "GET") {
        if (!coreStore.getProposal) throw httpFailure(503, "PROPOSAL_STATUS_UNAVAILABLE", "Proposal review is not available in this Core version");
        const proposal = await coreStore.getProposal(projectId, parseProjectId(proposalMatch[1]!));
        if (!proposal) throw httpFailure(404, "PROPOSAL_NOT_FOUND", "Proposal not found");
        sendJson(response, 200, proposal); return;
      }
      if (suffix === "approvals" && method === "POST") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Proposal approval requires an owner session"); return; }
        const body = await readJson(request, parsedBody);
        if (!isRecord(body) || typeof body.proposalId !== "string" || !body.proposalId || !Array.isArray(body.operationIds) || !body.operationIds.every((id) => typeof id === "string")) throw httpFailure(400, "INVALID_APPROVAL", "Proposal and operation IDs are required");
        await options.store.approve(projectId, { proposalId: body.proposalId, operationIds: body.operationIds as string[], authorScope: "owner" });
        response.writeHead(204); response.end(); return;
      }
      if (suffix === "checkpoints" && method === "POST") {
        if (!isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Checkpoint creation requires an owner session"); return; }
        const body = await readJson(request, parsedBody);
        sendJson(response, 201, await options.store.checkpoint(projectId, body as ChangeOperation)); return;
      }
      if (suffix === "actions" && method === "GET") {
        sendJson(response, 200, { actions: await listActionDescriptors(projectId, signal) }); return;
      }
      const actionMatch = suffix.match(/^actions\/([^/]+)$/u);
      if (actionMatch && method === "POST") {
        const body = await readJson(request, parsedBody);
        if (!isRecord(body) || !("input" in body)) throw httpFailure(400, "INVALID_ACTION", "Action input is required");
        const actionId = parseProjectId(actionMatch[1]!);
        const descriptors = await listActionDescriptors(projectId, signal);
        const descriptor = descriptors.find((item) => item.id === actionId);
        if (!descriptor) throw httpFailure(404, "ACTION_NOT_FOUND", `Action ${actionId} is unavailable`);
        if (isBearer && !["read", "compute", "propose"].includes(descriptor.effect)) throw httpFailure(403, "BEARER_EFFECT_DENIED", "Bearer credentials may only invoke read, compute, and propose actions");
        const reader = await freshReader(projectId, "remote");
        const source = descriptor.module === "core"
          ? isBearer ? "mcp" : "author"
          : isBearer || descriptor.module === "mcp" ? "mcp" : "module";
        const host = actionHost(projectId, reader, signal, source);
        if (descriptor.module === "core") {
          const coreAction = host.actions?.find(({ action }) => action.id === descriptor.id)?.action;
          if (!coreAction) throw httpFailure(404, "ACTION_NOT_FOUND", `Action ${actionId} is unavailable`);
          const moduleContext: ModuleActionContext = {
            projectId, reader, signal,
            invoke: async () => ({ ok: false, snapshot: reader.snapshot, error: { code: "ACTION_UNAVAILABLE", message: "Core host actions cannot dispatch module actions", retryable: false } }),
            listActions: async () => descriptors,
            linkedReader: async (repositoryId: string) => host.linkedReader!(repositoryId),
            propose: async (operations, evidence, proposalId) => {
              if (coreAction.effect !== "propose") throw httpFailure(403, "ACTION_EFFECT_DENIED", "Read-only Core actions cannot propose changes");
              return host.propose(operations, evidence, proposalId, signal);
            },
            runJob: async (request) => ({ ok: false, id: request.id, snapshot: reader.snapshot, error: { code: "ACTION_EFFECT_DENIED", message: "Core host actions cannot run jobs", retryable: false } }),
          };
          let input: unknown;
          try { input = coreAction.inputSchema.parse(body.input); }
          catch (error) {
            sendJson(response, 200, { ok: false, snapshot: reader.snapshot, error: { code: "invalid_action_input", message: error instanceof Error ? error.message.slice(0, 512) : "Action input is invalid", retryable: false } } satisfies ActionResult);
            return;
          }
          let result = await coreAction.invoke(input, moduleContext);
          if (result.ok) {
            try { result = { ...result, data: coreAction.outputSchema.parse(result.data) }; }
            catch (error) {
              result = { ok: false, snapshot: reader.snapshot, error: { code: "invalid_action_result", message: error instanceof Error ? error.message.slice(0, 512) : "Action result is invalid", retryable: false } };
            }
          }
          sendJson(response, 200, result); return;
        }
        const result = await runtime.invokeAction(descriptor.module, actionId, body.input, host);
        sendJson(response, 200, result); return;
      }
      const snapshotsMatch = suffix.match(/^manuscripts\/([^/]+)\/snapshots$/u);
      if (snapshotsMatch && method === "GET") {
        if (!coreStore.listManuscriptSnapshots) throw httpFailure(503, "SNAPSHOT_HISTORY_UNAVAILABLE", "Manuscript snapshot history is not available in this Core version");
        const selected = optionalSnapshot(query);
        const sceneId = query.get("sceneId") ?? undefined;
        if (sceneId !== undefined && (!sceneId || sceneId.length > 256)) throw httpFailure(400, "INVALID_ID", "Scene identifier is invalid");
        sendJson(response, 200, await coreStore.listManuscriptSnapshots(projectId, parseProjectId(snapshotsMatch[1]!), sceneId, selected.view, selected.pinned));
        return;
      }
      const snapshotMatch = suffix.match(/^manuscripts\/([^/]+)\/snapshots\/([^/]+)$/u);
      if (snapshotMatch && method === "GET") {
        if (!coreStore.readManuscriptSnapshot) throw httpFailure(503, "SNAPSHOT_HISTORY_UNAVAILABLE", "Manuscript snapshot history is not available in this Core version");
        const selected = optionalSnapshot(query);
        const snapshotId = parseProjectId(snapshotMatch[2]!);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(snapshotId)) throw httpFailure(400, "INVALID_SNAPSHOT", "Manuscript snapshot ID must be a full Git commit ID");
        const result = await coreStore.readManuscriptSnapshot(projectId, parseProjectId(snapshotMatch[1]!), snapshotId, selected.view, selected.pinned);
        if (!result) throw httpFailure(404, "MANUSCRIPT_SNAPSHOT_NOT_FOUND", "Manuscript snapshot is not reachable from the selected commit");
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SNAPSHOT_BYTES) throw httpFailure(413, "SNAPSHOT_TOO_LARGE", "Manuscript snapshot exceeds the response size limit");
        sendJson(response, 200, result); return;
      }

      const moduleRoute = suffix.match(/^modules\/([^/]+)(?:\/(.*))?$/u);
      if (moduleRoute) {
        const moduleId = parseProjectId(moduleRoute[1]!);
        const contribution = await contributionFor(moduleId, moduleRoute[2] ?? "", method);
        if (!contribution || contribution.access !== "owner") throw httpFailure(404, "MODULE_ROUTE_UNAVAILABLE", "Module route is unavailable");
        if (isBearer && !["read", "propose"].includes(contribution.effect)) throw httpFailure(403, "BEARER_EFFECT_DENIED", "Bearer credentials may only use read and propose module routes");
        if (!runtime.invokeHttp) throw httpFailure(503, "MODULE_HTTP_UNAVAILABLE", "The runtime does not support HTTP module contributions");
        if (contribution.effect === "read" && method !== "GET" && method !== "HEAD") throw httpFailure(405, "MODULE_HTTP_METHOD_DENIED", "Read-only module routes must use GET or HEAD");
        const reader = await freshReader(projectId, "remote");
        const host = actionHost(projectId, reader, signal, isBearer || moduleId === "mcp" ? "mcp" : "module");
        const webRequest = makeWebRequest(request, parsedBody, signal, moduleRoute[2] ?? "");
        const moduleResponse = await runtime.invokeHttp(moduleId, contribution.id, webRequest, host);
        await serveModuleResponse(moduleResponse, response, signal);
        return;
      }

      const searchMatch = suffix.match(/^search$/u);
      if (searchMatch && method === "GET") {
        const term = query.get("q") ?? "";
        if (!term.trim() || term.length > 512) throw httpFailure(400, "INVALID_QUERY", "A search query from 1 to 512 characters is required");
        const limit = boundedInt(query.get("limit"), 20, 1, 100);
        const selected = optionalSnapshot(query);
        sendJson(response, 200, await searchSnapshot(projectId, term, limit, selected)); return;
      }
      const statsMatch = suffix.match(/^writing-stats$/u);
      if (statsMatch && method === "GET") {
        const selected = optionalSnapshot(query);
        sendJson(response, 200, await writingStatsSnapshot(projectId, selected)); return;
      }
      if (suffix === "scratch" && method === "POST") {
        await createScratch(projectId, await readJson(request, parsedBody), isCookie, response); return;
      }
      if (suffix === "review-queue" && method === "GET") {
        if (!coreStore.listProposals) throw httpFailure(503, "PROPOSAL_STATUS_UNAVAILABLE", "Proposal review is not available in this Core version");
        const proposals = await coreStore.listProposals(projectId);
        sendJson(response, 200, { snapshot: (await options.store.observe(projectId)).snapshot, proposals: proposals.slice(0, 1000) }); return;
      }

      if (suffix.startsWith("modules/") || suffix.startsWith("actions/")) throw httpFailure(404, "NOT_FOUND", "API route not found");
    }

    if (routePath === "/api/search" && method === "GET") {
      const projectId = query.get("projectId");
      if (!projectId) throw httpFailure(400, "PROJECT_REQUIRED", "projectId is required");
      const term = query.get("q") ?? "";
      if (!term.trim() || term.length > 512) throw httpFailure(400, "INVALID_QUERY", "A search query from 1 to 512 characters is required");
      const limit = boundedInt(query.get("limit"), 20, 1, 100);
      sendJson(response, 200, await searchSnapshot(projectId, term, limit, optionalSnapshot(query)));
      return;
    }
    if (routePath === "/api/writing-stats" && method === "GET") {
      const projectId = query.get("projectId");
      if (!projectId) throw httpFailure(400, "PROJECT_REQUIRED", "projectId is required");
      sendJson(response, 200, await writingStatsSnapshot(projectId, optionalSnapshot(query)));
      return;
    }
    if (routePath === "/api/scratch" && method === "POST") {
      const projectId = query.get("projectId");
      if (!projectId) throw httpFailure(400, "PROJECT_REQUIRED", "projectId is required");
      await createScratch(projectId, await readJson(request, parsedBody), isCookie, response);
      return;
    }
    if (routePath.startsWith("/api/public/repos/") && routePath.includes("/modules/")) {
      const publicMatch = routePath.match(/^\/api\/public\/repos\/([^/]+)\/modules\/([^/]+)(?:\/(.*))?$/u);
      if (!publicMatch) throw httpFailure(404, "NOT_FOUND", "Public module route not found");
      const repositoryId = parseProjectId(publicMatch[1]!);
      if (!/^\d{1,32}$/u.test(repositoryId)) throw httpFailure(404, "REPOSITORY_NOT_FOUND", "Public repository was not found");
      const moduleId = parseProjectId(publicMatch[2]!);
      const projectList = await options.store.listProjects();
      let projectId: string | undefined;
      let snapshot: SnapshotId | undefined;
      for (const project of projectList) {
        const observed = await options.store.observe(project.id);
        if (observed.snapshot.repository.repositoryId === repositoryId) { projectId = project.id; snapshot = observed.snapshot; break; }
      }
      if (!projectId || !snapshot) throw httpFailure(404, "REPOSITORY_NOT_FOUND", "Public repository was not found");
      const contribution = await contributionFor(moduleId, publicMatch[3] ?? "", method);
      if (!contribution || contribution.access !== "public" || contribution.effect !== "read") throw httpFailure(404, "MODULE_ROUTE_UNAVAILABLE", "Public module route is unavailable");
      if (!isRead) throw httpFailure(405, "PUBLIC_MODULE_READ_ONLY", "Public module routes are read-only");
      if (!runtime.invokeHttp) throw httpFailure(503, "MODULE_HTTP_UNAVAILABLE", "The runtime does not support HTTP module contributions");
      const reader = await freshReader(projectId, "remote", snapshot.remoteCommit);
      const host = actionHost(projectId, reader, signal, "module", "public");
      const moduleResponse = await runtime.invokeHttp(moduleId, contribution.id, makeWebRequest(request, parsedBody, signal, publicMatch[3] ?? ""), host);
      await serveModuleResponse(moduleResponse, response, signal, true); return;
    }

    if (routePath.startsWith("/api/")) { fail(response, 404, "NOT_FOUND", "API route not found"); return; }
    if (await serveStatic(request, response, staticDir, styleNonce)) return;
    fail(response, 404, "NOT_FOUND", "Page not found");
  };

  const routeHandler = async (request: FastifyRequest, reply: import("fastify").FastifyReply): Promise<void> => {
    reply.hijack();
    activeRequests += 1;
    try { await handle(request.raw, reply.raw, request.body); }
    catch (error) { if (!reply.raw.headersSent) sendError(reply.raw, error); else reply.raw.destroy(error instanceof Error ? error : undefined); }
    finally { activeRequests = Math.max(0, activeRequests - 1); }
  };
  const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
  app.route({ method: [...methods], url: "/", handler: routeHandler });
  app.route({ method: [...methods], url: "/*", handler: routeHandler });

  // Keep the historical synchronous Node server factory while routing every request through Fastify.
  const server = createHttpServer((request, response) => {
    void Promise.resolve(app.ready()).then(() => { app.server.emit("request", request, response); }).catch((error: unknown) => sendError(response, error));
  });
  server.once("listening", () => { started = true; });
  const nodeClose = server.close.bind(server);
  let closePromise: Promise<Error | undefined> | undefined;
  server.close = ((callback?: (error?: Error) => void): Server => {
    if (!closePromise) {
      closed = true;
      shuttingDown = true;
      const beganAt = Date.now();
      let deadlineExpired = false;
      let drainTimer: NodeJS.Timeout | undefined;
      let resolveDeadline!: () => void;
      const deadline = new Promise<void>((resolveDeadlinePromise) => { resolveDeadline = resolveDeadlinePromise; });
      const forceClose = () => {
        if (deadlineExpired) return;
        deadlineExpired = true;
        for (const controller of requestControllers) controller.abort(new Error("The API drain deadline expired"));
        server.closeAllConnections();
        resolveDeadline();
      };
      for (const controller of requestControllers) controller.abort(new Error("The API server is shutting down"));
      for (const stream of projectEventStreams) stream.end();
      projectEventStreams.clear();
      for (const stream of jobEventStreams) stream.end();
      jobEventStreams.clear();
      const nodeDrain = new Promise<Error | undefined>((resolveNode) => nodeClose((error?: Error) => resolveNode(error)));
      const runtimeDrain = shutdownRuntime().then(
        () => undefined,
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error("Module runtime shutdown failed");
          console.error("Scriptorium module runtime shutdown failed", error);
          return failure;
        },
      );
      drainTimer = setTimeout(forceClose, API_DRAIN_TIMEOUT_MS);
      drainTimer.unref();
      closePromise = (async () => {
        let closeError: Error | undefined;
        const nodeOutcome = await Promise.race([nodeDrain.then((error) => ({ error })), deadline.then(() => ({ timedOut: true as const }))]);
        if ("error" in nodeOutcome) closeError ??= nodeOutcome.error;
        const runtimeOutcome = await Promise.race([runtimeDrain.then((error) => ({ error })), deadline.then(() => ({ timedOut: true as const }))]);
        if ("error" in runtimeOutcome) closeError ??= runtimeOutcome.error;
        if (deadlineExpired || "timedOut" in nodeOutcome || "timedOut" in runtimeOutcome) {
          forceClose();
          console.warn(`Scriptorium API shutdown exceeded ${API_DRAIN_TIMEOUT_MS} ms; remaining HTTP connections were closed.`);
        }

        let pending = 0;
        let unknown = deadlineExpired;
        const checkPending = async (): Promise<void> => {
          const projects = await options.store.listProjects();
          for (const project of projects) pending += (await options.store.observe(project.id)).pending.length;
        };
        if (!deadlineExpired) {
          const checked = await Promise.race([checkPending().then(() => true, () => false), deadline.then(() => false)]);
          unknown = !checked;
        }
        lastPendingLocalCheckpoints = unknown ? null : pending;
        if (pending > 0 && !unknown) console.info(`Scriptorium is shutting down with ${pending} local checkpoint(s) pending; no publish was attempted.`);
        if (unknown) console.warn("Scriptorium could not determine whether local checkpoints remain pending during shutdown.");

        const appClose = app.close().then(() => undefined, (error: unknown) => {
          closeError ??= error instanceof Error ? error : new Error("Fastify shutdown failed");
        });
        if (!deadlineExpired) {
          const appClosed = await Promise.race([appClose.then(() => true), deadline.then(() => false)]);
          if (!appClosed) {
            forceClose();
            closeError ??= new Error("API shutdown deadline expired");
          }
        }
        if (drainTimer) clearTimeout(drainTimer);
        return closeError;
      })().catch((error: unknown) => error instanceof Error ? error : new Error("API shutdown failed"));
    }
    if (callback) void closePromise.then((error) => callback(error));
    return server;
  }) as Server["close"];
  Object.defineProperty(server, "scriptorium", { value: { fastify: app, runtime, profile }, enumerable: false });
  return server;
}

function parsePositivePort(value: string | undefined): number {
  if (!value) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return port;
}

export async function start(options?: ApiServerOptions): Promise<Server> {
  if (options) return startServer(options);
  const authToken = process.env.SCRIPTORIUM_AUTH_TOKEN?.trim();
  if (!authToken || authToken.length < 32) throw new Error("SCRIPTORIUM_AUTH_TOKEN is required and must contain at least 32 characters");
  const { CoreStore } = await import("@scriptorium/core");
  const profile = process.env.SCRIPTORIUM_PROFILE ?? "core";
  const cacheDirectory = resolve(process.env.SCRIPTORIUM_MODULE_CACHE_DIR ?? "./data/module-cache");
  const runtimeOptions = await loadProfileRuntimeOptions(profile, cacheDirectory);
  const dataDirectory = process.env.SCRIPTORIUM_DATA_DIR ?? "./data";
  const store = new CoreStore({
    dataDir: dataDirectory,
    ...(process.env.SCRIPTORIUM_GITHUB_TOKEN ? { githubToken: process.env.SCRIPTORIUM_GITHUB_TOKEN } : {}),
  });
  return startServer({
    store,
    authToken,
    trustProxy: process.env.SCRIPTORIUM_TRUST_PROXY === "1",
    runtimeOptions,
    usageDirectory: process.env.SCRIPTORIUM_USAGE_DIR ?? resolve(dataDirectory, "host-history"),
    profile,
  });
}

async function loadProfileRuntimeOptions(
  profile: string,
  cacheDirectory: string,
): Promise<Omit<ModuleRuntimeOptions, "cacheDirectory"> & { cacheDirectory: string }> {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(profile)) throw new Error("SCRIPTORIUM_PROFILE must be a valid profile name");
  const generated = process.env.SCRIPTORIUM_MODULE_PROFILE_PATH ?? resolve(process.cwd(), "profiles", profile, "generated/server.mjs");
  let composition: {
    profile?: unknown;
    moduleManifests?: ModuleRuntimeOptions["manifests"];
    moduleLoaders?: ModuleRuntimeOptions["loaders"];
    moduleDirectories?: ModuleRuntimeOptions["moduleDirectories"];
    moduleWorkerEntries?: ModuleRuntimeOptions["workerEntries"];
  } | undefined;
  try {
    composition = await import(pathToFileURL(generated).href) as typeof composition;
  } catch (error) {
    if (profile === "core" && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      return { manifests: [], enabled: [], cacheDirectory };
    }
    throw new Error(`Unable to load trusted ${profile} module composition from ${generated}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (composition?.profile !== profile || !Array.isArray(composition.moduleManifests)) throw new Error(`Generated composition does not match profile ${profile}`);
  const enabledByEnvironment = process.env.SCRIPTORIUM_ENABLED_MODULES;
  const enabled = enabledByEnvironment === undefined
    ? composition.moduleManifests.map((manifest) => manifest.id)
    : enabledByEnvironment.split(",").map((id) => id.trim()).filter(Boolean);
  return {
    manifests: composition.moduleManifests,
    enabled,
    loaders: composition.moduleLoaders,
    moduleDirectories: composition.moduleDirectories,
    workerEntries: composition.moduleWorkerEntries,
    cacheDirectory,
  };
}

async function startServer(options: ApiServerOptions): Promise<Server> {
  const server = createServer(options);
  const host = process.env.HOST ?? "127.0.0.1";
  const port = parsePositivePort(process.env.PORT);
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  console.info(`Scriptorium is listening on http://${host}:${port}`);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void start().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Scriptorium failed to start");
    process.exitCode = 1;
  });
}
