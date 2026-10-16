import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreStore } from "@scriptorium/core";

const SESSION_COOKIE = "scriptorium_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

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

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw httpFailure(415, "JSON_REQUIRED", "Send a JSON request body");
  }
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

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  staticDir: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = requestPath(request);
  const files: Record<string, { filename: string; contentType: string }> = {
    "/": { filename: "index.html", contentType: "text/html; charset=utf-8" },
    "/main.js": { filename: "main.js", contentType: "text/javascript; charset=utf-8" },
    "/api.js": { filename: "api.js", contentType: "text/javascript; charset=utf-8" },
    "/drafts.js": { filename: "drafts.js", contentType: "text/javascript; charset=utf-8" },
    "/styles.css": { filename: "styles.css", contentType: "text/css; charset=utf-8" },
  };
  const file = files[path];
  if (!file) return false;
  try {
    const content = await readFile(resolve(staticDir, file.filename));
    response.writeHead(200, { "Content-Type": file.contentType, "Content-Length": content.length });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    sendJson(response, 503, { error: "Writing application is not built", code: "APP_NOT_BUILT" });
  }
  return true;
}

export function createServer(options: ApiServerOptions): Server {
  if (options.authToken.length < 32 || options.authToken.trim() !== options.authToken) {
    throw new Error("SCRIPTORIUM_AUTH_TOKEN must contain at least 32 characters");
  }
  const staticDir = options.staticDir ?? resolve(process.cwd(), "app/dist");
  const trustProxy = options.trustProxy ?? false;
  const sessions = new Map<string, Session>();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    setSecurityHeaders(response);
    const path = requestPath(request);

    if (path === "/api/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Allow": "GET, HEAD, POST, PUT, OPTIONS" });
      response.end();
      return;
    }

    if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method ?? "")) {
      if (!sameOrigin(request, trustProxy)) {
        sendJson(response, 403, { error: "Request origin must match this application", code: "CROSS_ORIGIN_REQUEST" });
        return;
      }
    }

    if (path === "/api/login" && request.method === "POST") {
      const body = await readJson(request);
      const token = isRecord(body) && typeof body.token === "string" ? body.token : "";
      if (!constantTimeEqual(token, options.authToken)) {
        sendJson(response, 401, { error: "Invalid access token", code: "UNAUTHORIZED" });
        return;
      }
      for (const [id, session] of sessions) {
        if (session.expiresAt <= Date.now()) sessions.delete(id);
      }
      const sessionId = randomBytes(32).toString("base64url");
      sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL_MS });
      response.setHeader("Set-Cookie", cookieHeader(request, sessionId, trustProxy));
      sendJson(response, 200, { authenticated: true });
      return;
    }

    if (path.startsWith("/api/")) {
      const sessionId = cookieValue(request, SESSION_COOKIE);
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session || session.expiresAt <= Date.now()) {
        if (sessionId) sessions.delete(sessionId);
        response.setHeader("WWW-Authenticate", 'Cookie realm="scriptorium"');
        sendJson(response, 401, { error: "Authentication required", code: "UNAUTHORIZED" });
        return;
      }
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      if (path === "/api/session" && request.method === "GET") {
        sendJson(response, 200, { authenticated: true });
        return;
      }
      if (path === "/api/logout" && request.method === "POST") {
        if (sessionId) sessions.delete(sessionId);
        response.setHeader("Set-Cookie", clearCookie(request, trustProxy));
        sendJson(response, 200, { authenticated: false });
        return;
      }
      if (path === "/api/projects" && request.method === "GET") {
        sendJson(response, 200, await options.store.listProjects());
        return;
      }
      if (path === "/api/projects" && request.method === "POST") {
        const body = await readJson(request);
        if (!isRecord(body) || typeof body.url !== "string" || !body.url.trim()) {
          throw httpFailure(400, "INVALID_PROJECT", "Repository URL is required");
        }
        if (body.branch !== undefined && typeof body.branch !== "string") {
          throw httpFailure(400, "INVALID_PROJECT", "Branch must be a string");
        }
        const project = await options.store.registerProject({
          url: body.url.trim(),
          ...(typeof body.branch === "string" && body.branch.trim() ? { branch: body.branch.trim() } : {}),
        });
        sendJson(response, 201, project);
        return;
      }

      const treeMatch = path.match(/^\/api\/projects\/([^/]+)\/tree$/);
      if (treeMatch && request.method === "GET") {
        sendJson(response, 200, await options.store.tree(parseProjectId(treeMatch[1]!)));
        return;
      }
      const sceneMatch = path.match(/^\/api\/projects\/([^/]+)\/scenes\/([^/]+)$/);
      if (sceneMatch && request.method === "GET") {
        sendJson(response, 200, await options.store.readScene(parseProjectId(sceneMatch[1]!), parseSceneId(sceneMatch[2]!)));
        return;
      }
      if (sceneMatch && request.method === "PUT") {
        const body = await readJson(request);
        if (!isRecord(body) || typeof body.text !== "string" || typeof body.revision !== "string" || !body.revision) {
          throw httpFailure(400, "INVALID_SCENE", "Scene text and its revision are required");
        }
        const scene = await options.store.saveScene(parseProjectId(sceneMatch[1]!), parseSceneId(sceneMatch[2]!), {
          text: body.text,
          revision: body.revision,
        });
        sendJson(response, 200, scene);
        return;
      }
      const historyMatch = path.match(/^\/api\/projects\/([^/]+)\/history$/);
      if (historyMatch && request.method === "GET") {
        sendJson(response, 200, await options.store.history(parseProjectId(historyMatch[1]!)));
        return;
      }
      const statusMatch = path.match(/^\/api\/projects\/([^/]+)\/status$/);
      if (statusMatch && request.method === "GET") {
        sendJson(response, 200, await options.store.status(parseProjectId(statusMatch[1]!)));
        return;
      }
      const syncMatch = path.match(/^\/api\/projects\/([^/]+)\/sync$/);
      if (syncMatch && request.method === "POST") {
        sendJson(response, 200, await options.store.sync(parseProjectId(syncMatch[1]!)));
        return;
      }
      if (path.startsWith("/api/")) {
        sendJson(response, 404, { error: "API route not found", code: "NOT_FOUND" });
        return;
      }
    }

    if (path.startsWith("/api/")) {
      sendJson(response, 404, { error: "API route not found", code: "NOT_FOUND" });
      return;
    }
    if (await serveStatic(request, response, staticDir)) return;
    sendJson(response, 404, { error: "Page not found", code: "NOT_FOUND" });
  };

  return createHttpServer((request, response) => {
    void handle(request, response).catch((error: unknown) => sendError(response, error));
  });
}

function parsePositivePort(value: string | undefined): number {
  if (!value) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return port;
}

export async function start(): Promise<Server> {
  const authToken = process.env.SCRIPTORIUM_AUTH_TOKEN?.trim();
  if (!authToken || authToken.length < 32) {
    throw new Error("SCRIPTORIUM_AUTH_TOKEN is required and must contain at least 32 characters");
  }
  const { CoreStore } = await import("@scriptorium/core");
  const store = new CoreStore({
    dataDir: process.env.SCRIPTORIUM_DATA_DIR ?? "./data",
    ...(process.env.SCRIPTORIUM_GITHUB_TOKEN ? { githubToken: process.env.SCRIPTORIUM_GITHUB_TOKEN } : {}),
  });
  const server = createServer({
    store,
    authToken,
    trustProxy: process.env.SCRIPTORIUM_TRUST_PROXY === "1",
  });
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
