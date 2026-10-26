import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubAccountSession, createGitHubSyncClient, GitHubSyncError } from "./github-sync.js";
import type { GitHubRemoteKind, GitHubRemoteOperation } from "./github-sync.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const pendingDevice = {
  device_code: "device-code-opaque",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 1,
};

test("device authorization validates the user and holds the access token only in the session", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let polls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/oauth/device/code")) return response(pendingDevice);
    if (url.endsWith("/oauth/token")) {
      polls += 1;
      return response(polls === 1 ? { error: "authorization_pending" } : { access_token: "gho_fixture_secret", token_type: "bearer" });
    }
    if (url.endsWith("/user")) return response({ id: 44, login: "writer" });
    throw new Error("unexpected request");
  };
  let suppliedToken = "";
  const operation: GitHubRemoteOperation = async <T>(_kind: "remote-head" | "remote-fetch" | "remote-pull" | "remote-publish", token: string) => {
    suppliedToken = token;
    return { repositoryId: 12345, branch: "main", head: null } as T;
  };
  const client = createGitHubSyncClient("https://oauth.example.test", operation, fetcher);
  const prompt = await client.beginAuthorization();
  assert.deepEqual(prompt, {
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    expiresAt: prompt.expiresAt,
  });
  assert.deepEqual(await client.completeAuthorization(), { id: 44, login: "writer" });
  assert.deepEqual(client.account(), { id: 44, login: "writer" });
  await client.remoteHead();
  const gatewayCalls = calls.filter(call => call.url.startsWith("https://oauth.example.test/"));
  const directGitHubCalls = calls.filter(call => call.url.startsWith("https://api.github.com/"));
  assert.ok(gatewayCalls.length > 0 && gatewayCalls.every(call => call.init?.credentials === "include"));
  assert.ok(directGitHubCalls.length > 0 && directGitHubCalls.every(call => call.init?.credentials === "omit"));
  assert.equal(suppliedToken, "gho_fixture_secret");
  assert.equal(JSON.stringify(prompt).includes("gho_fixture_secret"), false);
  assert.equal(calls.at(-1)?.init?.credentials, "omit");
  assert.equal(calls.at(-1)?.init?.redirect, "error");
  client.signOut();
  assert.equal(client.account(), null);
  await assert.rejects(client.remoteHead(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");
});

test("device flow rejects untrusted URLs, clears revoked tokens, and maps offline transport errors", async () => {
  const invalid = createGitHubSyncClient("https://oauth.example.test", async () => null as never, async () => response({ ...pendingDevice, verification_uri: "https://attacker.example/" }));
  await assert.rejects(invalid.beginAuthorization(), (error: unknown) => error instanceof GitHubSyncError && error.code === "git_error");
  assert.throws(() => createGitHubSyncClient("https://oauth.example.test/path", async () => null as never), TypeError);

  const tokenClient = createGitHubSyncClient("https://oauth.example.test", async () => {
    throw new GitHubSyncError("authentication_expired", "revoked");
  }, async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/device/code")) return response(pendingDevice);
    if (url.endsWith("/oauth/token")) return response({ access_token: "gho_revoked", token_type: "bearer" });
    return response({ id: 44, login: "writer" });
  });
  await tokenClient.beginAuthorization();
  await tokenClient.completeAuthorization();
  await assert.rejects(tokenClient.remoteHead(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_expired");
  assert.equal(tokenClient.account(), null);
  await assert.rejects(tokenClient.remoteHead(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");

  const offline = createGitHubSyncClient("https://oauth.example.test", async () => null as never, async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(offline.beginAuthorization(), (error: unknown) => error instanceof GitHubSyncError && error.code === "network_unavailable");
});

test("authentication network errors identify the failed destination without exposing transport details", async () => {
  const relay = createGitHubAccountSession("https://oauth.example.test", async () => { throw new TypeError("private transport detail"); });
  await assert.rejects(relay.beginAuthorization(), (error: unknown) => {
    assert.ok(error instanceof GitHubSyncError);
    assert.equal(error.code, "network_unavailable");
    assert.match(error.message, /configured Gateway/u);
    assert.doesNotMatch(error.message, /private transport detail/u);
    return true;
  });
  const github = createGitHubAccountSession("https://oauth.example.test", async input => {
    if (String(input).endsWith("/oauth/device/code")) return response(pendingDevice);
    if (String(input).endsWith("/oauth/token")) return response({ access_token: "private-fixture-token", token_type: "bearer" });
    throw new TypeError("private transport detail");
  });
  await github.beginAuthorization();
  await assert.rejects(github.completeAuthorization(), (error: unknown) => {
    assert.ok(error instanceof GitHubSyncError);
    assert.equal(error.code, "network_unavailable");
    assert.match(error.message, /reach GitHub/u);
    assert.doesNotMatch(error.message, /private-fixture-token|private transport detail/u);
    return true;
  });
});

test("authorization polling can be cancelled and clears the pending device code", async () => {
  const client = createGitHubSyncClient("https://oauth.example.test", async () => null as never, async (input) => {
    if (String(input).endsWith("/oauth/device/code")) return response({ ...pendingDevice, interval: 60 });
    return response({ access_token: "must-not-be-used", token_type: "bearer" });
  });
  await client.beginAuthorization();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.completeAuthorization(controller.signal), { name: "AbortError" });
  await assert.rejects(client.completeAuthorization(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");
});


test("account sessions list repositories and bind a workspace sync client without repeating authorization", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/oauth/device/code")) return response(pendingDevice);
    if (url.endsWith("/oauth/token")) return response({ access_token: "gho_repository_picker", token_type: "bearer" });
    if (url.endsWith("/user")) return response({ id: 44, login: "writer" });
    if (url.includes("/user/repos?")) return response([{
      id: 12345,
      full_name: "writer/notes",
      name: "notes",
      owner: { login: "writer" },
      default_branch: "main",
      private: true,
      permissions: { pull: true, push: true },
    }]);
    throw new Error("unexpected request");
  };
  const session = createGitHubAccountSession("https://oauth.example.test", fetcher);
  await session.beginAuthorization();
  await session.completeAuthorization();
  assert.deepEqual(await session.repositories(), [{
    id: 12345,
    fullName: "writer/notes",
    owner: "writer",
    name: "notes",
    defaultBranch: "main",
    private: true,
    permissions: { pull: true, push: true },
  }]);
  let suppliedToken = "";
  const operation: GitHubRemoteOperation = async <T>(_kind: GitHubRemoteKind, token: string, relay: string) => {
    suppliedToken = token;
    assert.equal(relay, "https://oauth.example.test");
    return { repositoryId: 12345, branch: "main", head: null } as T;
  };
  const sync = session.connect(operation);
  await sync.remoteHead();
  assert.equal(suppliedToken, "gho_repository_picker");
  assert.equal(calls.at(-1)?.init?.credentials, "omit");
  assert.equal(calls.at(-1)?.init?.redirect, "error");
  assert.equal(new Headers(calls.find(call => call.url.includes("/user/repos?"))?.init?.headers).get("Authorization"), "Bearer gho_repository_picker");
  session.signOut();
  assert.equal(sync.account(), null);
  await assert.rejects(sync.remoteHead(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");
});

test("repository picker rejects malformed metadata and clears an expired session", async () => {
  let expired = false;
  const session = createGitHubAccountSession("https://oauth.example.test", async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/device/code")) return response(pendingDevice);
    if (url.endsWith("/oauth/token")) return response({ access_token: "gho_repository_picker", token_type: "bearer" });
    if (url.endsWith("/user")) return response({ id: 44, login: "writer" });
    if (url.includes("/user/repos?")) return expired
      ? response({ message: "Bad credentials" }, 401)
      : response([{ id: 1, full_name: "writer/repo", name: "repo", owner: { login: "writer" }, default_branch: "../bad", private: false }]);
    throw new Error("unexpected request");
  });
  await session.beginAuthorization();
  await session.completeAuthorization();
  await assert.rejects(session.repositories(), (error: unknown) => error instanceof GitHubSyncError && error.code === "git_error");
  expired = true;
  await assert.rejects(session.repositories(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_expired");
  assert.equal(session.account(), null);
});

test("sign-out prevents a pending device flow from restoring its token", async () => {
  let releaseProfile: ((value: Response) => void) | undefined;
  let profileRequested: (() => void) | undefined;
  const profileStarted = new Promise<void>(resolve => { profileRequested = resolve; });
  const session = createGitHubAccountSession("https://oauth.example.test", async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/device/code")) return response(pendingDevice);
    if (url.endsWith("/oauth/token")) return response({ access_token: "gho_canceled", token_type: "bearer" });
    if (url.endsWith("/user")) {
      profileRequested?.();
      return new Promise<Response>(resolve => { releaseProfile = resolve; });
    }
    throw new Error("unexpected request");
  });
  await session.beginAuthorization();
  const completion = session.completeAuthorization();
  await profileStarted;
  session.signOut();
  releaseProfile?.(response({ id: 44, login: "writer" }));
  await assert.rejects(completion, (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");
  assert.equal(session.account(), null);
  await assert.rejects(session.repositories(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");
});

test("account sessions list paginated branches only after confirming the immutable repository identity", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let repositoryChecks = 0;
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ name: `feature-${String(index).padStart(3, "0")}` }));
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/oauth/device/code")) return response(pendingDevice);
    if (url.endsWith("/oauth/token")) return response({ access_token: "gho_branch_picker", token_type: "bearer" });
    if (url.endsWith("/user")) return response({ id: 44, login: "writer" });
    if (url === "https://api.github.com/repos/writer/notes") {
      repositoryChecks += 1;
      return response({ id: 12345, full_name: "writer/notes", name: "notes", owner: { login: "writer" }, permissions: { pull: true } });
    }
    if (url.endsWith("/branches?per_page=100&page=1")) return response(firstPage);
    if (url.endsWith("/branches?per_page=100&page=2")) return response([{ name: "main" }]);
    throw new Error(`unexpected request: ${url}`);
  };
  const session = createGitHubAccountSession("https://oauth.example.test", fetcher);
  await session.beginAuthorization();
  await session.completeAuthorization();
  const selected = {
    id: 12345,
    fullName: "writer/notes",
    owner: "writer",
    name: "notes",
    defaultBranch: "main",
    private: true,
    permissions: { pull: true, push: true },
  };
  const branches = await session.listBranches(selected);
  assert.equal(branches.length, 101);
  assert.deepEqual(branches.slice(-2), ["feature-099", "main"]);
  assert.equal(repositoryChecks, 2, "the immutable repository identity is checked before and after branch pagination");
  const branchCalls = calls.filter(call => call.url.includes("/branches?"));
  assert.equal(branchCalls.length, 2);
  assert.ok(branchCalls.every(call => call.init?.credentials === "omit" && call.init?.redirect === "error"));
  assert.ok(branchCalls.every(call => new Headers(call.init?.headers).get("Authorization") === "Bearer gho_branch_picker"));
  session.signOut();
  await assert.rejects(session.listBranches(selected), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");
});

test("branch listing rejects stale repository IDs, lost read permission, and malformed names", async () => {
  let repositoryId = 999;
  let canPull = true;
  let malformed = false;
  const session = createGitHubAccountSession("https://oauth.example.test", async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/device/code")) return response(pendingDevice);
    if (url.endsWith("/oauth/token")) return response({ access_token: "gho_branch_picker", token_type: "bearer" });
    if (url.endsWith("/user")) return response({ id: 44, login: "writer" });
    if (url === "https://api.github.com/repos/writer/notes") return response({
      id: repositoryId,
      full_name: "writer/notes",
      name: "notes",
      owner: { login: "writer" },
      permissions: { pull: canPull },
    });
    if (url.includes("/branches?")) return response([{ name: malformed ? "../other" : "main" }]);
    throw new Error(`unexpected request: ${url}`);
  });
  await session.beginAuthorization();
  await session.completeAuthorization();
  const selected = {
    id: 12345,
    fullName: "writer/notes",
    owner: "writer",
    name: "notes",
    defaultBranch: "main",
    private: true,
    permissions: { pull: true, push: true },
  };
  await assert.rejects(session.listBranches(selected), (error: unknown) => error instanceof GitHubSyncError && error.code === "repository_mismatch");
  repositoryId = 12345;
  canPull = false;
  await assert.rejects(session.listBranches(selected), (error: unknown) => error instanceof GitHubSyncError && error.code === "permission_denied");
  canPull = true;
  malformed = true;
  await assert.rejects(session.listBranches(selected), (error: unknown) => error instanceof GitHubSyncError && error.code === "git_error");
});
