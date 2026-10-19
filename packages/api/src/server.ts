import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { CONTRACT_VERSION, MODEL_USAGE_CAPABILITY, assertProjectPath, snapshotKey, type ActionDescriptor, type ActionResult, type ChangeOperation, type ChangeProposal, type HttpContribution, type ModelUsageStore, type ModuleAction, type ModuleActionContext, type ModuleId, type ModuleStatus, type ProposalEvidence, type RecentActivityInput, type RepositoryIdentity, type SnapshotId, type ValueSchema } from "@scriptorium/contracts";
import type { CoreStore, CreateHierarchyInput, HierarchyTarget, Project, ReorderHierarchyInput } from "@scriptorium/core";
import { ModuleRuntime, type ActionHostContext, type DomainJobActionExecutor, type ModuleLoader, type ModuleRuntimeOptions, type WorkerJobLifecycleSnapshot } from "@scriptorium/module-runtime";
import { HistoricalModelUsageStore } from "./historical-store.js";
import { JobHistoryError, JobHistoryStore, type JobEvent } from "./job-history-store.js";
import { RecentActivityStore } from "./recent-activity-store.js";
import {
  createHostedAuthorizationPolicy,
  createHostedGitCredentialProvider,
  verifyCompactJwt,
} from "./hosted-policy.js";
import {
  HOSTED_ACCESS_COOKIE,
  HOSTED_ASSIGNMENT_PATH,
  HOSTED_CSRF_COOKIE,
  HOSTED_RUNTIME_IDENTITY_PATH,
  RUNTIME_METADATA_PATH,
  RUNTIME_QUIESCE_PATH,
  RUNTIME_RESUME_PATH,
  RUNTIME_STATUS_PATH,
  metadataForRuntime,
  normalizeRemoteRevision,
  parseQuiesceRequest,
  parseRuntimeAssignment,
  parseRuntimeControlCredential,
  readRuntimeAssignment,
  scanRemotePersistence,
  sha256Digest,
  type QuiesceRequest,
  type QuiesceResult,
  type PersistenceObservation,
  type RuntimeAssignment,
  type RuntimeStatus,
} from "./platform-runtime.js";

export { importLegacyJobHistory, type LegacyJobHistoryImportOptions, type LegacyJobHistoryImportReport } from "./job-history-store.js";
export { importLegacyRecentActivity, type LegacyRecentActivityImportOptions, type LegacyRecentActivityImportReport } from "./recent-activity-store.js";

const SESSION_COOKIE = "scriptorium_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const RUNTIME_CONTROL_CENSUS_TIMEOUT_MS = 3_500;
const RUNTIME_CONTROL_JWKS_TIMEOUT_MS = 1_000;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 1000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCRATCH_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const API_DRAIN_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_DOMAIN_JOBS = 32;
const API_VERSION = "0.1.0";
const STYLE_NONCES = new WeakMap<IncomingMessage, string>();
const PUBLIC_READER_MODULES = new Set(["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"]);
const SOURCE_DOMAIN_JOB_TYPES = new Set(["speaker-eval", "speaker-retrain", "aspect-review", "zukan-proposal", "summary-refresh"]);

interface Session {
  expiresAt: number;
}

export interface ApiServerOptions {
  store: CoreStore;
  authToken?: string;
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
  hosted?: {
    assignment: RuntimeAssignment;
    projectId: string;
    authorization: HostedAuthorizationPolicy;
    controlFetch?: typeof fetch;
    producerRevision?: string;
  };
}

export type HostedPermission = "read" | "write" | "maintain" | "admin";
export interface HostedPrincipal {
  userId: string;
  permissions: readonly HostedPermission[];
  repositoryId: number;
  instanceId: string;
  runtimeEpoch: number;
  sessionRevision: number;
  authorizationRevision: number;
  expiresAt: number;
}
export interface HostedAuthorizationPolicy {
  authenticate(token: string, requiredPermission?: HostedPermission): Promise<HostedPrincipal>;
  authorizePublication(token: string, input: { operationId: string; payloadDigest: string }): Promise<{
    receipt: string;
    operationId: string;
    payloadDigest: string;
  }>;
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

function cookieValues(request: IncomingMessage, name: string): string[] {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== "string") return [];
  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { values.push(decodeURIComponent(part.slice(separator + 1).trim())); }
    catch { return [""]; }
  }
  return values;
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

function sameHostedOrigin(request: IncomingMessage, trustProxy: boolean, audience: string): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    const assigned = new URL(audience);
    const parsed = new URL(origin);
    const target = new URL(`${requestProtocol(request, trustProxy)}//${host}`);
    return assigned.protocol === "https:" && assigned.origin === audience &&
      parsed.origin === audience && parsed.pathname === "/" && !parsed.search && !parsed.hash &&
      target.origin === audience;
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

function serializeParsedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw httpFailure(400, "INVALID_JSON", "Request body must be a JSON value");
  return serialized;
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
  const uiMatch = /^\/(desktop|mobile)(?:\/(.*))?$/u.exec(path);
  const ui = uiMatch?.[1];
  const uiPath = uiMatch?.[2] ?? "";
  const uiEntry = ui && /^(?:(?:|library|writing|reading|inspection|review|tools|settings)\/?|projects\/(?!\.{1,2}(?:\/|$))[^/\\]+(?:\/scenes\/(?!\.{1,2}(?:\/|$))[^/\\]+)?\/?)$/u.test(uiPath);
  let file = files[path] ?? (publicReaderPath ? files["/"] : undefined);
  if (uiEntry) file = { filename: `${ui}/index.html`, contentType: "text/html; charset=utf-8" };
  if (ui && /^(?:main\.js|styles\.css)$/u.test(uiPath)) {
    file = { filename: `${ui}/${uiPath}`, contentType: uiPath.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" };
  }
  const assetPrefix = ui ? `/${ui}/assets/` : "/assets/";
  if (!file && path.startsWith(assetPrefix)) {
    const name = path.slice(assetPrefix.length);
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return false;
    const extension = extname(name).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
      ".avif": "image/avif", ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2",
      ".ttf": "font/ttf", ".otf": "font/otf", ".ico": "image/x-icon",
    };
    if (!contentTypes[extension] || !/^[A-Za-z0-9._-]{1,180}$/u.test(name)) return false;
    file = { filename: resolve(staticDir, ...(ui ? [ui] : []), "assets", name), contentType: contentTypes[extension] };
  }
  if (!file) return false;
  try {
    const target = file.filename.startsWith(sep) ? file.filename : resolve(staticDir, file.filename);
    const root = await realpath(staticDir);
    const assetsDirectory = path.startsWith(assetPrefix) ? resolve(staticDir, ...(ui ? [ui] : []), "assets") : undefined;
    if (ui && (await lstat(resolve(staticDir, ui))).isSymbolicLink()) {
      sendJson(response, 404, { error: "Page not found", code: "NOT_FOUND" });
      return true;
    }
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
    const content = file.contentType.startsWith("text/html")
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
    if (path.startsWith(assetPrefix) && (code === "ENOENT" || code === "ENOTDIR")) {
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

function parseRecentActivityInput(value: unknown): RecentActivityInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["sceneId", "sentenceOffset", "pageIndex", "deviceType"]))) {
    throw httpFailure(400, "INVALID_RECENT_ACTIVITY", "Recent activity input is invalid");
  }
  if (typeof value.sceneId !== "string" || value.sceneId.length < 1 || value.sceneId.length > 512 ||
      /[\x00-\x1f\x7f]/u.test(value.sceneId) ||
      (value.sentenceOffset !== null && !Number.isSafeInteger(value.sentenceOffset)) ||
      (value.deviceType !== "desktop" && value.deviceType !== "mobile") ||
      (value.pageIndex !== undefined && value.pageIndex !== null &&
        (!Number.isSafeInteger(value.pageIndex) || (value.pageIndex as number) < 0))) {
    throw httpFailure(400, "INVALID_RECENT_ACTIVITY", "Recent activity cursor fields are invalid");
  }
  return {
    sceneId: value.sceneId,
    sentenceOffset: value.sentenceOffset as number | null,
    ...(value.pageIndex === undefined ? {} : { pageIndex: value.pageIndex as number | null }),
    deviceType: value.deviceType,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
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
  resolveDocumentScene?: (projectId: string, documentPath: string, pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; sceneId: string | null }>;
  registeredRepositoryIdentity: (projectId: string) => Promise<RepositoryIdentity>;
  detachProject?: (projectId: string) => Promise<void>;
  reconstructProject?: (projectId: string) => Promise<Project>;
  listManuscriptSnapshots?: (projectId: string, manuscriptId: string, sceneId?: string, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; snapshots: unknown[] }>;
  readManuscriptSnapshot?: (projectId: string, manuscriptId: string, snapshotId: string, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; manuscript: unknown } | null>;
  listProposals?: (projectId: string) => Promise<ProposalStatus[]>;
  getProposal?: (projectId: string, proposalId: string) => Promise<ProposalStatus | null>;
  searchSnapshot?: (projectId: string, query: string, limit?: number, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; results: unknown[] }>;
  writingStatsSnapshot?: (projectId: string, view?: "remote" | "checkpoint", pinned?: SnapshotId | string) => Promise<{ snapshot: SnapshotId; stats: unknown }>;
  getPublicationAuthorizationRequest?: (projectId: string, batchId: string) => Promise<{ operationId: string; payloadDigest: string } | null>;
};

type RuntimeHttpHost = ModuleRuntime & {
  metadata?: () => unknown;
  httpContributions?: (id: string) => readonly Omit<HttpContribution, "handle">[];
  invokeHttp?: (id: string, contributionId: string, request: Request, host: ActionHostContext) => Promise<Response>;
};

type HttpContributionDescriptor = Omit<HttpContribution, "handle">;

type TrackedDomainAction = ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> };
type DomainJobTracker = (
  descriptor: TrackedDomainAction,
  snapshot: SnapshotId,
  signal: AbortSignal,
  execute: DomainJobActionExecutor,
) => Promise<ActionResult>;

type ApiActionHost = Omit<ActionHostContext, "propose"> & {
  actions?: readonly { module: ModuleId | "core"; action: ModuleAction }[];
  linkedReader?: (repositoryId: string) => Promise<ModuleActionContext["reader"]>;
  access?: "owner" | "public";
  trackDomainJob?: DomainJobTracker;
  propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, signal?: AbortSignal): Promise<ChangeProposal>;
};

export function createServer(options: ApiServerOptions): Server {
  const hosted = options.hosted;
  if (!hosted && (!options.authToken || options.authToken.length < 32 || options.authToken.trim() !== options.authToken)) {
    throw new Error("SCRIPTORIUM_AUTH_TOKEN must contain at least 32 characters");
  }
  if (hosted && (options.authToken !== undefined || !hosted.projectId || hosted.authorization === undefined)) {
    throw new Error("Hosted runtime requires an assignment, assigned project, and grant policy without a standalone token");
  }
  const assignment = hosted?.assignment;
  if (assignment && parseRuntimeAssignment(assignment).instanceId !== assignment.instanceId) {
    throw new Error("Hosted runtime assignment is invalid");
  }
  const staticDir = options.staticDir ?? resolve(process.cwd(), "app/dist");
  const trustProxy = options.trustProxy ?? false;
  const configuredUsageDirectory = options.usageDirectory ?? process.env.SCRIPTORIUM_USAGE_DIR ?? resolve(process.env.SCRIPTORIUM_DATA_DIR ?? "./data", "host-history");
  if (!configuredUsageDirectory.trim()) throw new Error("Model usage history requires a non-empty usage directory");
  const usageDirectory = resolve(configuredUsageDirectory);
  const jobHistory = new JobHistoryStore(usageDirectory);
  const recentActivity = new RecentActivityStore(usageDirectory);
  const sessions = new Map<string, Session>();
  const requestControllers = new Set<AbortController>();
  const asyncDomainJobControllers = new Set<AbortController>();
  const activeDomainJobIds = new Set<string>();
  const activeWorkerJobIds = new Set<string>();
  const workerJobLifecycleStates = new Map<string, WorkerJobLifecycleSnapshot["state"]>();
  const uncertainPublicationBatches = new Set<string>();
  const projectEventStreams = new Set<ServerResponse>();
  const jobEventStreams = new Set<ServerResponse>();
  const coreStore = options.store as CoreStoreApi;
  let quiesceGate = false;
  let quiesceOperationId: string | undefined;
  let lastQuiesceOperationId: string | undefined;
  let lastResumedOperationId: string | undefined;
  let hostedRuntimeCensus: {
    mode: "remote" | "local";
    promise: Promise<{ status: RuntimeStatus; pendingProposals: number; complete: boolean; localWorkspaceDirty: boolean }>;
  } | undefined;
  let activeApiRequests = 0;
  let activeMcpRequests = 0;
  let activeMutations = 0;
  let runtimeActivityVersion = 0;
  let lastMeaningfulActivityAt: string | null = null;
  const recordRuntimeActivity = (): void => { runtimeActivityVersion += 1; };
  const listProjects = async (): Promise<Project[]> => {
    const projects = await options.store.listProjects();
    if (!hosted) return projects;
    if (projects.length !== 1 || projects[0]?.id !== hosted.projectId) {
      throw httpFailure(503, "HOSTED_REPOSITORY_BINDING_INVALID", "Hosted project registry does not match its runtime assignment");
    }
    if (!coreStore.registeredRepositoryIdentity) {
      throw httpFailure(503, "HOSTED_REPOSITORY_BINDING_UNAVAILABLE", "Core cannot verify the assigned repository identity");
    }
    const identity = await coreStore.registeredRepositoryIdentity(hosted.projectId);
    if (identity.provider !== "github" || identity.repositoryId !== String(assignment!.repositoryId)) {
      throw httpFailure(503, "HOSTED_REPOSITORY_BINDING_INVALID", "Registered repository identity does not match the runtime assignment");
    }
    return projects;
  };
  const assertAssignedProject = (projectId: string): void => {
    if (hosted && projectId !== hosted.projectId) {
      throw httpFailure(404, "PROJECT_NOT_FOUND", "Project was not found");
    }
  };
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
  const publishJobEvent = (event: JobEvent): void => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of jobEventStreams) {
      if (!response.destroyed && !response.writableEnded) {
        try { response.write(frame); }
        catch { jobEventStreams.delete(response); response.destroy(); }
      }
    }
  };
  const shutdownRuntime = (): Promise<void> => {
    runtimeShutdownPromise ??= Promise.resolve().then(() => {
      for (const controller of asyncDomainJobControllers) controller.abort(new Error("The API server is shutting down"));
      return runtime.shutdown();
    }).finally(async () => {
      unsubscribeJobLifecycle();
      await jobHistory.flush();
    });
    return runtimeShutdownPromise;
  };

  unsubscribeJobLifecycle = runtime.subscribeJobLifecycle(async (lifecycle: WorkerJobLifecycleSnapshot) => {
    const previousState = workerJobLifecycleStates.get(lifecycle.jobId);
    if (previousState !== lifecycle.state) recordRuntimeActivity();
    if (lifecycle.state === "queued" || lifecycle.state === "running") {
      workerJobLifecycleStates.set(lifecycle.jobId, lifecycle.state);
      activeWorkerJobIds.add(lifecycle.jobId);
    } else {
      workerJobLifecycleStates.delete(lifecycle.jobId);
      activeWorkerJobIds.delete(lifecycle.jobId);
    }
    try {
      const event = await jobHistory.record(lifecycle);
      publishJobEvent(event);
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
  const freshReader = async (projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId | string) => {
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
      { module: "core", action: {
        id: "core.document.resolve", effect: "read", outputSchema: jsonSchema,
        inputSchema: { parse(value: unknown) {
          if (!isRecord(value) || typeof value.path !== "string") throw new Error("A document path is required");
          assertProjectPath(value.path);
          return { path: value.path };
        } },
        async invoke(input, context) {
          if (!coreStore.resolveDocumentScene) return { ok: false, snapshot: context.reader.snapshot,
            error: { code: "DOCUMENT_NAVIGATION_UNAVAILABLE", message: "Document navigation is unavailable", retryable: false } };
          const result = await coreStore.resolveDocumentScene(projectId, (input as { path: string }).path, context.reader.snapshot);
          const document = result.sceneId === null ? await context.reader.read((input as { path: string }).path) : undefined;
          return { ok: true, snapshot: result.snapshot, data: { sceneId: result.sceneId,
            ...(document !== undefined ? { document: document ? { path: (input as { path: string }).path, ...document } : null } : {}) } };
        },
      } },
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
        for (const project of await listProjects()) {
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
  const actionFailure = (snapshot: SnapshotId, error: unknown, fallbackCode: string): ActionResult => {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    const code = typeof candidate?.code === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(candidate.code) ? candidate.code : fallbackCode;
    const message = typeof candidate?.message === "string" ? candidate.message.slice(0, 512) : "The domain job could not be completed";
    return { ok: false, snapshot, error: { code, message, retryable: candidate?.retryable === true } };
  };
  const actionHost = (
    projectId: string,
    reader: Awaited<ReturnType<typeof freshReader>>,
    signal: AbortSignal,
    source: ChangeProposal["source"],
    access: "owner" | "public" = "owner",
    onDomainJobStarted?: (jobId: string) => void,
    authorizeProposal?: () => Promise<void>,
  ): ApiActionHost => {
    const host: ApiActionHost = {
      projectId,
      reader,
      signal,
      actions: access === "public" ? [] : buildCoreActions(projectId),
      propose: async (operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, proposalSignal?: AbortSignal) => {
        if (access === "public") throw httpFailure(403, "PUBLIC_PROPOSAL_DENIED", "Public module requests cannot propose changes");
        if (hosted) {
          if (!authorizeProposal) throw httpFailure(403, "WRITE_PERMISSION_REQUIRED", "Current repository write permission is required to propose changes");
          await authorizeProposal();
        }
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
      host.trackDomainJob = async (descriptor, snapshot, jobSignal, execute) => {
        const type = descriptor.job.type;
        if (!SOURCE_DOMAIN_JOB_TYPES.has(type)) {
          return { ok: false, snapshot, error: { code: "domain_job_type_unsupported", message: "This domain job type is not registered by the host", retryable: false } };
        }
        if (activeDomainJobIds.size >= MAX_ACTIVE_DOMAIN_JOBS) {
          return { ok: false, snapshot, error: { code: "domain_job_capacity", message: "The host is already tracking the maximum number of domain jobs", retryable: true } };
        }
        const id = randomBytes(16).toString("hex");
        // Reserve synchronously, before the durable registration awaits, so
        // concurrent invokes cannot all observe the same free capacity.
        activeDomainJobIds.add(id);
        recordRuntimeActivity();
        let registered = false;
        try {
          const event = await jobHistory.beginDomainJob({ id, type, repository: snapshot.repository });
          registered = true;
          recordRuntimeActivity();
          publishJobEvent(event);
          onDomainJobStarted?.(id);
          publishJobEvent(await jobHistory.markDomainJobRunning(id));
          recordRuntimeActivity();
        } catch (error) {
          if (registered) {
            try {
              publishJobEvent(await jobHistory.finishDomainJob(id, actionFailure(snapshot, {
                code: "job_history_unavailable", message: "The host could not safely start this task", retryable: true,
              }, "job_history_unavailable")));
            } catch { /* Keep the original storage failure as the useful boundary error. */ }
          }
          if (activeDomainJobIds.delete(id)) recordRuntimeActivity();
          const code = error instanceof JobHistoryError ? error.code : "job_history_unavailable";
          console.error(`Scriptorium domain job was not started (${code}).`);
          return actionFailure(snapshot, { code: "job_history_unavailable", message: "The host could not safely register this job" }, "job_history_unavailable");
        }
        let result: ActionResult;
        try {
          result = jobSignal.aborted
            ? actionFailure(snapshot, jobSignal.reason, "action_cancelled")
            : await execute(async (progress) => {
                const event = await jobHistory.reportDomainJobProgress(id, progress);
                if (event) publishJobEvent(event);
              });
        }
        catch (error) { result = actionFailure(snapshot, error, "domain_job_failed"); }
        try { publishJobEvent(await jobHistory.finishDomainJob(id, result)); }
        catch (error) {
          const code = error instanceof JobHistoryError ? error.code : "storage_failure";
          console.error(`Scriptorium domain job result was not retained (${code}).`);
          try {
            const failed = actionFailure(snapshot, {
              code: "domain_job_result_not_retained",
              message: "The task finished, but its result could not be safely retained",
              retryable: true,
            }, "domain_job_result_not_retained");
            publishJobEvent(await jobHistory.finishDomainJob(id, failed));
          } catch { /* Startup recovery will mark any still-running record as interrupted. */ }
        } finally {
          if (activeDomainJobIds.delete(id)) recordRuntimeActivity();
        }
        return result;
      };
      host.linkedReader = async (repositoryId: string) => {
        if (hosted && repositoryId !== String(assignment!.repositoryId)) {
          throw httpFailure(404, "REPOSITORY_NOT_FOUND", "Linked repository is not assigned to this runtime");
        }
        for (const project of await listProjects()) {
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

  const createScratch = async (projectId: string, value: unknown, authorScope: string, response: ServerResponse): Promise<void> => {
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
    await options.store.approve(projectId, { proposalId: proposal.id, operationIds: [operation.id], authorScope });
    const receipt = await options.store.checkpoint(projectId, operation);
    sendJson(response, 201, {
      id, path: filePath, createdAt, ...(source ? { source } : {}), sceneId: sceneId ?? null,
      attachments: attachments.map(({ filename, path, mimeType }) => ({ filename, path, mimeType })), proposal, receipt,
    });
  };

  const collectHostedRuntimeStatus = async (mode: "remote" | "local"): Promise<{ status: RuntimeStatus; pendingProposals: number; complete: boolean; localWorkspaceDirty: boolean }> => {
    if (!hosted || !assignment) throw httpFailure(404, "PLATFORM_CONTROL_UNAVAILABLE", "Hosted runtime controls are unavailable");
    let remoteRevision: string | null = null;
    let remoteObservedAt: string | null = null;
    let pendingCheckpoints = 0;
    let pendingProposals = 0;
    let complete = false;
    let localWorkspaceDirty = false;
    let persistence: PersistenceObservation = { state: "unknown", observedRemoteCommit: null, remoteObservedAt: null, formats: [] };
    const uncertainPublication = uncertainPublicationBatches.size > 0;
    const activityVersionAtScanStart = runtimeActivityVersion;
    try {
      if (mode === "local") {
        const census = await coreStore.localDurabilityCensus(hosted.projectId);
        const observation = census.observation;
        const localRevision = normalizeRemoteRevision(observation.snapshot.remoteCommit);
        if (observation.state !== "fresh" || localRevision === undefined) {
          throw new Error("recent local durability observation is unavailable");
        }
        remoteRevision = localRevision;
        remoteObservedAt = observation.observedAt;
        if (!Number.isFinite(Date.parse(remoteObservedAt))) throw new Error("remote observation time is invalid");
        pendingCheckpoints = census.pendingCheckpoints.length;
        pendingProposals = census.pendingProposals;
        localWorkspaceDirty = census.localWorkspaceDirty;
        if (normalizeRemoteRevision(census.reader.snapshot.remoteCommit) !== remoteRevision) {
          throw new Error("local durability reader was not pinned to the observed commit");
        }
        persistence = await scanRemotePersistence(census.reader, remoteRevision);
      } else {
        const before = await options.store.observe(hosted.projectId);
        const beforeRevision = normalizeRemoteRevision(before.snapshot.remoteCommit);
        if (before.state !== "fresh" || beforeRevision === undefined) throw new Error("remote observation is not fresh");
        remoteRevision = beforeRevision;
        pendingCheckpoints = before.pending.length;
        const reader = await options.store.reader(hosted.projectId, "remote", remoteRevision ?? undefined);
        if (normalizeRemoteRevision(reader.snapshot.remoteCommit) !== remoteRevision) throw new Error("remote reader was not pinned to the observed commit");
        persistence = await scanRemotePersistence(reader, remoteRevision);
        if (!coreStore.listProposals) throw new Error("proposal status is unavailable");
        const after = await options.store.observe(hosted.projectId);
        const afterRevision = normalizeRemoteRevision(after.snapshot.remoteCommit);
        if (after.state === "fresh" && afterRevision !== undefined) remoteObservedAt = after.observedAt;
        if (after.state !== "fresh" || afterRevision !== remoteRevision) {
          if (afterRevision !== undefined) remoteRevision = afterRevision;
          persistence = { state: "unknown", observedRemoteCommit: remoteRevision, remoteObservedAt, formats: [] };
          throw new Error("remote changed during persistence scan");
        }
        pendingCheckpoints = after.pending.length;
        const proposals = await coreStore.listProposals(hosted.projectId);
        pendingProposals = proposals.filter((proposal) => proposal.state !== "checkpointed").length;
      }
      if (!remoteObservedAt || !Number.isFinite(Date.parse(remoteObservedAt)) || Date.now() - Date.parse(remoteObservedAt) < 0 ||
          Date.now() - Date.parse(remoteObservedAt) >= 15_000) throw new Error("remote observation expired during persistence scan");
      persistence = { ...persistence, remoteObservedAt };
      complete = persistence.state === "verified" && persistence.observedRemoteCommit === remoteRevision &&
        activityVersionAtScanStart === runtimeActivityVersion;
      if (!complete) persistence = { state: "unknown", observedRemoteCommit: remoteRevision, remoteObservedAt, formats: [] };
    } catch {
      persistence = { state: "unknown", observedRemoteCommit: remoteRevision, remoteObservedAt, formats: [] };
    }
    const observedAt = new Date().toISOString();
    const activeJobs = new Set([...activeWorkerJobIds, ...activeDomainJobIds]).size;
    const status: RuntimeStatus = {
      contractVersion: "scriptorium-platform/v1",
      instanceId: assignment.instanceId,
      repositoryId: assignment.repositoryId,
      runtimeEpoch: assignment.runtimeEpoch,
      imageDigest: assignment.imageDigest,
      compositionManifestDigest: assignment.compositionManifestDigest,
      enabledModuleIds: [...assignment.enabledModuleIds],
      ready: started && !closed && !shuttingDown && !quiesceGate,
      activity: {
        lastMeaningfulActivityAt,
        activeApiRequests,
        activeMcpRequests,
        activeMutations,
        activeJobs,
        restartableJobs: 0,
        pendingCheckpoints,
        uncertainPublication,
      },
      lastConfirmedRemoteRevision: remoteRevision,
      persistence,
      observedAt,
    };
    return { status, pendingProposals, complete, localWorkspaceDirty };
  };

  const unavailableHostedRuntimeStatus = (): { status: RuntimeStatus; pendingProposals: number; complete: false; localWorkspaceDirty: false } => {
    if (!hosted || !assignment) throw httpFailure(404, "PLATFORM_CONTROL_UNAVAILABLE", "Hosted runtime controls are unavailable");
    const status: RuntimeStatus = {
      contractVersion: "scriptorium-platform/v1",
      instanceId: assignment.instanceId,
      repositoryId: assignment.repositoryId,
      runtimeEpoch: assignment.runtimeEpoch,
      imageDigest: assignment.imageDigest,
      compositionManifestDigest: assignment.compositionManifestDigest,
      enabledModuleIds: [...assignment.enabledModuleIds],
      ready: started && !closed && !shuttingDown && !quiesceGate,
      activity: {
        lastMeaningfulActivityAt,
        activeApiRequests,
        activeMcpRequests,
        activeMutations,
        activeJobs: new Set([...activeWorkerJobIds, ...activeDomainJobIds]).size,
        restartableJobs: 0,
        pendingCheckpoints: 0,
        uncertainPublication: uncertainPublicationBatches.size > 0,
      },
      lastConfirmedRemoteRevision: null,
      persistence: { state: "unknown", observedRemoteCommit: null, remoteObservedAt: null, formats: [] },
      observedAt: new Date().toISOString(),
    };
    return { status, pendingProposals: 0, complete: false, localWorkspaceDirty: false };
  };

  const readHostedRuntimeStatus = async (maximumWaitMs?: number, requestedMode?: "remote" | "local"): Promise<{ status: RuntimeStatus; pendingProposals: number; complete: boolean; localWorkspaceDirty: boolean }> => {
    const mode = requestedMode ?? (quiesceGate ? "local" : "remote");
    let scan: Promise<{ status: RuntimeStatus; pendingProposals: number; complete: boolean; localWorkspaceDirty: boolean }>;
    if (hostedRuntimeCensus?.mode === mode) {
      scan = hostedRuntimeCensus.promise;
    } else {
      const entry: NonNullable<typeof hostedRuntimeCensus> = {
        mode,
        promise: Promise.resolve(unavailableHostedRuntimeStatus()),
      };
      entry.promise = collectHostedRuntimeStatus(mode).finally(() => {
        if (hostedRuntimeCensus === entry) hostedRuntimeCensus = undefined;
      });
      hostedRuntimeCensus = entry;
      scan = entry.promise;
    }
    if (maximumWaitMs === undefined) return scan;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ status: RuntimeStatus; pendingProposals: number; complete: false; localWorkspaceDirty: false }>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(unavailableHostedRuntimeStatus()), Math.max(0, maximumWaitMs));
      timer.unref();
    });
    try { return await Promise.race([scan, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  };

  const authorizeRuntimeControl = async (
    request: IncomingMessage,
    action: "status" | "quiesce" | "resume",
    operationId: string,
    payloadDigest: string,
  ) => {
    if (!hosted || !assignment) throw httpFailure(404, "PLATFORM_CONTROL_UNAVAILABLE", "Hosted runtime controls are unavailable");
    const accessCookies = cookieValues(request, HOSTED_ACCESS_COOKIE);
    if (accessCookies.length > 0) throw httpFailure(400, "AMBIGUOUS_CREDENTIALS", "Runtime controls require a control-service bearer credential only");
    const header = request.headers.authorization;
    const token = typeof header === "string" && /^Bearer [A-Za-z0-9_.-]+$/u.test(header) ? header.slice(7) : "";
    if (!token) throw httpFailure(401, "RUNTIME_CONTROL_UNAUTHORIZED", "A signed runtime-control credential is required");
    try {
      const fetcher: typeof fetch = (input, init) => {
        const boundedSignal = AbortSignal.timeout(RUNTIME_CONTROL_JWKS_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([init.signal, boundedSignal]) : boundedSignal;
        return (hosted.controlFetch ?? fetch)(input, { ...init, signal });
      };
      const verified = await verifyCompactJwt(
        token,
        assignment.controlServicePolicy.jwksUrl,
        assignment.controlServicePolicy.issuer,
        assignment.controlServicePolicy.audience,
        Date.now(),
        fetcher,
      );
      const claims = isRecord(verified) ? verified : null;
      const boundOperationId = action === "status" ? claims?.operationId : operationId;
      if (typeof boundOperationId !== "string") throw new TypeError("runtime control operation is missing");
      return parseRuntimeControlCredential(verified, {
        issuer: assignment.controlServicePolicy.issuer,
        audience: assignment.controlServicePolicy.audience,
        instanceId: assignment.instanceId,
        repositoryId: assignment.repositoryId,
        runtimeEpoch: assignment.runtimeEpoch,
        operationId: boundOperationId,
        action,
        payloadDigest,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
    } catch {
      throw httpFailure(401, "RUNTIME_CONTROL_UNAUTHORIZED", "Runtime-control credential binding is invalid or expired");
    }
  };

  const bindQuiesceRequest = (request: QuiesceRequest, credential: { operationId: string }): void => {
    if (!assignment || request.instanceId !== assignment.instanceId || request.runtimeEpoch !== assignment.runtimeEpoch ||
        request.operationId !== credential.operationId) {
      throw httpFailure(403, "RUNTIME_CONTROL_BINDING_MISMATCH", "Quiesce request does not match its runtime-control credential");
    }
  };

  const platformStatus = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await authorizeRuntimeControl(request, "status", "status", sha256Digest(""));
    const { status } = await readHostedRuntimeStatus(RUNTIME_CONTROL_CENSUS_TIMEOUT_MS);
    sendJson(response, 200, status);
  };

  const platformQuiesce = async (request: IncomingMessage, response: ServerResponse, parsedBody?: unknown): Promise<void> => {
    if (!hosted) throw httpFailure(404, "PLATFORM_CONTROL_UNAVAILABLE", "Hosted runtime controls are unavailable");
    let rawBody: unknown;
    let body: QuiesceRequest;
    try {
      rawBody = await readJson(request, parsedBody);
      body = parseQuiesceRequest(rawBody);
    }
    catch { throw httpFailure(400, "QUIESCE_REQUEST_INVALID", "Quiesce request does not match the runtime-control contract"); }
    bindQuiesceRequest(body, { operationId: body.operationId });
    // Praetorium signs JSON.stringify(requestBody); preserve the parsed wire
    // object's property insertion order instead of hashing the parser's rebuilt
    // contract object, whose order is intentionally different.
    const serialized = serializeParsedJson(rawBody);
    const credential = await authorizeRuntimeControl(request, "quiesce", body.operationId, sha256Digest(serialized));
    bindQuiesceRequest(body, credential);
    if (Date.parse(body.deadline) <= Date.now()) throw httpFailure(409, "QUIESCE_DEADLINE_EXPIRED", "Quiesce deadline has expired");
    if (quiesceGate && quiesceOperationId !== body.operationId) {
      throw httpFailure(409, "QUIESCE_ALREADY_ACTIVE", "A different runtime operation already owns quiesce admission");
    }
    quiesceGate = true;
    quiesceOperationId = body.operationId;
    lastQuiesceOperationId = body.operationId;
    const censusWaitMs = Math.max(0, Math.min(RUNTIME_CONTROL_CENSUS_TIMEOUT_MS, Date.parse(body.deadline) - Date.now()));
    const census = await readHostedRuntimeStatus(censusWaitMs, "local");
    const { status, pendingProposals, complete, localWorkspaceDirty } = census;
    const reasonCodes: string[] = [];
    if (status.activity.activeMutations > 0) reasonCodes.push("ACTIVE_MUTATIONS");
    if (status.activity.activeJobs > 0) reasonCodes.push("ACTIVE_JOBS");
    if (status.activity.pendingCheckpoints > 0) reasonCodes.push("PENDING_CHECKPOINTS");
    if (pendingProposals > 0) reasonCodes.push("PENDING_PROPOSALS");
    if (status.activity.uncertainPublication) reasonCodes.push("UNCERTAIN_PUBLICATION");
    if (localWorkspaceDirty) reasonCodes.push("LOCAL_WORKSPACE_DIRTY");
    if (!complete || status.persistence.state !== "verified") reasonCodes.push("PERSISTENCE_UNVERIFIED");
    if (Date.parse(body.deadline) <= Date.now()) reasonCodes.push("QUIESCE_DEADLINE_EXPIRED");
    const unknown = !complete || status.activity.uncertainPublication;
    const blocked = status.activity.activeMutations > 0 || status.activity.activeJobs > 0 ||
      status.activity.pendingCheckpoints > 0 || pendingProposals > 0 || localWorkspaceDirty;
    const disposition = Date.parse(body.deadline) <= Date.now() ? "unknown" : unknown ? "unknown" : blocked ? "blocked" : "safe";
    if (disposition === "blocked") {
      quiesceGate = false;
      quiesceOperationId = undefined;
    }
    const result: QuiesceResult = {
      contractVersion: "scriptorium-platform/v1",
      operationId: body.operationId,
      instanceId: hosted.assignment.instanceId,
      runtimeEpoch: hosted.assignment.runtimeEpoch,
      quiesceRevision: status.lastConfirmedRemoteRevision ?? `q-${body.operationId}`,
      disposition,
      activeMutations: status.activity.activeMutations,
      activeJobs: status.activity.activeJobs,
      restartableJobs: status.activity.restartableJobs,
      pendingCheckpoints: status.activity.pendingCheckpoints,
      uncertainPublication: status.activity.uncertainPublication,
      lastConfirmedRemoteRevision: status.lastConfirmedRemoteRevision,
      reasonCodes,
      observedAt: status.observedAt,
    };
    sendJson(response, 200, result);
  };

  const platformResume = async (request: IncomingMessage, response: ServerResponse, parsedBody?: unknown): Promise<void> => {
    if (!hosted) throw httpFailure(404, "PLATFORM_CONTROL_UNAVAILABLE", "Hosted runtime controls are unavailable");
    let rawBody: unknown;
    let body: QuiesceRequest;
    try {
      rawBody = await readJson(request, parsedBody);
      body = parseQuiesceRequest(rawBody);
    }
    catch { throw httpFailure(400, "RESUME_REQUEST_INVALID", "Resume request does not match the runtime-control contract"); }
    const credential = await authorizeRuntimeControl(request, "resume", body.operationId, sha256Digest(serializeParsedJson(rawBody)));
    bindQuiesceRequest(body, credential);
    if (quiesceOperationId !== undefined && quiesceOperationId !== body.operationId) {
      throw httpFailure(409, "RESUME_BINDING_MISMATCH", "Resume request does not own the active quiesce operation");
    }
    if (quiesceOperationId === undefined && body.operationId !== lastQuiesceOperationId && body.operationId !== lastResumedOperationId) {
      throw httpFailure(409, "RESUME_BINDING_MISMATCH", "Resume request does not match a known quiesce operation");
    }
    if (quiesceOperationId !== undefined) {
      quiesceGate = false;
      quiesceOperationId = undefined;
      lastResumedOperationId = body.operationId;
    }
    response.writeHead(204);
    response.end();
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, parsedBody?: unknown): Promise<void> => {
    const styleNonce = STYLE_NONCES.get(request) ?? randomBytes(18).toString("base64");
    if (!response.headersSent) setSecurityHeaders(response, styleNonce);
    const routePath = requestPath(request);
    const method = request.method ?? "GET";
    const query = queryOf(request);
    const isRead = method === "GET" || method === "HEAD";
    const publicRead = isRead && ["/api/health", "/api/ready", "/api/version", "/health/live", "/health/ready", "/health/startup"].includes(routePath);
    const publicModuleRoute = !hosted && routePath.startsWith("/api/public/repos/") && routePath.includes("/modules/");

    if (hosted && routePath === "/api/login" && method === "POST") {
      fail(response, 410, "HOSTED_LOGIN_RETIRED", "Hosted access is issued by Praetorium. Open this instance through Praetorium.");
      return;
    }
    if (hosted && routePath === "/api/logout" && method === "POST") {
      fail(response, 410, "HOSTED_LOGOUT_RETIRED", "Hosted logout is handled by Instance Access.");
      return;
    }
    if (routePath === RUNTIME_METADATA_PATH && method === "GET") {
      try {
        sendJson(response, 200, metadataForRuntime({
          producerRevision: hosted?.producerRevision ?? process.env.SCRIPTORIUM_PRODUCER_REVISION ?? "",
          port: parsePositivePort(process.env.PORT),
          shutdownTimeoutSeconds: 25,
        }));
      } catch { throw httpFailure(503, "RUNTIME_METADATA_UNAVAILABLE", "Immutable producer runtime metadata is unavailable"); }
      return;
    }
    if (hosted && routePath === RUNTIME_STATUS_PATH && method === "GET") { await platformStatus(request, response); return; }
    if (hosted && routePath === RUNTIME_QUIESCE_PATH && method === "POST") { await platformQuiesce(request, response, parsedBody); return; }
    if (hosted && routePath === RUNTIME_RESUME_PATH && method === "POST") { await platformResume(request, response, parsedBody); return; }

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
      if (!constantTimeEqual(token, options.authToken ?? "")) { fail(response, 401, "UNAUTHORIZED", "Invalid access token"); return; }
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
        hosted: Boolean(hosted),
        profile, auth: ["cookie-owner", "bearer-read-compute-propose"], runtime: { name: "@scriptorium/module-runtime", contractVersion: CONTRACT_VERSION, ...(runtime.metadata ? { metadata: runtime.metadata() } : {}) },
        modules: await enabledStatuses(),
      });
      return;
    }
    const sessionId = cookieValue(request, SESSION_COOKIE);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const accessCookies = hosted ? cookieValues(request, HOSTED_ACCESS_COOKIE) : [];
    const accessToken = accessCookies.length === 1 ? accessCookies[0] : undefined;
    const authHeader = request.headers.authorization;
    const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (hosted && accessCookies.length > 1) { fail(response, 401, "UNAUTHORIZED", "Hosted access cookie is ambiguous"); return; }
    if (hosted && accessToken && bearer) { fail(response, 400, "AMBIGUOUS_CREDENTIALS", "Send either a hosted browser grant or a bearer grant"); return; }
    let hostedPrincipal: HostedPrincipal | undefined;
    const presentedHostedToken = hosted ? accessToken ?? (bearer || undefined) : undefined;
    if (hosted && presentedHostedToken) {
      try { hostedPrincipal = await hosted.authorization.authenticate(presentedHostedToken, "read"); }
      catch (error) {
        const candidate = error as { status?: unknown };
        const status = candidate?.status === 403 ? 403 : 401;
        fail(response, status, status === 403 ? "FORBIDDEN" : "UNAUTHORIZED", "Hosted repository access is invalid or expired");
        return;
      }
    }
    const isCookie = hosted ? Boolean(accessToken && hostedPrincipal) : Boolean(session && session.expiresAt > Date.now());
    if (sessionId && !isCookie) sessions.delete(sessionId);
    const isBearer = hosted ? Boolean(bearer && hostedPrincipal) : !isCookie && bearer.length > 0 && constantTimeEqual(bearer, options.authToken!);
    const hasAuth = hosted ? Boolean(hostedPrincipal) : isCookie || isBearer;
    if (routePath.startsWith("/api/") && !publicRead && !publicModuleRoute && !hasAuth) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="scriptorium", Cookie realm="scriptorium"');
      fail(response, 401, "UNAUTHORIZED", "Authentication required");
      return;
    }
    if (!hosted && isCookie) session!.expiresAt = Date.now() + SESSION_TTL_MS;
    if (hosted && accessToken && !isRead && routePath.startsWith("/api/")) {
      const csrfCookies = cookieValues(request, HOSTED_CSRF_COOKIE);
      const csrfHeader = request.headers["x-csrf-token"];
      const originMatches = hosted
        ? sameHostedOrigin(request, trustProxy, assignment!.grantPolicy.audience)
        : sameOrigin(request, trustProxy);
      if (!originMatches || csrfCookies.length !== 1 || !csrfCookies[0] ||
          typeof csrfHeader !== "string" || !constantTimeEqual(csrfHeader, csrfCookies[0])) {
        fail(response, 403, "CSRF_INVALID", "Hosted browser mutations require same-origin CSRF validation");
        return;
      }
    }
    if (!hosted && isCookie && !isRead && routePath.startsWith("/api/") && !sameOrigin(request, trustProxy)) {
      fail(response, 403, "CROSS_ORIGIN_REQUEST", "Request origin must match this application");
      return;
    }
    const requireWritePermission = async (): Promise<HostedPrincipal | undefined> => {
      if (hosted) {
        if (!presentedHostedToken) throw httpFailure(401, "UNAUTHORIZED", "A hosted user grant is required");
        try {
          const principal = await hosted.authorization.authenticate(presentedHostedToken, "write");
          hostedPrincipal = principal;
          return principal;
        }
        catch { throw httpFailure(403, "WRITE_PERMISSION_REQUIRED", "Current repository write permission is required"); }
      }
      if (!isCookie) throw httpFailure(403, "AUTHOR_SESSION_REQUIRED", "An owner session is required");
      return undefined;
    };
    if (shuttingDown && routePath.startsWith("/api/") && !isRead) {
      fail(response, 503, "SHUTTING_DOWN", "The server is draining and is not accepting new mutations");
      return;
    }
    if (hosted && quiesceGate && routePath.startsWith("/api/") && !isRead &&
        routePath !== RUNTIME_QUIESCE_PATH && routePath !== RUNTIME_RESUME_PATH) {
      fail(response, 503, "RUNTIME_QUIESCED", "This runtime is quiescing and is not accepting mutations");
      return;
    }
    if (hasAuth && hosted && routePath.startsWith("/api/") &&
        !["/api/health", "/api/ready", "/api/version", RUNTIME_STATUS_PATH, RUNTIME_QUIESCE_PATH, RUNTIME_RESUME_PATH, RUNTIME_METADATA_PATH].includes(routePath) &&
        ((method !== "GET" && method !== "HEAD" && method !== "OPTIONS") || routePath.endsWith("/recent-activity"))) {
      lastMeaningfulActivityAt = new Date().toISOString();
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
      sendJson(response, 200, {
        authenticated: true,
        authorScope: hosted ? `hosted:${hostedPrincipal!.userId}` : isCookie ? "owner" : "",
        ...(hosted ? { permissions: [...hostedPrincipal!.permissions] } : {}),
      });
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
      await requireWritePermission();
      try { sendJson(response, 200, { marked: await jobHistory.markAllInboxRead() }); }
      catch { throw httpFailure(503, "JOB_HISTORY_UNAVAILABLE", "Inbox is temporarily unavailable"); }
      return;
    }
    const inboxReadMatch = routePath.match(/^\/api\/inbox\/([^/]+)\/read$/u);
    if (inboxReadMatch && method === "POST") {
      await requireWritePermission();
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
    if (routePath === "/api/projects" && method === "GET") { sendJson(response, 200, await listProjects()); return; }
    if (routePath === "/api/projects" && method === "POST") {
      if (hosted) throw httpFailure(403, "HOSTED_ASSIGNMENT_IMMUTABLE", "Hosted runtimes can only use their assigned repository");
      await requireWritePermission();
      const body = await readJson(request, parsedBody);
      if (!isRecord(body) || typeof body.url !== "string" || !body.url.trim()) throw httpFailure(400, "INVALID_PROJECT", "Repository URL is required");
      if (body.branch !== undefined && typeof body.branch !== "string") throw httpFailure(400, "INVALID_PROJECT", "Branch must be a string");
      const project = await options.store.registerProject({ url: body.url.trim(), ...(typeof body.branch === "string" && body.branch.trim() ? { branch: body.branch.trim() } : {}) });
      sendJson(response, 201, project); return;
    }
    if (routePath === "/api/review-queue" && method === "GET") {
      if (!coreStore.listProposals) throw httpFailure(503, "PROPOSAL_STATUS_UNAVAILABLE", "Proposal review is not available in this Core version");
      const items: Array<{ projectId: string; proposal: ProposalStatus }> = [];
      for (const project of await listProjects()) {
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
      assertAssignedProject(projectId);
      const suffix = projectRoot[2] ?? "";
      if (suffix === "recent-activity" && (method === "GET" || method === "PUT")) {
        if (!hosted && !isCookie) { fail(response, 403, "AUTHOR_SESSION_REQUIRED", "Recent activity requires an owner session"); return; }
        if (method === "PUT") await requireWritePermission();
        const activityAuthorScope = hosted ? `hosted:${hostedPrincipal!.userId}` : "owner";
        const repository = await coreStore.registeredRepositoryIdentity(projectId);
        try {
          if (method === "GET") {
            sendJson(response, 200, { items: await recentActivity.list(activityAuthorScope, repository) });
            return;
          }
          const input = parseRecentActivityInput(await readJson(request, parsedBody));
          sendJson(response, 200, { items: await recentActivity.upsert(activityAuthorScope, repository, input) });
          return;
        } catch (error) {
          if (isHttpFailure(error)) throw error;
          throw httpFailure(503, "RECENT_ACTIVITY_UNAVAILABLE", "Recent activity history is temporarily unavailable");
        }
      }
      if (suffix === "" && method === "GET") {
        const project = (await listProjects()).find((candidate) => candidate.id === projectId);
        if (!project) throw httpFailure(404, "PROJECT_NOT_FOUND", "Project not found");
        const observation = await options.store.localObservation(projectId);
        sendJson(response, 200, { project, observation });
        return;
      }
      if (suffix === "" && method === "PUT") {
        if (hosted) throw httpFailure(403, "HOSTED_ASSIGNMENT_IMMUTABLE", "Hosted project reconstruction is controlled by Praetorium");
        await requireWritePermission();
        if (!coreStore.reconstructProject) throw httpFailure(503, "PROJECT_RECONSTRUCTION_UNAVAILABLE", "Core cannot safely reconstruct registered projects in this version");
        const currentProject = (await listProjects()).find((candidate) => candidate.id === projectId);
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
        if (hosted) throw httpFailure(403, "HOSTED_ASSIGNMENT_IMMUTABLE", "Hosted project detachment is controlled by Praetorium");
        await requireWritePermission();
        if (!coreStore.detachProject) throw httpFailure(503, "PROJECT_DETACH_UNAVAILABLE", "Core cannot safely detach registered projects in this version");
        await coreStore.detachProject(projectId);
        response.writeHead(204);
        response.end();
        return;
      }
      if (suffix === "" && method === "PATCH") {
        if (hosted) throw httpFailure(403, "HOSTED_ASSIGNMENT_IMMUTABLE", "Hosted runtime settings are controlled by Praetorium");
        await requireWritePermission();
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
      const sceneViewsMatch = suffix.match(/^scenes\/([^/]+)\/views$/u);
      if (sceneViewsMatch && method === "GET") {
        const sceneId = parseSceneId(sceneViewsMatch[1]!);
        const pinned = query.get("snapshot");
        if (!pinned || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pinned)) {
          throw httpFailure(400, "INVALID_SNAPSHOT", "Scene views require a pinned remote commit");
        }
        sendJson(response, 200, await options.store.readSceneViews(projectId, sceneId, pinned));
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
        await requireWritePermission();
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
        await requireWritePermission();
        sendJson(response, 200, await options.store.reconcile(projectId)); return;
      }
      if (suffix === "publish" && method === "POST") {
        const publishPrincipal = await requireWritePermission();
        const body = await readJson(request, parsedBody);
        if (!isRecord(body) || typeof body.batchId !== "string" || !body.batchId) throw httpFailure(400, "INVALID_BATCH", "A publish batch ID is required");
        if (!hosted) { sendJson(response, 200, await options.store.publish(projectId, body.batchId)); return; }
        if (!presentedHostedToken || !coreStore.getPublicationAuthorizationRequest) {
          throw httpFailure(503, "PUBLISH_AUTHORIZATION_UNAVAILABLE", "Hosted publication authorization is not available");
        }
        const publicationRequest = await coreStore.getPublicationAuthorizationRequest(projectId, body.batchId);
        let authorization: { receipt: string; operationId: string; payloadDigest: string } | undefined;
        if (publicationRequest) {
          const current = await hosted.authorization.authenticate(presentedHostedToken, "write");
          if (current.userId !== publishPrincipal?.userId) {
            throw httpFailure(403, "PUBLISH_PRINCIPAL_CHANGED", "The hosted user authorization changed during publication");
          }
          authorization = await hosted.authorization.authorizePublication(presentedHostedToken, publicationRequest);
          if (authorization.operationId !== publicationRequest.operationId || authorization.payloadDigest !== publicationRequest.payloadDigest) {
            throw httpFailure(403, "PUBLISH_AUTHORIZATION_MISMATCH", "Publication authorization did not bind the exact pending checkpoint batch");
          }
        }
        uncertainPublicationBatches.add(body.batchId);
        try {
          const result = await options.store.publish(projectId, body.batchId, authorization);
          if (result.state === "confirmed" || result.state === "conflict") uncertainPublicationBatches.delete(body.batchId);
          sendJson(response, 200, result);
        } catch (error) {
          const candidate = error as { status?: unknown };
          if (typeof candidate?.status === "number" && candidate.status < 500) uncertainPublicationBatches.delete(body.batchId);
          throw error;
        }
        return;
      }
      if (suffix === "proposals" && method === "POST") {
        if (hosted) await requireWritePermission();
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
        const approver = await requireWritePermission();
        const body = await readJson(request, parsedBody);
        if (!isRecord(body) || typeof body.proposalId !== "string" || !body.proposalId || !Array.isArray(body.operationIds) || !body.operationIds.every((id) => typeof id === "string")) throw httpFailure(400, "INVALID_APPROVAL", "Proposal and operation IDs are required");
        await options.store.approve(projectId, { proposalId: body.proposalId, operationIds: body.operationIds as string[], authorScope: hosted ? `hosted:${approver!.userId}` : "owner" });
        response.writeHead(204); response.end(); return;
      }
      if (suffix === "checkpoints" && method === "POST") {
        await requireWritePermission();
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
        if (hosted && descriptor.effect !== "read") await requireWritePermission();
        let boundSnapshot: SnapshotId | undefined;
        if (body.snapshot !== undefined) {
          const selected = body.snapshot;
          if (!isRecord(selected) || !isRecord(selected.repository) ||
              !["github", "local"].includes(String(selected.repository.provider)) ||
              ["repositoryId", "defaultBranch", "ownerScope", "url"].some((key) => typeof (selected.repository as Record<string, unknown>)[key] !== "string") ||
              typeof selected.remoteCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(selected.remoteCommit) ||
              (selected.overlayCommit !== undefined && (typeof selected.overlayCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(selected.overlayCommit)))) {
            throw httpFailure(400, "INVALID_SNAPSHOT", "A complete repository-bound snapshot is required");
          }
          boundSnapshot = selected as unknown as SnapshotId;
        }
        const reader = await freshReader(projectId, boundSnapshot ? "checkpoint" : "remote", boundSnapshot);
        const source = descriptor.module === "core"
          ? isBearer ? "mcp" : "author"
          : isBearer || descriptor.module === "mcp" ? "mcp" : "module";
        const prefer = request.headers.prefer;
        const respondAsyncRequested = isCookie && (Array.isArray(prefer) ? prefer : [prefer ?? ""])
          .flatMap((value) => value.split(","))
          .some((value) => value.trim().toLowerCase() === "respond-async");
        const jobController = respondAsyncRequested && descriptor.module !== "core" ? new AbortController() : undefined;
        let domainJobId: string | undefined;
        let resolveDomainJobStart!: (id: string) => void;
        const domainJobStarted = new Promise<string>((resolveStarted) => { resolveDomainJobStart = resolveStarted; });
        const abortBeforeAcceptance = (): void => {
          if (!domainJobId) jobController?.abort(signal.reason ?? new Error("The action request was cancelled before job registration"));
        };
        if (jobController) {
          asyncDomainJobControllers.add(jobController);
          if (signal.aborted) abortBeforeAcceptance();
          else signal.addEventListener("abort", abortBeforeAcceptance, { once: true });
        }
        const actionSignal = jobController?.signal ?? signal;
        const host = actionHost(projectId, reader, actionSignal, source, "owner", (id) => {
          domainJobId = id;
          signal.removeEventListener("abort", abortBeforeAcceptance);
          resolveDomainJobStart(id);
        }, async () => { await requireWritePermission(); });
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
        const invocation = runtime.invokeAction(descriptor.module, actionId, body.input, host);
        const settledInvocation = invocation.then(
          (result) => ({ kind: "result" as const, result }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        if (jobController) {
          void settledInvocation.then(() => {
            asyncDomainJobControllers.delete(jobController);
            signal.removeEventListener("abort", abortBeforeAcceptance);
          });
        }
        if (respondAsyncRequested) {
          const outcome = await Promise.race([
            domainJobStarted.then((id) => ({ kind: "started" as const, id })),
            settledInvocation.then((settled) => ({ kind: "settled" as const, settled })),
          ]);
          if (outcome.kind === "started") {
            const job = await jobHistory.getJob(outcome.id);
            if (!job) throw httpFailure(503, "JOB_HISTORY_UNAVAILABLE", "The registered job could not be read back");
            response.setHeader("X-Scriptorium-Job-Id", job.id);
            response.setHeader("Location", `/api/jobs/${encodeURIComponent(job.id)}`);
            response.setHeader("Preference-Applied", "respond-async");
            sendJson(response, 202, job);
            return;
          }
          if (outcome.settled.kind === "error") throw outcome.settled.error;
          if (domainJobId) response.setHeader("X-Scriptorium-Job-Id", domainJobId);
          sendJson(response, 200, outcome.settled.result);
          return;
        }
        const outcome = await settledInvocation;
        if (outcome.kind === "error") throw outcome.error;
        if (domainJobId) response.setHeader("X-Scriptorium-Job-Id", domainJobId);
        sendJson(response, 200, outcome.result); return;
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
        if (isBearer && !["read", "compute", "propose"].includes(contribution.effect)) throw httpFailure(403, "BEARER_EFFECT_DENIED", "Bearer credentials may only use read, compute, and propose module routes");
        if (hosted && contribution.effect !== "read") await requireWritePermission();
        if (!runtime.invokeHttp) throw httpFailure(503, "MODULE_HTTP_UNAVAILABLE", "The runtime does not support HTTP module contributions");
        if (contribution.effect === "read" && method !== "GET" && method !== "HEAD") throw httpFailure(405, "MODULE_HTTP_METHOD_DENIED", "Read-only module routes must use GET or HEAD");
        const reader = await freshReader(projectId, "remote");
        let domainJobId: string | undefined;
        const host = actionHost(projectId, reader, signal, isBearer || moduleId === "mcp" ? "mcp" : "module", "owner", (id) => { domainJobId = id; }, async () => { await requireWritePermission(); });
        const webRequest = makeWebRequest(request, parsedBody, signal, moduleRoute[2] ?? "");
        const moduleResponse = await runtime.invokeHttp(moduleId, contribution.id, webRequest, host);
        if (domainJobId) response.setHeader("X-Scriptorium-Job-Id", domainJobId);
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
        const author = hosted ? await requireWritePermission() : (await requireWritePermission(), undefined);
        await createScratch(projectId, await readJson(request, parsedBody), hosted ? `hosted:${author!.userId}` : "owner", response); return;
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
      assertAssignedProject(projectId);
      const term = query.get("q") ?? "";
      if (!term.trim() || term.length > 512) throw httpFailure(400, "INVALID_QUERY", "A search query from 1 to 512 characters is required");
      const limit = boundedInt(query.get("limit"), 20, 1, 100);
      sendJson(response, 200, await searchSnapshot(projectId, term, limit, optionalSnapshot(query)));
      return;
    }
    if (routePath === "/api/writing-stats" && method === "GET") {
      const projectId = query.get("projectId");
      if (!projectId) throw httpFailure(400, "PROJECT_REQUIRED", "projectId is required");
      assertAssignedProject(projectId);
      sendJson(response, 200, await writingStatsSnapshot(projectId, optionalSnapshot(query)));
      return;
    }
    if (routePath === "/api/scratch" && method === "POST") {
      const projectId = query.get("projectId");
      if (!projectId) throw httpFailure(400, "PROJECT_REQUIRED", "projectId is required");
      assertAssignedProject(projectId);
      const author = hosted ? await requireWritePermission() : (await requireWritePermission(), undefined);
      await createScratch(projectId, await readJson(request, parsedBody), hosted ? `hosted:${author!.userId}` : "owner", response);
      return;
    }
    if (routePath.startsWith("/api/public/repos/") && routePath.includes("/modules/")) {
      const publicMatch = routePath.match(/^\/api\/public\/repos\/([^/]+)\/modules\/([^/]+)(?:\/(.*))?$/u);
      if (!publicMatch) throw httpFailure(404, "NOT_FOUND", "Public module route not found");
      const repositoryId = parseProjectId(publicMatch[1]!);
      if (!/^\d{1,32}$/u.test(repositoryId)) throw httpFailure(404, "REPOSITORY_NOT_FOUND", "Public repository was not found");
      const moduleId = parseProjectId(publicMatch[2]!);
      const projectList = await listProjects();
      if (hosted && repositoryId !== String(assignment!.repositoryId)) {
        throw httpFailure(404, "REPOSITORY_NOT_FOUND", "Public repository was not found");
      }
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
    const routePath = requestPath(request.raw);
    const method = request.raw.method ?? "GET";
    const isNonActivityRoute = [
      RUNTIME_STATUS_PATH, RUNTIME_QUIESCE_PATH, RUNTIME_RESUME_PATH, RUNTIME_METADATA_PATH,
      "/api/health", "/api/ready", "/api/version",
    ].includes(routePath);
    const trackedApiRequest = routePath.startsWith("/api/") && !isNonActivityRoute;
    const isMcpRequest = trackedApiRequest && typeof request.raw.headers.authorization === "string" && request.raw.headers.authorization.startsWith("Bearer ");
    const isActiveMutation = hosted && trackedApiRequest && !["GET", "HEAD", "OPTIONS"].includes(method);
    if (trackedApiRequest) activeApiRequests += 1;
    if (isMcpRequest) activeMcpRequests += 1;
    if (isActiveMutation) {
      activeMutations += 1;
      recordRuntimeActivity();
    }
    try { await handle(request.raw, reply.raw, request.body); }
    catch (error) { if (!reply.raw.headersSent) sendError(reply.raw, error); else reply.raw.destroy(error instanceof Error ? error : undefined); }
    finally {
      activeRequests = Math.max(0, activeRequests - 1);
      if (trackedApiRequest) activeApiRequests = Math.max(0, activeApiRequests - 1);
      if (isMcpRequest) activeMcpRequests = Math.max(0, activeMcpRequests - 1);
      if (isActiveMutation) {
        activeMutations = Math.max(0, activeMutations - 1);
        recordRuntimeActivity();
      }
    }
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
          const projects = await listProjects();
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
  const { CoreStore } = await import("@scriptorium/core");
  const cacheDirectory = resolve(process.env.SCRIPTORIUM_MODULE_CACHE_DIR ?? "./data/module-cache");
  const dataDirectory = process.env.SCRIPTORIUM_DATA_DIR ?? "./data";
  const hostedModeValue = process.env.SCRIPTORIUM_HOSTED_MODE;
  if (hostedModeValue !== undefined && hostedModeValue !== "0" && hostedModeValue !== "1") {
    throw new Error("SCRIPTORIUM_HOSTED_MODE must be 1 or 0");
  }
  const hostedMode = hostedModeValue === "1";
  if (hostedMode) {
    if (process.env.SCRIPTORIUM_AUTH_TOKEN !== undefined || process.env.SCRIPTORIUM_GITHUB_TOKEN !== undefined) {
      throw new Error("Static Scriptorium access and GitHub tokens are forbidden in hosted mode");
    }
    const assignment = await readRuntimeAssignment(process.env.SCRIPTORIUM_RUNTIME_ASSIGNMENT_PATH ?? HOSTED_ASSIGNMENT_PATH);
    const profile = process.env.SCRIPTORIUM_PROFILE ?? "hosted";
    if (profile !== "hosted") throw new Error("Hosted runtime requires the generated hosted profile");
    const runtimeOptions = await loadProfileRuntimeOptions(profile, cacheDirectory, assignment.enabledModuleIds);
    const manifestIds = new Set<string>(runtimeOptions.manifests.map((manifest) => manifest.id));
    if (assignment.enabledModuleIds.some((id) => !manifestIds.has(id))) {
      throw new Error("Hosted assignment enables modules absent from the immutable composition");
    }
    const authorization = createHostedAuthorizationPolicy({ assignment });
    const gitCredentialProvider = createHostedGitCredentialProvider({ assignment, runtimeIdentityPath: HOSTED_RUNTIME_IDENTITY_PATH });
    const store = new CoreStore({
      dataDir: dataDirectory,
      hostedRepository: {
        repositoryId: assignment.repositoryId,
        repositoryLocator: assignment.repositoryLocator,
        instanceId: assignment.instanceId,
        runtimeEpoch: assignment.runtimeEpoch,
      },
      gitCredentialProvider,
    });
    let projects = await store.listProjects();
    if (projects.length > 1) throw new Error("Hosted data directory contains multiple repository registrations");
    let project = projects[0];
    if (!project) {
      project = await store.registerProject({ url: assignment.repositoryLocator });
      projects = [project];
    }
    if (projects.length !== 1 || !project) throw new Error("Hosted repository registration is unavailable");
    let identity;
    try { identity = await store.registeredRepositoryIdentity(project.id); }
    catch {
      await store.observe(project.id);
      identity = await store.registeredRepositoryIdentity(project.id);
    }
    if (identity.provider !== "github" || identity.repositoryId !== String(assignment.repositoryId)) {
      throw new Error("Hosted Core repository identity does not match the signed assignment");
    }
    const producerRevision = process.env.SCRIPTORIUM_PRODUCER_REVISION;
    if (!producerRevision || !/^[a-f0-9]{40}$/u.test(producerRevision)) {
      throw new Error("SCRIPTORIUM_PRODUCER_REVISION must be an immutable 40-character source revision");
    }
    return startServer({
      store,
      hosted: { assignment, projectId: project.id, authorization, producerRevision },
      trustProxy: process.env.SCRIPTORIUM_TRUST_PROXY === "1",
      runtimeOptions,
      usageDirectory: process.env.SCRIPTORIUM_USAGE_DIR ?? resolve(dataDirectory, "host-history"),
      profile,
    });
  }
  const authToken = process.env.SCRIPTORIUM_AUTH_TOKEN?.trim();
  if (!authToken || authToken.length < 32) throw new Error("SCRIPTORIUM_AUTH_TOKEN is required and must contain at least 32 characters");
  const profile = process.env.SCRIPTORIUM_PROFILE ?? "core";
  const runtimeOptions = await loadProfileRuntimeOptions(profile, cacheDirectory);
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
  assignedEnabledModuleIds?: readonly string[],
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
  const enabled = assignedEnabledModuleIds !== undefined
    ? [...assignedEnabledModuleIds]
    : enabledByEnvironment === undefined
    ? composition.moduleManifests.map((manifest) => manifest.id)
    : enabledByEnvironment.split(",").map((id) => id.trim()).filter(Boolean);
  if (new Set(enabled).size !== enabled.length || enabled.some((id) => !composition!.moduleManifests!.some((manifest) => manifest.id === id))) {
    throw new Error("Requested enabled module set does not match the immutable composition");
  }
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
