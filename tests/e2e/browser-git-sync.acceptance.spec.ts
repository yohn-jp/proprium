import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { BrowserLocalGit, GitHubSyncClient } from "../../app/src/browser/proprium/git/index.js";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/protocol.js";

declare global {
  interface Window {
    browserGitTest: {
      open(localWorkspaceId: string, changes?: Partial<WorkspaceIdentity>): BrowserLocalGit;
    };
    githubSyncTest?: { git: BrowserLocalGit; sync: GitHubSyncClient };
  }
}

const hostOrigin = "http://127.0.0.1:4273";
const repositoryId = 923456789;

interface RemoteCommitFixture {
  sha: string;
  treeSha: string;
  blobSha: string;
  bytes: Uint8Array;
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
    if (url.pathname === "/repos/proprium-test/browser-git-fixture") return json({
      id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
    });
    if (path === "/git/ref/heads/main") return remoteHead
      ? json({ ref: "refs/heads/main", object: { type: "commit", sha: remoteHead } })
      : json({ message: "Not Found" }, 404);
    const commitMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/commits\/([a-f0-9]{40})$/u.exec(url.pathname);
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
  const result = await page.evaluate(async ({ id }) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub("ghp_fixture_token");
    const fetched = await sync.fetch();
    const pulled = await sync.pull();
    const local = await git.read("file.txt");
    const history = await git.log();
    sync.signOut();
    git.close();
    return { fetched, pulled, bytes: local.data ? Array.from(local.data) : null, history };
  }, { id: `sync-${crypto.randomUUID()}` });
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
    if (path === "/repos/proprium-test/browser-git-fixture") return json({
      id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
    });
    if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") {
      if (loseNextRefRead) { loseNextRefRead = false; return route.abort("connectionreset"); }
      return remoteHead
        ? json({ ref: "refs/heads/main", object: { type: "commit", sha: remoteHead } })
        : json({ message: "Not Found" }, 404);
    }
    const commitMatch = /^\/repos\/proprium-test\/browser-git-fixture\/git\/commits\/([a-f0-9]{40})$/u.exec(path);
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
  const result = await page.evaluate(async ({ id, baseSha }) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub("ghp_fixture_token");
    const pulled = await sync.pull();
    if (pulled.state !== "fast-forwarded") throw new Error("Fixture setup did not pull its base commit.");
    const current = await git.read("file.txt");
    await git.write("file.txt", new TextEncoder().encode("local\n"), current.revision);
    await git.add(["file.txt"], baseSha);
    const commit = await git.commit("local", { name: "Browser Fixture", email: "fixture@example.test" }, baseSha);
    const result = await sync.publish(commit.oid, baseSha);
    git.close();
    return { result, localHead: commit.oid };
  }, { id: `race-${crypto.randomUUID()}`, baseSha: base.sha });
  expect(injectedRace).toBe(true);
  expect(forceValue).toBe(false);
  expect(localPublishedSha).toBe(result.localHead);
  expect(result.result).toEqual({ state: "conflict", expectedRemoteHead: base.sha, remoteHead: remoteCompetitor.sha });
  expect(remoteHead).toBe(remoteCompetitor.sha);

  updateMode = "lost-response";
  const recovered = await page.evaluate(async (id) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub("ghp_fixture_token");
    const pulled = await sync.pull();
    if (pulled.state !== "fast-forwarded") throw new Error("Fixture setup did not pull the concurrent remote head.");
    const current = await git.read("file.txt");
    await git.write("file.txt", new TextEncoder().encode("verified publish\n"), current.revision);
    await git.add(["file.txt"], pulled.head);
    const commit = await git.commit("verified publish", { name: "Browser Fixture", email: "fixture@example.test" }, pulled.head);
    const result = await sync.publish(commit.oid, pulled.head);
    git.close();
    return { result, localHead: commit.oid };
  }, `lost-${crypto.randomUUID()}`);
  expect(localPublishedSha).toBe(recovered.localHead);
  expect(recovered.result).toEqual({ state: "published", head: recovered.localHead, remoteHead: recovered.localHead });
  expect(remoteHead).toBe(recovered.localHead);

  updateMode = "remote-unknown";
  const unknown = await page.evaluate(async (id) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub("ghp_fixture_token");
    const pulled = await sync.pull();
    if (pulled.state !== "fast-forwarded") throw new Error("Fixture setup did not pull the published remote head.");
    const current = await git.read("file.txt");
    await git.write("file.txt", new TextEncoder().encode("uncertain publish\n"), current.revision);
    await git.add(["file.txt"], pulled.head);
    const commit = await git.commit("uncertain publish", { name: "Browser Fixture", email: "fixture@example.test" }, pulled.head);
    const result = await sync.publish(commit.oid, pulled.head);
    git.close();
    return { result, localHead: commit.oid };
  }, `unknown-${crypto.randomUUID()}`);
  expect(unknown.result).toEqual({ state: "remote-unknown", expectedRemoteHead: recovered.localHead, observedRemoteHead: null });
});

test("sync preserves dirty edits and reports permission, offline, and expired-credential failures", async ({ page }) => {
  const remote = fixtureCommit("remote data\n", "remote", null, "2024-01-01T09:00:00+09:00");
  let failureMode: "none" | "permission" | "offline" | "expired" = "none";
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
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
    if (path === `/repos/proprium-test/browser-git-fixture/git/commits/${remote.sha}`) return json(remote.commitApi);
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
  const result = await page.evaluate(async (id) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub("ghp_fixture_token");
    await git.write("draft.txt", new TextEncoder().encode("keep this draft"), { oid: null });
    const pull = await sync.pull();
    const draft = await git.read("draft.txt");
    window.githubSyncTest = { git, sync };
    return { pull, draft: draft.data ? new TextDecoder().decode(draft.data) : null };
  }, `errors-${crypto.randomUUID()}`);
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

test("REST fetch rejects commit headers that its JSON representation cannot preserve", async ({ page }) => {
  let unsupported = fixtureCommit("legacy\n", "legacy", null, "2024-01-01T00:00:00Z", "encoding ISO-8859-1");
  let branchRefWritten = false;
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/repos/proprium-test/browser-git-fixture") return json({
      id: repositoryId, full_name: "proprium-test/browser-git-fixture", owner: { login: "proprium-test" }, permissions: { pull: true, push: true },
    });
    if (path === "/repos/proprium-test/browser-git-fixture/git/ref/heads/main") return json({
      ref: "refs/heads/main", object: { type: "commit", sha: unsupported.sha },
    });
    if (path === `/repos/proprium-test/browser-git-fixture/git/commits/${unsupported.sha}`) return json(unsupported.commitApi);
    if (path === `/repos/proprium-test/browser-git-fixture/git/trees/${unsupported.treeSha}`) return json({
      sha: unsupported.treeSha, truncated: false, tree: [{ path: "file.txt", mode: "100644", type: "blob", sha: unsupported.blobSha }],
    });
    if (path === `/repos/proprium-test/browser-git-fixture/git/blobs/${unsupported.blobSha}`) return json({
      sha: unsupported.blobSha, size: unsupported.bytes.byteLength, encoding: "base64", content: Buffer.from(unsupported.bytes).toString("base64"),
    });
    if (path === "/repos/proprium-test/browser-git-fixture/git/refs/heads/main" && route.request().method() === "PATCH") branchRefWritten = true;
    return json({ message: "Not Found" }, 404);
  });

  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const id = `unsupported-${crypto.randomUUID()}`;
  const result = await page.evaluate(async (id) => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const sync = git.connectGitHub("ghp_fixture_token");
    let errorCode = "none";
    let message = "";
    try { await sync.fetch(); }
    catch (error) { errorCode = (error as { code?: string }).code ?? "unknown"; message = (error as Error).message; }
    window.githubSyncTest = { git, sync };
    return { errorCode, message };
  }, id);
  expect(result.errorCode).toBe("git_error");
  expect(result.message).toContain("did not preserve its original SHA");
  unsupported = fixtureCommit("signed\n", "signed", null, "2024-01-01T00:00:00Z", "gpgsig unrepresented-signature");
  const signedError = await page.evaluate(() => window.githubSyncTest!.sync.fetch().then(() => "none", error => (error as { code?: string }).code ?? "unknown"));
  expect(signedError).toBe("git_error");
  const state = await page.evaluate(async () => {
    const { git } = window.githubSyncTest!;
    const result = { branches: await git.branches(), log: await git.log() };
    git.close();
    return result;
  });
  expect(state.branches.branches).toEqual([]);
  expect(state.log).toEqual([]);
  expect(branchRefWritten).toBe(false);
});
