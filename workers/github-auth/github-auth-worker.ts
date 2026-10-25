const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_REQUEST_BYTES = 2_048;
const MAX_RESPONSE_BYTES = 8_192;
const MAX_SMART_HTTP_BYTES = 50 * 1024 * 1024;
const DEVICE_FIELDS = ["device_code", "user_code", "verification_uri", "expires_in", "interval", "error", "error_description"] as const;
const TOKEN_FIELDS = ["access_token", "token_type", "error", "error_description", "interval"] as const;

export interface GitHubAuthEnvironment {
  GITHUB_CLIENT_ID?: string;
  HOST_ORIGIN?: string;
}

function response(status: number, body: unknown, origin?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store, private",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Git-Protocol, X-Proprium-Repository-Id");
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function configuredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    const local = origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
    if ((!local && origin.protocol !== "https:") || origin.origin !== value || origin.username || origin.password || origin.pathname !== "/") return null;
    return origin.origin;
  } catch { return null; }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array> {
  if (!stream) throw new Error("empty_body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sanitized(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const entry = value[field];
    if (typeof entry === "string" && entry.length <= 4096) result[field] = entry;
    else if (Number.isSafeInteger(entry) && (entry as number) >= 0) result[field] = entry;
  }
  return result;
}

function boundedStream(stream: ReadableStream<Uint8Array> | null, maximum: number): ReadableStream<Uint8Array> | null {
  if (!stream) return null;
  let size = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maximum) throw new Error("body_too_large");
      controller.enqueue(chunk);
    },
  }));
}

function smartRoute(url: URL): { owner: string; repository: string; endpoint: string; service: string | null } | null {
  const match = /^\/git\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(url.pathname);
  if (!match) return null;
  const [, owner, repository, endpoint] = match;
  if (endpoint === "info/refs") {
    const values = [...url.searchParams.entries()];
    if (values.length !== 1 || values[0]![0] !== "service" || !["git-upload-pack", "git-receive-pack"].includes(values[0]![1])) return null;
    return { owner: owner!, repository: repository!, endpoint: endpoint!, service: values[0]![1]! };
  }
  if (url.search) return null;
  return { owner: owner!, repository: repository!, endpoint: endpoint!, service: null };
}

async function verifySmartRepository(
  owner: string,
  repository: string,
  repositoryId: number,
  permission: "pull" | "push",
  token: string,
  upstreamFetch: typeof fetch,
): Promise<number | null> {
  let metadata: Response;
  try {
    metadata = await upstreamFetch(`https://api.github.com/repos/${owner}/${repository}`, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
    });
  } catch { return 502; }
  if (metadata.status !== 200) return metadata.status === 301 || metadata.status === 302 ? 502 : metadata.status;
  const length = Number(metadata.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return 502;
  let repo: Record<string, unknown> | null;
  try { repo = object(JSON.parse(new TextDecoder().decode(await readBounded(metadata.body, MAX_RESPONSE_BYTES)))); }
  catch { return 502; }
  if (!repo || repo.id !== repositoryId || typeof repo.full_name !== "string"
      || repo.full_name.toLowerCase() !== `${owner}/${repository}`.toLowerCase()) return 404;
  const permissions = object(repo.permissions);
  if (permissions?.[permission] !== true) return 403;
  return null;
}

async function handleSmartHttp(
  request: Request,
  route: NonNullable<ReturnType<typeof smartRoute>>,
  origin: string,
  upstreamFetch: typeof fetch,
): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = /^Bearer ([\x21-\x7e]{1,4096})$/u.exec(authorization)?.[1];
  const rawId = request.headers.get("X-Proprium-Repository-Id") ?? "";
  const repositoryId = /^[1-9][0-9]{0,15}$/u.test(rawId) ? Number(rawId) : 0;
  if (!token || !Number.isSafeInteger(repositoryId)) return response(401, { error: "authentication_required" }, origin);
  const service = route.endpoint === "git-receive-pack" || route.service === "git-receive-pack" ? "git-receive-pack" : "git-upload-pack";
  if (request.method !== (route.endpoint === "info/refs" ? "GET" : "POST")) return response(405, { error: "method_not_allowed" }, origin);
  if (route.endpoint === "info/refs" && route.service !== service) return response(400, { error: "git_service_not_allowed" }, origin);
  if (request.method === "POST") {
    const expected = `application/x-${service}-request`;
    if (request.headers.get("Content-Type")?.toLowerCase() !== expected) return response(415, { error: "git_content_type_not_allowed" }, origin);
    const size = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(size) && size > MAX_SMART_HTTP_BYTES) return response(413, { error: "git_request_too_large" }, origin);
  }
  const metadataStatus = await verifySmartRepository(route.owner, route.repository, repositoryId, service === "git-receive-pack" ? "push" : "pull", token, upstreamFetch);
  if (metadataStatus !== null) return response(metadataStatus, { error: metadataStatus === 404 ? "repository_mismatch" : "repository_permission_denied" }, origin);

  const upstreamUrl = `https://github.com/${route.owner}/${route.repository}.git/${route.endpoint}${request.url.includes("?") ? new URL(request.url).search : ""}`;
  const upstreamHeaders = new Headers({ Authorization: `Basic ${btoa(`x-access-token:${token}`)}` });
  const accept = request.headers.get("Accept");
  const contentType = request.headers.get("Content-Type");
  const gitProtocol = request.headers.get("Git-Protocol");
  if (accept && accept.length <= 256) upstreamHeaders.set("Accept", accept);
  if (contentType) upstreamHeaders.set("Content-Type", contentType);
  if (gitProtocol && /^version=2$/u.test(gitProtocol)) upstreamHeaders.set("Git-Protocol", gitProtocol);
  let upstream: Response;
  try {
    upstream = await upstreamFetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "POST" ? boundedStream(request.body, MAX_SMART_HTTP_BYTES) : undefined,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: request.signal,
      // Workers stream the pack response directly; they never persist or inspect Git object contents.
      duplex: request.method === "POST" ? "half" : undefined,
    } as RequestInit);
  } catch { return response(502, { error: "git_upstream_unavailable" }, origin); }
  if (upstream.status >= 300 && upstream.status < 400) return response(502, { error: "git_redirect_rejected" }, origin);
  const headers = new Headers({
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type, Git-Protocol, X-Proprium-Repository-Id",
    "Access-Control-Max-Age": "600",
  });
  const upstreamType = upstream.headers.get("Content-Type");
  if (upstreamType && /^(?:application\/x-git-[a-z-]+|application\/json)(?:\s*;|$)/iu.test(upstreamType)) headers.set("Content-Type", upstreamType);
  const responseProtocol = upstream.headers.get("Git-Protocol");
  if (responseProtocol && /^version=2$/u.test(responseProtocol)) headers.set("Git-Protocol", responseProtocol);
  let body: ReadableStream<Uint8Array> | null;
  try { body = boundedStream(upstream.body, MAX_SMART_HTTP_BYTES); }
  catch { return response(502, { error: "git_response_invalid" }, origin); }
  return new Response(body, { status: upstream.status, headers });
}

export async function handleGitHubAuthRequest(
  request: Request,
  environment: GitHubAuthEnvironment,
  upstreamFetch: typeof fetch = fetch,
): Promise<Response> {
  const expectedOrigin = configuredOrigin(environment.HOST_ORIGIN);
  if (!expectedOrigin) return response(503, { error: "host_origin_not_configured" });
  const origin = request.headers.get("Origin");
  if (origin !== expectedOrigin) return response(403, { error: "origin_not_allowed" });
  const url = new URL(request.url);
  const gitRoute = smartRoute(url);
  const oauthRoute = !url.search && ["/oauth/device/code", "/oauth/token"].includes(url.pathname);
  const clientId = environment.GITHUB_CLIENT_ID;
  if (!gitRoute && !oauthRoute) {
    return response(404, { error: "route_not_found" }, expectedOrigin);
  }
  if (oauthRoute && (!clientId || !/^[A-Za-z0-9_-]{10,128}$/u.test(clientId))) {
    return response(503, { error: "oauth_relay_not_configured" }, expectedOrigin);
  }
  if (request.method === "OPTIONS") {
    const requestedMethod = request.headers.get("Access-Control-Request-Method");
    const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const allowedMethod = gitRoute ? gitRoute.endpoint === "info/refs" ? "GET" : "POST" : "POST";
    const allowedHeaders = gitRoute
      ? ["accept", "authorization", "content-type", "git-protocol", "x-proprium-repository-id"]
      : ["content-type"];
    if (requestedMethod !== allowedMethod || requestedHeaders.some((header) => !allowedHeaders.includes(header))) {
      return response(403, { error: "preflight_not_allowed" }, expectedOrigin);
    }
    return response(204, null, expectedOrigin);
  }
  if (gitRoute) return handleSmartHttp(request, gitRoute, expectedOrigin, upstreamFetch);
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" }, expectedOrigin);
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return response(413, { error: "request_too_large" }, expectedOrigin);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return response(415, { error: "json_required" }, expectedOrigin);
  }

  let input: Record<string, unknown> | null;
  try { input = object(JSON.parse(new TextDecoder().decode(await readBounded(request.body, MAX_REQUEST_BYTES)))); }
  catch { return response(400, { error: "invalid_request" }, expectedOrigin); }
  let target: string;
  const form = new URLSearchParams({ client_id: clientId! });
  let fields: readonly string[];
  if (url.pathname === "/oauth/device/code") {
    if (!input || Object.keys(input).length) return response(400, { error: "invalid_request" }, expectedOrigin);
    target = DEVICE_CODE_URL;
    form.set("scope", "repo");
    fields = DEVICE_FIELDS;
  } else {
    if (!input || Object.keys(input).length !== 1 || typeof input.deviceCode !== "string"
        || !/^[A-Za-z0-9_-]{1,256}$/u.test(input.deviceCode)) {
      return response(400, { error: "invalid_request" }, expectedOrigin);
    }
    target = TOKEN_URL;
    form.set("device_code", input.deviceCode);
    form.set("grant_type", DEVICE_GRANT);
    fields = TOKEN_FIELDS;
  }

  let upstream: Response;
  try {
    upstream = await upstreamFetch(target, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
    });
  } catch { return response(502, { error: "oauth_upstream_unavailable" }, expectedOrigin); }
  if (upstream.status >= 300 && upstream.status < 400) return response(502, { error: "oauth_redirect_rejected" }, expectedOrigin);
  const responseLength = Number(upstream.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(responseLength) && responseLength > MAX_RESPONSE_BYTES) return response(502, { error: "oauth_response_invalid" }, expectedOrigin);
  let payload: Record<string, unknown> | null;
  try { payload = object(JSON.parse(new TextDecoder().decode(await readBounded(upstream.body, MAX_RESPONSE_BYTES)))); }
  catch { return response(502, { error: "oauth_response_invalid" }, expectedOrigin); }
  if (!payload) return response(502, { error: "oauth_response_invalid" }, expectedOrigin);
  const output = sanitized(payload, fields);
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_RESPONSE_BYTES) {
    return response(502, { error: "oauth_response_invalid" }, expectedOrigin);
  }
  return response(upstream.status, output, expectedOrigin);
}

export default {
  fetch(request: Request, environment: GitHubAuthEnvironment): Promise<Response> {
    return handleGitHubAuthRequest(request, environment);
  },
};
