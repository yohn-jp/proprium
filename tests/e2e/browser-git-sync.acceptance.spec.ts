import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { BrowserLocalGit, GitHubSyncClient } from "../../app/src/browser/proprium/git/index.js";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/protocol.js";
import { installMockGitHubOAuth, installSyntheticSmartHttpRelay } from "../helpers/github-relay-fixture.js";

declare global {
  interface Window {
    browserGitTest: {
      open(localWorkspaceId: string, changes?: Partial<WorkspaceIdentity>): BrowserLocalGit;
      holdLock(localWorkspaceId: string): Promise<boolean>;
      releaseLock(): void;
    };
    githubSyncTest?: { git: BrowserLocalGit; sync: GitHubSyncClient };
  }
}

const hostOrigin = new URL(process.env.PROPRIUM_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.PROPRIUM_E2E_PORT ?? process.env.SCRIPTORIUM_E2E_PORT ?? "4173"}`).origin;
const relayOrigin = "http://127.0.0.1:4174";
const liveGatewayUrl = process.env.PROPRIUM_E2E_GATEWAY_URL ?? "";
const repositoryId = 923456789;
const liveGitHubToken = process.env.PROPRIUM_E2E_GITHUB_TOKEN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN ?? "";
const liveGitHubOwner = process.env.PROPRIUM_E2E_GITHUB_OWNER ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_OWNER ?? "";
const liveGitHubRepository = process.env.PROPRIUM_E2E_GITHUB_REPOSITORY ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY ?? "";
const liveGitHubRepositoryId = Number(process.env.PROPRIUM_E2E_GITHUB_REPOSITORY_ID ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY_ID ?? "0");
const liveGitHubBranch = process.env.PROPRIUM_E2E_GITHUB_BRANCH ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_BRANCH ?? "";
const liveGitHubLogin = process.env.PROPRIUM_E2E_GITHUB_LOGIN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_LOGIN ?? "";
const fixtureOAuthToken = liveGitHubToken || `ghu_${"x".repeat(36)}`;

interface SmartHttpFixture {
  backendUrl: string;
  commit(content: string, parent: string | null, mode: "plain" | "encoding" | "signature"): RemoteCommitFixture;
  head(): string;
  close(): Promise<void>;
  sawGitHubBasicAuth: () => boolean;
  noteGitHubBasicAuth(headers: Headers): void;
  diagnostics(): string[];
  refs(): string[];
}

let activeSmartHttpFixture: SmartHttpFixture | null = null;
let liveSmartHttpRequests: string[] = [];
let smartHttpAccessCookieObserved = false;

function createSmartHttpFixture(): Promise<SmartHttpFixture> {
  const root = mkdtempSync(join(tmpdir(), "proprium-github-smart-http-"));
  const ownerDir = join(root, "proprium-test");
  const bare = join(ownerDir, "browser-git-fixture.git");
  mkdirSync(ownerDir);
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  execFileSync("git", ["--git-dir", bare, "config", "http.uploadpack", "true"], { stdio: "ignore" });
  execFileSync("git", ["--git-dir", bare, "config", "http.receivepack", "true"], { stdio: "ignore" });
  const git = (args: string[], input?: Uint8Array): string => execFileSync("git", ["--git-dir", bare, ...args], {
    input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }).trim();
  let basicAuthObserved = false;
  const requestLog: string[] = [];
  let port = 0;
  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength;
        if (size > 50 * 1024 * 1024) throw new Error("fixture request too large");
        chunks.push(bytes);
      }
      const requestUrl = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`);
      const requestDescription = `${incoming.method ?? "GET"} ${requestUrl.pathname}${requestUrl.search}`;
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: requestUrl.pathname,
        QUERY_STRING: requestUrl.search.slice(1),
        REQUEST_METHOD: incoming.method ?? "GET",
        CONTENT_TYPE: incoming.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(size),
        REMOTE_ADDR: "127.0.0.1",
        REMOTE_USER: "synthetic-fixture",
        SERVER_PROTOCOL: "HTTP/1.1",
        SERVER_NAME: "127.0.0.1",
        SERVER_PORT: String(port),
        GATEWAY_INTERFACE: "CGI/1.1",
      };
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (!value || name === "content-type" || name === "content-length") continue;
        const envName = `HTTP_${name.toUpperCase().replace(/-/gu, "_")}`;
        environment[envName] = Array.isArray(value) ? value.join(", ") : value;
      }
      const output = execFileSync("git", ["http-backend"], {
        input: Buffer.concat(chunks), env: environment, maxBuffer: 64 * 1024 * 1024,
      });
      let boundary = output.indexOf(Buffer.from("\r\n\r\n"));
      let separatorSize = 4;
      if (boundary < 0) { boundary = output.indexOf(Buffer.from("\n\n")); separatorSize = 2; }
      if (boundary < 0) throw new Error("fixture CGI response headers were incomplete");
      const rawHeaders = output.subarray(0, boundary).toString("latin1").split(/\r?\n/u);
      const headers: Array<[string, string]> = [];
      let status = 200;
      for (const line of rawHeaders) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.slice(0, 3)) || 200;
        else if (!/^(?:transfer-encoding|connection)$/iu.test(name)) headers.push([name, value]);
      }
      outgoing.writeHead(status, headers);
      const responseBody = output.subarray(boundary + separatorSize);
      outgoing.end(responseBody);
      if (requestUrl.pathname.endsWith("/git-receive-pack")) {
        const report: string[] = [];
        let offset = 0;
        while (offset + 4 <= responseBody.byteLength) {
          const packetLength = Number.parseInt(responseBody.subarray(offset, offset + 4).toString("ascii"), 16);
          if (!Number.isFinite(packetLength) || packetLength < 4 || offset + packetLength > responseBody.byteLength) break;
          const packet = responseBody.subarray(offset + 4, offset + packetLength).toString("utf8").trim();
          if (packet.startsWith("unpack ") || packet.startsWith("ok ") || packet.startsWith("ng ")) report.push(packet);
          offset += packetLength;
        }
        requestLog.push(`${requestDescription} -> ${status} [${report.join("; ")}]`);
      } else requestLog.push(`${requestDescription} -> ${status}`);
    })().catch(() => {
      if (outgoing.headersSent) return outgoing.destroy();
      outgoing.writeHead(502, { "Content-Type": "text/plain" });
      outgoing.end("synthetic Git HTTP fixture failed");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => { rmSync(root, { recursive: true, force: true }); reject(error); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("synthetic Git HTTP fixture did not bind"));
      port = address.port;
      resolve({
        backendUrl: `http://127.0.0.1:${port}`,
        commit(content, parent, mode) {
          const bytes = Buffer.from(content, mode === "encoding" ? "latin1" : "utf8");
          const blobSha = git(["hash-object", "-w", "--stdin"], bytes);
          const treeBytes = Buffer.concat([Buffer.from("100644 file.txt\0"), Buffer.from(blobSha, "hex")]);
          const treeSha = git(["hash-object", "-w", "-t", "tree", "--stdin"], treeBytes);
          const timestamp = 1704067200;
          const identity = `Browser Fixture <fixture@example.test> ${timestamp} +0000`;
          const headers = [
            `tree ${treeSha}`,
            ...(parent ? [`parent ${parent}`] : []),
            `author ${identity}`,
            `committer ${identity}`,
            ...(mode === "encoding" ? ["encoding ISO-8859-1"] : mode === "signature" ? [
              "gpgsig -----BEGIN PGP SIGNATURE-----", " ", " c3ludGhldGljLXNpZ25hdHVyZQ==", " -----END PGP SIGNATURE-----",
            ] : []),
          ];
          const message = Buffer.from(`${mode} fixture\n`, "utf8");
          const commitBytes = Buffer.concat([Buffer.from(`${headers.join("\n")}\n\n`), message]);
          const sha = git(["hash-object", "-w", "-t", "commit", "--stdin"], commitBytes);
          git(["update-ref", "refs/heads/main", sha]);
          return {
            sha, treeSha, blobSha, bytes: new Uint8Array(bytes),
            commitApi: {
              sha,
              commit: {
                tree: { sha: treeSha }, message: `${mode} fixture\n`,
                author: { name: "Browser Fixture", email: "fixture@example.test", date: "2024-01-01T00:00:00Z" },
                committer: { name: "Browser Fixture", email: "fixture@example.test", date: "2024-01-01T00:00:00Z" },
                verification: { signature: null },
              },
              parents: parent ? [{ sha: parent }] : [],
            },
          };
        },
        head: () => git(["rev-parse", "refs/heads/main"]),
        diagnostics: () => [...requestLog],
        refs: () => git(["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n").filter(Boolean),
        async close() {
          await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
          rmSync(root, { recursive: true, force: true });
        },
        sawGitHubBasicAuth: () => basicAuthObserved,
        noteGitHubBasicAuth(headers: Headers) { basicAuthObserved ||= (headers.get("Authorization") ?? "").startsWith("Basic "); },
      });
    });
  });
}

async function mockOAuthRelay(page: Page): Promise<void> {
  await installMockGitHubOAuth(page, {
    relayUrl: relayOrigin, hostOrigin, accessToken: fixtureOAuthToken,
  });
  await installSyntheticSmartHttpRelay(page, {
    relayUrl: relayOrigin, hostOrigin,
    owner: "proprium-test", repository: "browser-git-fixture", repositoryId,
    accessToken: fixtureOAuthToken,
    backendUrl: () => activeSmartHttpFixture?.backendUrl ?? null,
    onBasicAuthorization: authorization => activeSmartHttpFixture?.noteGitHubBasicAuth(new Headers({ Authorization: authorization })),
    onAccessCookie: present => { smartHttpAccessCookieObserved ||= present; },
  });
}

async function mockGatewayOAuth(page: Page): Promise<void> {
  await installMockGitHubOAuth(page, {
    relayUrl: liveGatewayUrl, hostOrigin, accessToken: liveGitHubToken,
  });
  const gatewayOrigin = new URL(liveGatewayUrl).origin;
  await page.context().route(`${gatewayOrigin}/git/**`, async route => {
    const request = route.request();
    liveSmartHttpRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.continue();
  });
}

test.beforeEach(async ({ page }) => mockOAuthRelay(page));

interface RemoteCommitFixture {
  sha: string;
  treeSha: string;
  blobSha: string;
  bytes: Uint8Array;
  parent?: string | null;
  message?: string;
  commitApi: Record<string, unknown>;
}

function objectSha(type: string, bytes: Uint8Array): string {
  const header = Buffer.from(`${type} ${bytes.byteLength}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function dateParts(value: string): { timestamp: number; timezoneOffset: number } {
  const offset = /(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value)!;
  const timezoneOffset = offset[1] === "Z" ? 0 : (Number(offset[3]) * 60 + Number(offset[4])) * (offset[2] === "+" ? -1 : 1);
  return { timestamp: Math.floor(Date.parse(value) / 1000), timezoneOffset };
}

function commitDate(value: string): string {
  const { timestamp, timezoneOffset } = dateParts(value);
  const east = -timezoneOffset;
  const local = new Date((timestamp + east * 60) * 1000);
  const sign = east < 0 ? "-" : "+";
  const absolute = Math.abs(east);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}T${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}:${String(local.getUTCSeconds()).padStart(2, "0")}${offset}`;
}

function fixtureCommit(content: string, message: string, parent: string | null, date: string, extraHeader?: string): RemoteCommitFixture {
  const bytes = new TextEncoder().encode(content);
  const blobSha = objectSha("blob", bytes);
  const treeBytes = Buffer.concat([Buffer.from(`100644 file.txt\0`), Buffer.from(blobSha, "hex")]);
  const treeSha = objectSha("tree", treeBytes);
  const { timestamp, timezoneOffset } = dateParts(date);
  const offsetEast = -timezoneOffset;
  const offsetString = `${offsetEast < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offsetEast) / 60)).padStart(2, "0")}${String(Math.abs(offsetEast) % 60).padStart(2, "0")}`;
  const identity = `Browser Fixture <fixture@example.test> ${timestamp} ${offsetString}`;
  const normalizedMessage = message.replace(/\r/gu, "").replace(/^\n+/u, "").replace(/\n+$/u, "") + "\n";
  const payload = Buffer.from(`tree ${treeSha}\n${parent ? `parent ${parent}\n` : ""}${extraHeader ? `${extraHeader}\n` : ""}author ${identity}\ncommitter ${identity}\n\n${normalizedMessage}`);
  const sha = objectSha("commit", payload);
  return {
    sha, treeSha, blobSha, bytes,
    commitApi: {
      sha,
      commit: {
        tree: { sha: treeSha }, message: normalizedMessage,
        author: { name: "Browser Fixture", email: "fixture@example.test", date: commitDate(date) },
        committer: { name: "Browser Fixture", email: "fixture@example.test", date: commitDate(date) },
        verification: { signature: null },
      },
      parents: parent ? [{ sha: parent }] : [],
    },
  };
}

function corsHeaders(origin = hostOrigin): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type, X-GitHub-Api-Version",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

test("an empty remote branch opens as an empty workspace without a false conflict", async ({ page }) => {
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/user") return json({ id: 88, login: "writer" });
    if (url.pathname === "/repos/proprium-test/browser-git-fixture") return json({
      id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
    });
    if (url.pathname === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") return json({ message: "Not Found" }, 404);
    return json({ message: `Unexpected ${route.request().method()} ${url.pathname}` }, 404);
  });

  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async ({ id, relayUrl }) => {
    const git = window.browserGitTest.open(id);
    const initialized = await git.init();
    const sync = git.connectGitHub(relayUrl);
    await sync.beginAuthorization();
    await sync.completeAuthorization();
    const pulled = await sync.pull();
    const emptyFiles = await git.listFiles();
    const emptyStatus = await git.status();
    const draft = await git.write("local.txt", new TextEncoder().encode("local only\n"), { oid: null });
    await git.add(["local.txt"], null);
    const commit = await git.commit("local-only", { name: "Browser Fixture", email: "fixture@example.test" }, null);
    const localAhead = await sync.pull();
    const status = await git.status();
    const file = await git.read("local.txt");
    sync.signOut();
    git.close();
    return { initialized, pulled, emptyFiles, emptyStatus, draft, commit, localAhead, status, file };
  }, { id: `empty-${crypto.randomUUID()}`, relayUrl: relayOrigin });
  expect(result.initialized.head).toBeNull();
  expect(result.pulled).toEqual({ state: "up-to-date", head: null });
  expect(result.emptyFiles).toEqual([]);
  expect(result.emptyStatus).toMatchObject({ head: null, localState: "draft", entries: [] });
  expect(result.localAhead).toEqual({ state: "local-ahead", head: result.commit.oid, remoteHead: null });
  expect(result.status).toMatchObject({ head: result.commit.oid, localState: "local-committed", entries: [] });
  expect(result.file.data && Array.from(result.file.data)).toEqual(Array.from(new TextEncoder().encode("local only\n")));
});

test("GitHub REST fetch and pull preserve local Git objects and commit SHA", async ({ page }) => {
  const initial = fixtureCommit("remote bytes\n", "remote commit", null, "2024-01-01T00:00:00Z");
  const commits = new Map([[initial.sha, initial]]);
  const trees = new Map([[initial.treeSha, [{ path: "file.txt", mode: "100644", type: "blob", sha: initial.blobSha }]]]);
  const blobs = new Map([[initial.blobSha, initial.bytes]]);
  let remoteHead: string | null = initial.sha;
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    const url = new URL(route.request().url());
    const path = url.pathname.slice("/repos/proprium-test/browser-git-fixture".length);
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/user") return json({ id: 88, login: "writer" });
    if (url.pathname === "/repos/proprium-test/browser-git-fixture") return json({
      id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
    });
    if (path === "/git/ref/heads/main") return remoteHead
      ? json({ ref: "refs/heads/main", object: { type: "commit", sha: remoteHead } })
      : json({ message: "Not Found" }, 404);
    const commitMatch = /^\/repos\/proprium-test\/browser-git-fixture\/commits\/([a-f0-9]{40})$/u.exec(url.pathname);
    if (commitMatch) {
      const commit = commits.get(commitMatch[1]!);
      return commit ? json(commit.commitApi) : json({ message: "Not Found" }, 404);
    }
    const treeMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/trees\/([a-f0-9]{40})$/u.exec(url.pathname);
    if (treeMatch) return trees.has(treeMatch[1]!) ? json({ sha: treeMatch[1], truncated: false, tree: trees.get(treeMatch[1]!) }) : json({ message: "Not Found" }, 404);
    const blobMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/blobs\/([a-f0-9]{40})$/u.exec(url.pathname);
    if (blobMatch) {
      const blob = blobs.get(blobMatch[1]!);
      return blob ? json({ sha: blobMatch[1], size: blob.byteLength, encoding: "base64", content: Buffer.from(blob).toString("base64") }) : json({ message: "Not Found" }, 404);
    }
    return json({ message: `Unexpected ${route.request().method()} ${url.pathname}` }, 404);
  });

  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async ({ id, relayUrl }) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub(relayUrl);
    await sync.beginAuthorization();
    await sync.completeAuthorization();
    const fetched = await sync.fetch();
    const pulled = await sync.pull();
    const local = await git.read("file.txt");
    const history = await git.log();
    sync.signOut();
    git.close();
    return { fetched, pulled, bytes: local.data ? Array.from(local.data) : null, history };
  }, { id: `sync-${crypto.randomUUID()}`, relayUrl: relayOrigin });
  expect(result.fetched).toMatchObject({ head: initial.sha, importedCommits: 1, localHead: null });
  expect(result.pulled).toEqual({ state: "fast-forwarded", previousHead: null, head: initial.sha });
  expect(result.bytes).toEqual(Array.from(new TextEncoder().encode("remote bytes\n")));
  expect(result.history[0]?.oid).toBe(initial.sha);
});

test("non-force publish detects a racing writer and reconciles a lost ref response by reachability", async ({ page }) => {
  const base = fixtureCommit("base\n", "base", null, "2024-01-01T00:00:00Z");
  const remoteCompetitor = fixtureCommit("remote\n", "remote", base.sha, "2024-01-03T00:00:00Z");
  const commits = new Map([[base.sha, base], [remoteCompetitor.sha, remoteCompetitor]]);
  const trees = new Map([
    [base.treeSha, [{ path: "file.txt", mode: "100644", type: "blob", sha: base.blobSha }]],
    [remoteCompetitor.treeSha, [{ path: "file.txt", mode: "100644", type: "blob", sha: remoteCompetitor.blobSha }]],
  ]);
  const blobs = new Map([[base.blobSha, base.bytes], [remoteCompetitor.blobSha, remoteCompetitor.bytes]]);
  let remoteHead: string | null = base.sha;
  let injectedRace = false;
  let forceValue: unknown;
  let localPublishedSha: string | null = null;
  let updateMode: "race" | "lost-response" | "remote-unknown" = "race";
  let loseNextRefRead = false;
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/user") return json({ id: 88, login: "writer" });
    if (path === "/repos/proprium-test/browser-git-fixture") return json({
      id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
    });
    if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") {
      if (loseNextRefRead) { loseNextRefRead = false; return route.abort("connectionreset"); }
      return remoteHead
        ? json({ ref: "refs/heads/main", object: { type: "commit", sha: remoteHead } })
        : json({ message: "Not Found" }, 404);
    }
    const commitMatch = /^\/repos\/proprium-test\/browser-git-fixture\/commits\/([a-f0-9]{40})$/u.exec(path);
    if (commitMatch) {
      const commit = commits.get(commitMatch[1]!);
      return commit ? json(commit.commitApi) : json({ message: "Not Found" }, 404);
    }
    const treeMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/trees\/([a-f0-9]{40})$/u.exec(path);
    if (treeMatch) return trees.has(treeMatch[1]!) ? json({ sha: treeMatch[1], truncated: false, tree: trees.get(treeMatch[1]!) }) : json({ message: "Not Found" }, 404);
    const blobMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/blobs\/([a-f0-9]{40})$/u.exec(path);
    if (blobMatch) {
      const blob = blobs.get(blobMatch[1]!);
      return blob ? json({ sha: blobMatch[1], size: blob.byteLength, encoding: "base64", content: Buffer.from(blob).toString("base64") }) : json({ message: "Not Found" }, 404);
    }
    if (path === "/repos/proprium-test/browser-git-fixture/git/blobs" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { content: string };
      const bytes = Buffer.from(body.content, "base64");
      const sha = objectSha("blob", bytes);
      blobs.set(sha, new Uint8Array(bytes));
      return json({ sha });
    }
    if (path === "/repos/proprium-test/browser-git-fixture/git/trees" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { tree: Array<{ path: string; mode: string; type: string; sha: string }> };
      const entries = [...body.tree].sort((left, right) => left.path.localeCompare(right.path));
      const raw = Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, "hex")])));
      const sha = objectSha("tree", raw);
      trees.set(sha, entries.map(entry => ({ ...entry })));
      return json({ sha });
    }
    if (path === "/repos/proprium-test/browser-git-fixture/git/commits" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        message: string; tree: string; parents: string[];
        author: { name: string; email: string; date: string };
        committer: { name: string; email: string; date: string };
      };
      const person = (value: typeof body.author) => {
        const { timestamp, timezoneOffset } = dateParts(value.date);
        const east = -timezoneOffset;
        const zone = `${east < 0 ? "-" : "+"}${String(Math.floor(Math.abs(east) / 60)).padStart(2, "0")}${String(Math.abs(east) % 60).padStart(2, "0")}`;
        return `${value.name} <${value.email}> ${timestamp} ${zone}`;
      };
      const message = body.message.replace(/\r/gu, "").replace(/^\n+/u, "").replace(/\n+$/u, "") + "\n";
      const payload = Buffer.from(`tree ${body.tree}\n${body.parents.map(parent => `parent ${parent}\n`).join("")}author ${person(body.author)}\ncommitter ${person(body.committer)}\n\n${message}`);
      const sha = objectSha("commit", payload);
      localPublishedSha = sha;
      commits.set(sha, {
        sha,
        treeSha: body.tree,
        blobSha: "",
        bytes: new Uint8Array(),
        parent: body.parents[0] ?? null,
        message,
        commitApi: {
          sha,
          commit: {
            tree: { sha: body.tree }, message,
            author: { ...body.author }, committer: { ...body.committer }, verification: { signature: null },
          },
          parents: body.parents.map(parent => ({ sha: parent })),
        },
      });
      return json({ sha });
    }
    if (path === "/repos/proprium-test/browser-git-fixture/git/refs/heads/main" && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { sha: string; force: boolean };
      forceValue = body.force;
      if (updateMode === "race") {
        injectedRace = true;
        remoteHead = remoteCompetitor.sha;
        return json({ message: "Update is not a fast forward" }, 422);
      }
      if (updateMode === "lost-response") remoteHead = body.sha;
      else loseNextRefRead = true;
      return route.abort("connectionreset");
    }
    return json({ message: `Unexpected ${route.request().method()} ${path}` }, 404);
  });

  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async ({ id, baseSha, relayUrl }) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub(relayUrl);
    await sync.beginAuthorization();
    await sync.completeAuthorization();
    const pulled = await sync.pull();
    if (pulled.state !== "fast-forwarded") throw new Error("Fixture setup did not pull its base commit.");
    const current = await git.read("file.txt");
    await git.write("file.txt", new TextEncoder().encode("local\n"), current.revision);
    await git.add(["file.txt"], baseSha);
    const commit = await git.commit("local", { name: "Browser Fixture", email: "fixture@example.test" }, baseSha);
    const localAhead = await sync.pull();
    const localStatus = await git.status();
    const localFile = await git.read("file.txt");
    const result = await sync.publish(commit.oid, baseSha);
    git.close();
    return { result, localHead: commit.oid, localAhead, localStatus, localFile: localFile.data ? new TextDecoder().decode(localFile.data) : null };
  }, { id: `race-${crypto.randomUUID()}`, baseSha: base.sha, relayUrl: relayOrigin });
  expect(result.localAhead).toEqual({ state: "local-ahead", head: result.localHead, remoteHead: base.sha });
  expect(result.localStatus).toMatchObject({ head: result.localHead, localState: "local-committed", entries: [] });
  expect(result.localFile).toBe("local\n");
  expect(injectedRace).toBe(true);
  expect(forceValue).toBe(false);
  expect(localPublishedSha).toBe(result.localHead);
  expect(result.result).toEqual({ state: "conflict", expectedRemoteHead: base.sha, remoteHead: remoteCompetitor.sha });
  expect(remoteHead).toBe(remoteCompetitor.sha);

  updateMode = "lost-response";
  const recovered = await page.evaluate(async ({ id, relayUrl }) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub(relayUrl);
    await sync.beginAuthorization();
    await sync.completeAuthorization();
    const pulled = await sync.pull();
    if (pulled.state !== "fast-forwarded") throw new Error("Fixture setup did not pull the concurrent remote head.");
    const current = await git.read("file.txt");
    await git.write("file.txt", new TextEncoder().encode("verified publish\n"), current.revision);
    await git.add(["file.txt"], pulled.head);
    const commit = await git.commit("verified publish", { name: "Browser Fixture", email: "fixture@example.test" }, pulled.head);
    const result = await sync.publish(commit.oid, pulled.head);
    git.close();
    return { result, localHead: commit.oid };
  }, { id: `lost-${crypto.randomUUID()}`, relayUrl: relayOrigin });
  expect(localPublishedSha).toBe(recovered.localHead);
  expect(recovered.result).toEqual({ state: "published", head: recovered.localHead, remoteHead: recovered.localHead });
  expect(remoteHead).toBe(recovered.localHead);

  updateMode = "remote-unknown";
  const unknown = await page.evaluate(async ({ id, relayUrl }) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub(relayUrl);
    await sync.beginAuthorization();
    await sync.completeAuthorization();
    const pulled = await sync.pull();
    if (pulled.state !== "fast-forwarded") throw new Error("Fixture setup did not pull the published remote head.");
    const current = await git.read("file.txt");
    await git.write("file.txt", new TextEncoder().encode("uncertain publish\n"), current.revision);
    await git.add(["file.txt"], pulled.head);
    const commit = await git.commit("uncertain publish", { name: "Browser Fixture", email: "fixture@example.test" }, pulled.head);
    const result = await sync.publish(commit.oid, pulled.head);
    git.close();
    return { result, localHead: commit.oid };
  }, { id: `unknown-${crypto.randomUUID()}`, relayUrl: relayOrigin });
  expect(unknown.result).toEqual({ state: "remote-unknown", expectedRemoteHead: recovered.localHead, observedRemoteHead: null });
});

test("sync preserves dirty edits and reports permission, offline, and expired-credential failures", async ({ page }) => {
  const remote = fixtureCommit("remote data\n", "remote", null, "2024-01-01T09:00:00+09:00");
  let failureMode: "none" | "permission" | "offline" | "expired" = "none";
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/user") return json({ id: 88, login: "writer" });
    if (path === "/repos/proprium-test/browser-git-fixture") {
      if (failureMode === "offline") return route.abort("failed");
      if (failureMode === "expired") return json({ message: "Bad credentials" }, 401);
      return json({
        id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" },
        permissions: { pull: failureMode !== "permission", push: true },
      });
    }
    if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") return json({
      ref: "refs/heads/main", object: { type: "commit", sha: remote.sha },
    });
    if (path === `/repos/proprium-test/browser-git-fixture/commits/${remote.sha}`) return json(remote.commitApi);
    if (path === `/repos/proprium-test/browser-git-fixture/git/trees/${remote.treeSha}`) return json({
      sha: remote.treeSha, truncated: false, tree: [{ path: "file.txt", mode: "100644", type: "blob", sha: remote.blobSha }],
    });
    if (path === `/repos/proprium-test/browser-git-fixture/git/blobs/${remote.blobSha}`) return json({
      sha: remote.blobSha, size: remote.bytes.byteLength, encoding: "base64", content: Buffer.from(remote.bytes).toString("base64"),
    });
    return json({ message: "Not Found" }, 404);
  });

  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async ({ id, relayUrl }) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub(relayUrl);
    await sync.beginAuthorization();
    await sync.completeAuthorization();
    await git.write("draft.txt", new TextEncoder().encode("keep this draft"), { oid: null });
    const pull = await sync.pull();
    const draft = await git.read("draft.txt");
    window.githubSyncTest = { git, sync };
    return { pull, draft: draft.data ? new TextDecoder().decode(draft.data) : null };
  }, { id: `errors-${crypto.randomUUID()}`, relayUrl: relayOrigin });
  expect(result.pull).toEqual({ state: "conflict", localHead: null, remoteHead: remote.sha });
  expect(result.draft).toBe("keep this draft");
  failureMode = "permission";
  const permissionError = await page.evaluate(async () => {
    try { await window.githubSyncTest!.sync.remoteHead(); return "none"; }
    catch (error) { return (error as { code?: string }).code ?? "unknown"; }
  });
  expect(permissionError).toBe("permission_denied");
  failureMode = "offline";
  const offlineError = await page.evaluate(async () => {
    try { await window.githubSyncTest!.sync.remoteHead(); return "none"; }
    catch (error) { return (error as { code?: string }).code ?? "unknown"; }
  });
  expect(offlineError).toBe("network_unavailable");
  failureMode = "expired";
  const expired = await page.evaluate(async () => {
    let errorCode = "none";
    try { await window.githubSyncTest!.sync.remoteHead(); }
    catch (error) { errorCode = (error as { code?: string }).code ?? "unknown"; }
    let clearedCode = "none";
    try { await window.githubSyncTest!.sync.remoteHead(); }
    catch (error) { clearedCode = (error as { code?: string }).code ?? "unknown"; }
    window.githubSyncTest!.git.close();
    return { errorCode, clearedCode };
  });
  expect(expired.errorCode).toBe("authentication_expired");
  expect(expired.clearedCode).toBe("authentication_required");
});

test("Smart HTTP preserves REST-incompatible commit SHAs and falls back for publish", async ({ page }) => {
  const backend = await createSmartHttpFixture();
  activeSmartHttpFixture = backend;
  try {
    const encoded = backend.commit("legacy café\n", null, "encoding");
    const commits = new Map([[encoded.sha, encoded]]);
    const trees = new Map([[encoded.treeSha, [{ path: "file.txt", mode: "100644", type: "blob", sha: encoded.blobSha }]]]);
    const blobs = new Map([[encoded.blobSha, encoded.bytes]]);
    let restCommitWasRejected = false;
    await page.route("https://api.github.com/**", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
      const url = new URL(route.request().url());
      const path = url.pathname;
      const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/user") return json({ id: 88, login: "writer" });
      if (path === "/repos/proprium-test/browser-git-fixture") return json({
        id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
      });
      if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") return json({
        ref: "refs/heads/main", object: { type: "commit", sha: backend.head() },
      });
      if (path === "/repos/proprium-test/browser-git-fixture/commits") {
        const result: RemoteCommitFixture["commitApi"][] = [];
        let oid: string | null = url.searchParams.get("sha");
        while (oid && commits.has(oid)) {
          const commit = commits.get(oid)!;
          result.push(commit.commitApi);
          oid = (commit.commitApi as { parents: Array<{ sha: string }> }).parents[0]?.sha ?? null;
        }
        const offset = (Number(url.searchParams.get("page") ?? "1") - 1) * 100;
        return json(result.slice(offset, offset + 100));
      }
      const commitMatch = /^\/repos\/proprium-test\/browser-git-fixture\/commits\/([a-f0-9]{40})$/u.exec(path);
      if (commitMatch) return commits.has(commitMatch[1]!) ? json(commits.get(commitMatch[1]!)!.commitApi) : json({ message: "Not Found" }, 404);
      const treeMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/trees\/([a-f0-9]{40})$/u.exec(path);
      if (treeMatch) return trees.has(treeMatch[1]!) ? json({ sha: treeMatch[1], truncated: false, tree: trees.get(treeMatch[1]!) }) : json({ message: "Not Found" }, 404);
      const blobMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/blobs\/([a-f0-9]{40})$/u.exec(path);
      if (blobMatch) {
        const blob = blobs.get(blobMatch[1]!);
        return blob ? json({ sha: blobMatch[1], size: blob.byteLength, encoding: "base64", content: Buffer.from(blob).toString("base64") }) : json({ message: "Not Found" }, 404);
      }
      if (path === "/repos/proprium-test/browser-git-fixture/git/blobs" && route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { content: string };
        const bytes = Buffer.from(body.content, "base64");
        const sha = objectSha("blob", bytes);
        blobs.set(sha, new Uint8Array(bytes));
        return json({ sha });
      }
      if (path === "/repos/proprium-test/browser-git-fixture/git/trees" && route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { tree: Array<{ path: string; mode: string; type: string; sha: string }> };
        const entries = [...body.tree].sort((left, right) => left.path.localeCompare(right.path));
        const raw = Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, "hex")])));
        const sha = objectSha("tree", raw);
        trees.set(sha, entries);
        return json({ sha });
      }
      if (path === "/repos/proprium-test/browser-git-fixture/git/commits" && route.request().method() === "POST") {
        restCommitWasRejected = true;
        return json({ sha: "f".repeat(40) });
      }
      if (path === "/repos/proprium-test/browser-git-fixture/git/refs/heads/main" && route.request().method() === "PATCH") {
        return json({ message: "REST publication should have fallen back to Smart HTTP." }, 409);
      }
      return json({ message: "Not Found" }, 404);
    });

    await page.goto("/browser-git-test.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    const encodedResult = await page.evaluate(async ({ id, relayUrl }) => {
      const git = window.browserGitTest.open(id);
      await git.init();
      const sync = git.connectGitHub(relayUrl);
      await sync.beginAuthorization();
      await sync.completeAuthorization();
      const encodedFetch = await sync.fetch();
      const encodedPull = await sync.pull();
      const encodedLog = await git.log();
      const encodedFile = await git.read("file.txt");
      window.githubSyncTest = { git, sync };
      return { encodedFetch, encodedPull, encodedLog, encodedFile };
    }, { id: `smart-http-${crypto.randomUUID()}`, relayUrl: relayOrigin });
    const signed = backend.commit("signed bytes\n", encodedResult.encodedFetch.head, "signature");
    commits.set(signed.sha, signed);
    trees.set(signed.treeSha, [{ path: "file.txt", mode: "100644", type: "blob", sha: signed.blobSha }]);
    blobs.set(signed.blobSha, signed.bytes);
    const result = await page.evaluate(async () => {
      const { git, sync } = window.githubSyncTest!;
      const signedFetch = await sync.fetch();
      const signedPull = await sync.pull();
      if (signedPull.state !== "fast-forwarded") throw new Error("Smart HTTP fixture did not fast-forward the signed commit.");
      const signedLog = await git.log();
      const current = await git.read("file.txt");
      await git.write("file.txt", new TextEncoder().encode("published through Git HTTP\n"), current.revision);
      await git.add(["file.txt"], signedPull.head);
      const local = await git.commit("publish through Git HTTP", { name: "Browser Fixture", email: "fixture@example.test" }, signedPull.head);
      const published = await sync.publish(local.oid, signedPull.head);
      git.close();
      return { signedFetch, signedPull, signedLog, localHead: local.oid, published };
    });

    expect(encodedResult.encodedFetch.head).toBe(encoded.sha);
    expect(encodedResult.encodedFetch.importedCommits).toBe(1);
    expect(encodedResult.encodedPull).toEqual({ state: "fast-forwarded", previousHead: null, head: encoded.sha });
    expect(encodedResult.encodedLog.map(entry => entry.oid)).toEqual([encoded.sha]);
    expect(encodedResult.encodedFile.data).toEqual(encoded.bytes);
    expect(result.signedFetch.head).toBe(signed.sha);
    expect(result.signedFetch.importedCommits).toBe(1);
    expect(result.signedPull).toEqual({ state: "fast-forwarded", previousHead: encoded.sha, head: signed.sha });
    expect(result.signedLog.map(entry => entry.oid)).toEqual([signed.sha, encoded.sha]);
    expect(restCommitWasRejected).toBe(true);
    expect(result.published, JSON.stringify({ backendHead: backend.head(), gitHttp: backend.diagnostics() })).toEqual({ state: "published", head: result.localHead, remoteHead: result.localHead });
    expect(backend.head()).toBe(result.localHead);
    expect(backend.sawGitHubBasicAuth()).toBe(true);
  } finally {
    activeSmartHttpFixture = null;
    await backend.close();
  }
});

test("live disposable GitHub sync fetches, fast-forwards, publishes and confirms the exact remote SHA", async ({ page }) => {
  test.skip(!liveGatewayUrl || !liveGitHubToken || !liveGitHubOwner || !liveGitHubRepository || !liveGitHubBranch ||
    ["main", "master"].includes(liveGitHubBranch.toLowerCase()) || !Number.isSafeInteger(liveGitHubRepositoryId) || liveGitHubRepositoryId <= 0,
  "Requires PROPRIUM_E2E_GATEWAY_URL, an in-memory test token, and an explicit disposable non-main GitHub branch.");
  liveSmartHttpRequests = [];
  await mockGatewayOAuth(page);
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async ({ owner, repository, repoId, branch, relayUrl, id }) => {
      const git = window.browserGitTest.open(id, {
        origin: "https://github.com", owner, repository, repositoryId: repoId, branch,
      });
      await git.init();
      const sync = git.connectGitHub(relayUrl);
      await sync.beginAuthorization();
      const account = await sync.completeAuthorization();
      const initialHead = await sync.remoteHead();
      const fetched = await sync.fetch();
      const pulled = await sync.pull();
      if (pulled.state !== "fast-forwarded" && pulled.state !== "up-to-date") throw new Error("Live fixture could not pull its confirmed GitHub branch.");
      const fileName = `.proprium-wave2-${crypto.randomUUID()}.txt`;
      await git.write(fileName, new TextEncoder().encode("Synthetic browser Git fixture.\n"), { oid: null });
      const baseHead = pulled.head;
      const staged = await git.add([fileName], baseHead);
      const committed = await git.commit("Verify browser GitHub publication", { name: "Proprium Synthetic Fixture", email: "fixture@example.test" }, baseHead);
      const published = await sync.publish(committed.oid, baseHead);
      const confirmed = await sync.remoteHead();
      const finalState = await git.status();
      git.close();
      return { account, initialHead: initialHead.head, fetched, pulled, stagedHead: staged.head, localHead: committed.oid, published, confirmedHead: confirmed.head, finalState };
  }, {
    owner: liveGitHubOwner, repository: liveGitHubRepository, repoId: liveGitHubRepositoryId,
    branch: liveGitHubBranch, relayUrl: liveGatewayUrl, id: `live-${crypto.randomUUID()}`,
  });
  expect(result.account.id).toBeGreaterThan(0);
  expect(result.account.login).toBeTruthy();
  if (liveGitHubLogin) expect(result.account.login.toLowerCase()).toBe(liveGitHubLogin.toLowerCase());
  expect(result.initialHead).toMatch(/^[a-f0-9]{40}$/u);
  expect(result.fetched.head).toBe(result.initialHead);
  expect(result.pulled.state).toMatch(/^(?:fast-forwarded|up-to-date)$/u);
  expect(result.stagedHead).toBe(result.initialHead);
  expect(result.published).toEqual({ state: "published", head: result.localHead, remoteHead: result.localHead });
  expect(result.confirmedHead).toBe(result.localHead);
  expect(result.finalState).toEqual({ head: result.localHead, entries: [], localState: "local-committed" });
  expect(liveSmartHttpRequests.some(request => request.includes("git-upload-pack"))).toBe(true);
});

test("cold history is bounded in REST and fetched as one pack with paginated ancestry", async ({ page }, testInfo) => {
  const backend = await createSmartHttpFixture();
  activeSmartHttpFixture = backend;
  try {
    const history: RemoteCommitFixture[] = [];
    for (let index = 0; index < 121; index += 1) history.push(backend.commit(`history ${index}\n`, history.at(-1)?.sha ?? null, "plain"));
    const commits = new Map(history.map(commit => [commit.sha, commit]));
    const ordered = [...history].reverse();
    let individualReads = 0;
    let ancestryPages = 0;
    let objectReads = 0;
    let githubRestCookieObserved = false;
    smartHttpAccessCookieObserved = false;
    await page.context().addCookies([
      { name: "CF_Authorization_fixture", value: "gateway-access-cookie", url: relayOrigin, sameSite: "Lax" },
      { name: "GitHub_cookie_fixture", value: "must-not-be-forwarded", url: "https://api.github.com", sameSite: "None", secure: true },
    ]);
    await page.route("https://api.github.com/**", async route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
      const url = new URL(route.request().url()), path = url.pathname;
      if (route.request().method() !== "OPTIONS" && (await route.request().allHeaders()).cookie?.includes("GitHub_cookie_fixture=must-not-be-forwarded")) {
        githubRestCookieObserved = true;
      }
      const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/user") return json({ id: 88, login: "writer" });
      if (path === "/repos/proprium-test/browser-git-fixture") return json({ id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true } });
      if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") return json({ ref: "refs/heads/main", object: { type: "commit", sha: backend.head() } });
      if (path === "/repos/proprium-test/browser-git-fixture/commits") {
        ancestryPages += 1;
        expect(url.searchParams.get("sha")).toBe(backend.head());
        const offset = (Number(url.searchParams.get("page")) - 1) * 100;
        return json(ordered.slice(offset, offset + 100).map(commit => commit.commitApi));
      }
      const match = /\/commits\/([a-f0-9]{40})$/u.exec(path);
      if (match && commits.has(match[1]!)) { individualReads += 1; return json(commits.get(match[1]!)!.commitApi); }
      if (path.includes("/git/trees/") || path.includes("/git/blobs/")) objectReads += 1;
      return json({ message: "Unexpected REST request in bulk fixture" }, 404);
    });
    await page.goto("/browser-git-test.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    const result = await page.evaluate(async ({ id, relayUrl }) => {
      const git = window.browserGitTest.open(id);
      await git.init();
      const sync = git.connectGitHub(relayUrl);
      await sync.beginAuthorization(); await sync.completeAuthorization();
      const fetched = await sync.fetch();
      const pulled = await sync.pull();
      const log = await git.log(150);
      const file = await git.read("file.txt");
      git.close();
      return { fetched, pulled, log, text: new TextDecoder().decode(file.data!) };
    }, { id: `bulk-${crypto.randomUUID()}`, relayUrl: relayOrigin });
    expect(result.fetched).toMatchObject({ head: backend.head(), importedCommits: 121 });
    expect(result.pulled).toMatchObject({ state: "fast-forwarded", head: backend.head() });
    expect(result.log.map(commit => commit.oid)).toEqual(ordered.map(commit => commit.sha));
    expect(result.text).toBe("history 120\n");
    expect(individualReads).toBeLessThanOrEqual(8);
    expect(ancestryPages).toBe(2);
    expect(objectReads).toBe(0);
    // WebKit's intercepted-request fixture does not expose Cookie in the
    // Playwright request headers; the live-server cookie path is exercised by
    // the browser Gateway acceptance test.
    if (testInfo.project.name === "chromium") {
      expect(smartHttpAccessCookieObserved).toBe(true);
      expect(githubRestCookieObserved).toBe(false);
    }
    expect(backend.diagnostics().some(line => line.includes("git-upload-pack"))).toBe(true);
  } finally { activeSmartHttpFixture = null; await backend.close(); }
});

test("malformed paginated ancestry rows fail closed before Git pack transfer", async ({ page }) => {
  const backend = await createSmartHttpFixture();
  activeSmartHttpFixture = backend;
  try {
    const history: RemoteCommitFixture[] = [];
    for (let index = 0; index < 12; index += 1) history.push(backend.commit(`history ${index}\n`, history.at(-1)?.sha ?? null, "plain"));
    let malformedRow: "sha" | "parent" = "sha";
    let individualReads = 0;
    let ancestryPages = 0;
    await page.route("https://api.github.com/**", async route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
      const url = new URL(route.request().url()), path = url.pathname;
      const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/user") return json({ id: 88, login: "writer" });
      if (path === "/repos/proprium-test/browser-git-fixture") return json({
        id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
      });
      if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") return json({
        ref: "refs/heads/main", object: { type: "commit", sha: backend.head() },
      });
      if (path === "/repos/proprium-test/browser-git-fixture/commits") {
        ancestryPages += 1;
        expect(url.searchParams.get("sha")).toBe(backend.head());
        expect(url.searchParams.get("per_page")).toBe("100");
        expect(url.searchParams.get("page")).toBe("1");
        return malformedRow === "sha"
          ? json([{ sha: "not-a-git-sha", parents: [] }])
          : json([{ sha: backend.head(), parents: [{ sha: "not-a-git-sha" }] }]);
      }
      const match = /\/commits\/([a-f0-9]{40})$/u.exec(path);
      if (match && history.some(commit => commit.sha === match[1])) {
        individualReads += 1;
        return json(history.find(commit => commit.sha === match[1])!.commitApi);
      }
      return json({ message: `Unexpected ${route.request().method()} ${path}` }, 404);
    });

    await page.goto("/browser-git-test.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    for (const rowKind of ["sha", "parent"] as const) {
      malformedRow = rowKind;
      individualReads = 0;
      ancestryPages = 0;
      const result = await page.evaluate(async ({ id, relayUrl }) => {
        const git = window.browserGitTest.open(id);
        await git.init();
        await git.write("local.txt", new TextEncoder().encode("keep local head\n"), { oid: null });
        await git.add(["local.txt"], null);
        const local = await git.commit("local seed", { name: "Browser Fixture", email: "fixture@example.test" }, null);
        const sync = git.connectGitHub(relayUrl);
        await sync.beginAuthorization();
        await sync.completeAuthorization();
        let errorCode = "none";
        try { await sync.pull(); }
        catch (error) { errorCode = (error as { code?: string }).code ?? "unknown"; }
        const status = await git.status();
        sync.signOut();
        git.close();
        return { errorCode, localHead: local.oid, headAfterFailure: status.head };
      }, { id: `bad-ancestry-${rowKind}-${crypto.randomUUID()}`, relayUrl: relayOrigin });
      expect(result.errorCode).toBe("git_error");
      expect(result.headAfterFailure).toBe(result.localHead);
      expect(individualReads).toBe(8);
      expect(ancestryPages).toBe(1);
      expect(backend.diagnostics()).toEqual([]);
    }
  } finally { activeSmartHttpFixture = null; await backend.close(); }
});

test("a short ancestry page omitting a required parent fails before Git pack transfer", async ({ page }) => {
  const backend = await createSmartHttpFixture();
  activeSmartHttpFixture = backend;
  try {
    const history: RemoteCommitFixture[] = [];
    for (let index = 0; index < 12; index += 1) history.push(backend.commit(`history ${index}\n`, history.at(-1)?.sha ?? null, "plain"));
    const head = history.at(-1)!;
    let individualReads = 0;
    let ancestryPages = 0;
    await page.route("https://api.github.com/**", async route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
      const url = new URL(route.request().url()), path = url.pathname;
      const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/user") return json({ id: 88, login: "writer" });
      if (path === "/repos/proprium-test/browser-git-fixture") return json({
        id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
      });
      if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") return json({
        ref: "refs/heads/main", object: { type: "commit", sha: head.sha },
      });
      if (path === "/repos/proprium-test/browser-git-fixture/commits") {
        ancestryPages += 1;
        expect(url.searchParams.get("sha")).toBe(head.sha);
        expect(url.searchParams.get("per_page")).toBe("100");
        expect(url.searchParams.get("page")).toBe("1");
        return json([head.commitApi]);
      }
      const match = /\/commits\/([a-f0-9]{40})$/u.exec(path);
      if (match && history.some(commit => commit.sha === match[1])) {
        individualReads += 1;
        return json(history.find(commit => commit.sha === match[1])!.commitApi);
      }
      return json({ message: `Unexpected ${route.request().method()} ${path}` }, 404);
    });

    await page.goto("/browser-git-test.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    const result = await page.evaluate(async ({ id, relayUrl }) => {
      const git = window.browserGitTest.open(id);
      await git.init();
      await git.write("local.txt", new TextEncoder().encode("keep local head\n"), { oid: null });
      await git.add(["local.txt"], null);
      const local = await git.commit("local seed", { name: "Browser Fixture", email: "fixture@example.test" }, null);
      const sync = git.connectGitHub(relayUrl);
      await sync.beginAuthorization();
      await sync.completeAuthorization();
      let errorCode = "none";
      try { await sync.pull(); }
      catch (error) { errorCode = (error as { code?: string }).code ?? "unknown"; }
      const status = await git.status();
      sync.signOut();
      git.close();
      return { errorCode, localHead: local.oid, headAfterFailure: status.head };
    }, { id: `missing-ancestor-${crypto.randomUUID()}`, relayUrl: relayOrigin });
    expect(result.errorCode).toBe("git_error");
    expect(result.headAfterFailure).toBe(result.localHead);
    expect(individualReads).toBe(8);
    expect(ancestryPages).toBe(1);
    expect(backend.diagnostics()).toEqual([]);
  } finally { activeSmartHttpFixture = null; await backend.close(); }
});
