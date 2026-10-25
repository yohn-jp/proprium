import type { Page } from "@playwright/test";

export interface OAuthFixtureOptions {
  relayUrl: string;
  hostOrigin: string;
  accessToken: string;
  deviceCode?: string;
  userCode?: string;
}

const corsMethods = "GET, POST, OPTIONS";
const corsHeaders = "Accept, Authorization, Content-Type, Git-Protocol, X-Proprium-Repository-Id";

function cors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": corsMethods,
    "Access-Control-Allow-Headers": corsHeaders,
    "Access-Control-Expose-Headers": "Git-Protocol",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store, private",
    Vary: "Origin",
  };
}

/**
 * Answers only the OAuth Device Flow calls used by browser acceptance tests.
 * This is a route fixture, not a relay implementation: no upstream requests,
 * Git handling, repository checks, or production security behavior are emulated.
 */
export async function installMockGitHubOAuth(page: Page, options: OAuthFixtureOptions): Promise<void> {
  const origin = new URL(options.relayUrl).origin;
  const hostOrigin = new URL(options.hostOrigin).origin;
  await page.context().route(`${origin}/oauth/**`, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = cors(hostOrigin);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() !== "POST") return route.fulfill({ status: 405, headers });
    if (path === "/oauth/device/code") return route.fulfill({ status: 200, headers, json: {
      device_code: options.deviceCode ?? "a".repeat(40),
      user_code: options.userCode ?? "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 1,
    } });
    if (path === "/oauth/token") return route.fulfill({ status: 200, headers, json: {
      access_token: options.accessToken,
      token_type: "bearer",
    } });
    return route.fulfill({ status: 404, headers, json: { error: "fixture_route_not_found" } });
  });
}

export interface SyntheticSmartHttpOptions {
  relayUrl: string;
  hostOrigin: string;
  owner: string;
  repository: string;
  repositoryId: number;
  accessToken: string;
  backendUrl: () => string | null;
  onBasicAuthorization?: (authorization: string) => void;
  onRequest?: (method: string, pathname: string) => void;
}

/**
 * Routes one synthetic repository's Git Smart HTTP requests to a local test
 * `git http-backend`. It deliberately does not model the production relay's
 * authorization, permission, CORS policy, or resource-limit enforcement.
 */
export async function installSyntheticSmartHttpRelay(page: Page, options: SyntheticSmartHttpOptions): Promise<void> {
  const origin = new URL(options.relayUrl).origin;
  const hostOrigin = new URL(options.hostOrigin).origin;
  const repositoryPath = `/git/${options.owner}/${options.repository}.git`;
  const expectedRepositoryId = String(options.repositoryId);
  const basicAuthorization = `Basic ${Buffer.from(`x-access-token:${options.accessToken}`).toString("base64")}`;

  await page.context().route(`${origin}/git/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = cors(hostOrigin);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });

    const endpoint = url.pathname.slice(repositoryPath.length + 1);
    const advertisement = endpoint === "info/refs" && request.method() === "GET" &&
      [...url.searchParams.keys()].length === 1 &&
      ["git-upload-pack", "git-receive-pack"].includes(url.searchParams.get("service") ?? "");
    const pack = !url.search && request.method() === "POST" &&
      ["git-upload-pack", "git-receive-pack"].includes(endpoint);
    const backendUrl = options.backendUrl();
    if (url.pathname !== `${repositoryPath}/${endpoint}` || (!advertisement && !pack) || !backendUrl) {
      return route.fulfill({ status: 404, headers, json: { error: "fixture_route_not_found" } });
    }

    const sourceHeaders = request.headers();
    if (sourceHeaders.authorization !== `Bearer ${options.accessToken}` ||
        sourceHeaders["x-proprium-repository-id"] !== expectedRepositoryId) {
      return route.fulfill({ status: 401, headers, json: { error: "fixture_authentication_required" } });
    }
    const contentType = sourceHeaders["content-type"];
    const service = endpoint === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack"
      ? "git-receive-pack" : "git-upload-pack";
    if (pack && contentType?.toLowerCase() !== `application/x-${service}-request`) {
      return route.fulfill({ status: 415, headers, json: { error: "fixture_git_content_type_required" } });
    }

    options.onBasicAuthorization?.(basicAuthorization);
    options.onRequest?.(request.method(), url.pathname);
    const upstreamHeaders = new Headers({ Authorization: basicAuthorization });
    for (const name of ["accept", "content-type", "git-protocol"]) {
      const value = sourceHeaders[name];
      if (value) upstreamHeaders.set(name, value);
    }
    const upstreamUrl = new URL(`${url.pathname.slice(4)}${url.search}`, backendUrl);
    const body = request.postDataBuffer();
    const upstream = await fetch(upstreamUrl, {
      method: request.method(),
      headers: upstreamHeaders,
      ...(body?.byteLength ? { body: new Uint8Array(body) } : {}),
      redirect: "manual",
    });
    const responseHeaders = cors(hostOrigin);
    const type = upstream.headers.get("Content-Type");
    const protocol = upstream.headers.get("Git-Protocol");
    if (type) responseHeaders["Content-Type"] = type;
    if (protocol) responseHeaders["Git-Protocol"] = protocol;
    await route.fulfill({ status: upstream.status, headers: responseHeaders, body: Buffer.from(await upstream.arrayBuffer()) });
  });
}
