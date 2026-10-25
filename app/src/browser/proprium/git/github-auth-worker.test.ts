import assert from "node:assert/strict";
import test from "node:test";

type WorkerEnvironment = { GITHUB_CLIENT_ID?: string; HOST_ORIGIN?: string };
type WorkerHandler = (request: Request, environment: WorkerEnvironment, upstreamFetch?: typeof fetch) => Promise<Response>;
const workerModuleUrl = new URL("../../../../../workers/github-auth/github-auth-worker.ts", import.meta.url).href;
const { handleGitHubAuthRequest } = await import(workerModuleUrl) as { handleGitHubAuthRequest: WorkerHandler };

const origin = "http://127.0.0.1:4273";
const environment = { GITHUB_CLIENT_ID: "Iv23liExampleClientId", HOST_ORIGIN: origin };
const url = "https://relay.example.test";

function post(path: string, body: unknown, requestOrigin = origin): Request {
  return new Request(`${url}${path}`, {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test("relay accepts the exact Host origin and fixes device-flow upstream parameters", async () => {
  let upstreamUrl = "";
  let upstreamInit: RequestInit | undefined;
  const result = await handleGitHubAuthRequest(post("/oauth/device/code", {}), environment, async (input, init) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return Response.json({
      device_code: "opaque-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device",
      expires_in: 900, interval: 5, ignored: "discarded",
    });
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(result.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(result.headers.get("Cache-Control"), "no-store, private");
  assert.equal(upstreamUrl, "https://github.com/login/device/code");
  assert.equal(upstreamInit?.redirect, "manual");
  assert.equal(upstreamInit?.cache, "no-store");
  const form = new URLSearchParams(String(upstreamInit?.body));
  assert.equal(form.get("client_id"), environment.GITHUB_CLIENT_ID);
  assert.equal(form.get("scope"), "repo");
  assert.deepEqual(await json(result), {
    device_code: "opaque-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device",
    expires_in: 900, interval: 5,
  });
});

test("relay only forwards a bounded device code and strips unrelated token response fields", async () => {
  let upstreamUrl = "";
  let upstreamInit: RequestInit | undefined;
  const result = await handleGitHubAuthRequest(post("/oauth/token", { deviceCode: "device-code-opaque" }), environment, async (input, init) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return Response.json({ access_token: "gho_one_time_token", token_type: "bearer", scope: "repo", refresh_token: "never-forward" });
  });
  assert.equal(upstreamUrl, "https://github.com/login/oauth/access_token");
  const form = new URLSearchParams(String(upstreamInit?.body));
  assert.equal(form.get("client_id"), environment.GITHUB_CLIENT_ID);
  assert.equal(form.get("device_code"), "device-code-opaque");
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  const payload = await json(result);
  assert.deepEqual(payload, { access_token: "gho_one_time_token", token_type: "bearer" });
  assert.equal(JSON.stringify(payload).includes("never-forward"), false);
});

test("relay rejects foreign and opaque origins, unknown routes, and client-controlled OAuth fields", async () => {
  let upstreamCalls = 0;
  const upstream = async (): Promise<Response> => { upstreamCalls += 1; return Response.json({}); };
  const foreign = await handleGitHubAuthRequest(post("/oauth/device/code", {}, "https://attacker.example"), environment, upstream);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), null);
  const opaque = await handleGitHubAuthRequest(post("/oauth/device/code", {}, "null"), environment, upstream);
  assert.equal(opaque.status, 403);
  const unknown = await handleGitHubAuthRequest(new Request(`${url}/proxy?target=https://attacker.example`, {
    method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  }), environment, upstream);
  assert.equal(unknown.status, 404);
  const injected = await handleGitHubAuthRequest(post("/oauth/token", { deviceCode: "valid", client_id: "other", grant_type: "other" }), environment, upstream);
  assert.equal(injected.status, 400);
  assert.equal(upstreamCalls, 0);
});

test("relay bounds request and response bodies and rejects redirects", async () => {
  const largeRequest = new Request(`${url}/oauth/device/code`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "9000" }, body: "{}",
  });
  assert.equal((await handleGitHubAuthRequest(largeRequest, environment)).status, 413);
  const largeResponse = await handleGitHubAuthRequest(post("/oauth/device/code", {}), environment, async () => new Response("x".repeat(9_000)));
  assert.equal(largeResponse.status, 502);
  const redirect = await handleGitHubAuthRequest(post("/oauth/token", { deviceCode: "valid" }), environment, async () => new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }));
  assert.equal(redirect.status, 502);
  const unconfigured = await handleGitHubAuthRequest(post("/oauth/device/code", {}), { HOST_ORIGIN: origin });
  assert.equal(unconfigured.status, 503);
});

test("Smart HTTP relay streams only the verified repository upload-pack request", async () => {
  const body = new TextEncoder().encode("bounded-git-request");
  const request = new Request(`${url}/git/proprium-test/fixture.git/git-upload-pack`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer gho_fixture_token",
      "X-Proprium-Repository-Id": "923456789",
      Accept: "application/x-git-upload-pack-result",
      "Content-Type": "application/x-git-upload-pack-request",
      "Git-Protocol": "version=2",
    },
    body,
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await handleGitHubAuthRequest(request, { HOST_ORIGIN: origin }, async (input, init) => {
    const target = String(input);
    calls.push({ url: target, init });
    if (target.startsWith("https://api.github.com/")) return Response.json({
      id: 923456789, full_name: "proprium-test/fixture", permissions: { pull: true, push: true },
    });
    assert.equal(target, "https://github.com/proprium-test/fixture.git/git-upload-pack");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Git-Protocol"), "version=2");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${btoa("x-access-token:gho_fixture_token")}`);
    const forwarded = new Uint8Array(await new Response(init?.body).arrayBuffer());
    assert.deepEqual(forwarded, body);
    return new Response(new TextEncoder().encode("bounded-git-response"), {
      headers: { "Content-Type": "application/x-git-upload-pack-result", "Set-Cookie": "must-not-forward" },
    });
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new TextEncoder().encode("bounded-git-response"));
  assert.equal(result.headers.get("Content-Type"), "application/x-git-upload-pack-result");
  assert.equal(result.headers.get("Set-Cookie"), null);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(result.headers.get("Cache-Control"), "no-store, private");
});

test("Smart HTTP relay checks repository identity and operation permissions before receive-pack", async () => {
  let gitRequests = 0;
  const readOnly = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).startsWith("https://api.github.com/")) return Response.json({
      id: 923456789, full_name: "proprium-test/fixture", permissions: { pull: true, push: false },
    });
    gitRequests += 1;
    return Response.json({});
  };
  const request = new Request(`${url}/git/proprium-test/fixture.git/git-receive-pack`, {
    method: "POST",
    headers: {
      Origin: origin, Authorization: "Bearer gho_fixture_token", "X-Proprium-Repository-Id": "923456789",
      "Content-Type": "application/x-git-receive-pack-request",
    },
    body: "pack",
  });
  const denied = await handleGitHubAuthRequest(request, environment, readOnly);
  assert.equal(denied.status, 403);
  assert.equal(gitRequests, 0);

  const mismatched = new Request(`${url}/git/proprium-test/fixture.git/info/refs?service=git-upload-pack`, {
    method: "GET",
    headers: { Origin: origin, Authorization: "Bearer gho_fixture_token", "X-Proprium-Repository-Id": "123" },
  });
  const mismatchResponse = await handleGitHubAuthRequest(mismatched, environment, async (input) => {
    if (String(input).startsWith("https://api.github.com/")) return Response.json({
      id: 923456789, full_name: "proprium-test/fixture", permissions: { pull: true, push: true },
    });
    gitRequests += 1;
    return Response.json({});
  });
  assert.equal(mismatchResponse.status, 404);
  assert.equal(gitRequests, 0);
});

test("Smart HTTP relay allows only named Git routes and bounded Git CORS preflight", async () => {
  const upstreamCalls: string[] = [];
  const noNetwork = async (input: RequestInfo | URL): Promise<Response> => {
    upstreamCalls.push(String(input));
    return Response.json({ id: 123, full_name: "attacker/fixture", permissions: { pull: true, push: true } });
  };
  const preflight = await handleGitHubAuthRequest(new Request(`${url}/git/proprium-test/fixture.git/info/refs?service=git-upload-pack`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization, git-protocol, x-proprium-repository-id",
    },
  }), environment, noNetwork);
  assert.equal(preflight.status, 204);
  const arbitrary = await handleGitHubAuthRequest(new Request(`${url}/git/proprium-test/fixture.git/objects/info/packs`, {
    method: "GET", headers: { Origin: origin },
  }), environment, noNetwork);
  assert.equal(arbitrary.status, 404);
  const foreign = await handleGitHubAuthRequest(new Request(`${url}/git/attacker/fixture.git/info/refs?service=git-upload-pack`, {
    method: "GET", headers: { Origin: origin, Authorization: "Bearer gho_fixture_token", "X-Proprium-Repository-Id": "923456789" },
  }), environment, noNetwork);
  assert.equal(foreign.status, 404);
  assert.equal(upstreamCalls.length, 1);
  assert.deepEqual(upstreamCalls, ["https://api.github.com/repos/attacker/fixture"]);
});
