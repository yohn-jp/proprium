import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CoreStore } from "@scriptorium/core";
import { createServer } from "./server.js";

const ACCESS_TOKEN = "test-access-token-which-is-longer-than-32-characters";

function makeStore(): CoreStore {
  const project = { id: "project-1", url: "https://github.com/owner/work.git", branch: "main" };
  const scene = { id: "scene-1", title: "Opening", text: "canonical draft", revision: "revision-1" };
  return {
    listProjects: async () => [project],
    registerProject: async ({ url, branch }: { url: string; branch?: string }) => ({
      id: "project-2",
      url,
      branch: branch ?? "main",
    }),
    tree: async () => ({
      title: "A Work",
      volumes: [{ id: "vol-1", title: "Volume 1", chapters: [{ id: "ch-1", title: "Chapter 1", scenes: [{ id: scene.id, title: scene.title }] }] }],
    }),
    readScene: async () => scene,
    saveScene: async (_projectId: string, _sceneId: string, input: { text: string; revision: string }) => {
      if (input.revision !== scene.revision) {
        throw { status: 412, code: "STALE_REVISION", message: "Scene changed since it was read" };
      }
      return { ...scene, text: input.text, revision: "revision-2" };
    },
    history: async () => [{ hash: "abc12345", date: "2026-10-16T00:00:00.000Z", message: "write opening" }],
    sync: async () => ({ branch: "main", head: "abc12345", ahead: 0, behind: 0, dirty: false }),
    status: async () => ({ branch: "main", head: "abc12345", ahead: 1, behind: 0, dirty: true }),
  } as unknown as CoreStore;
}

async function startApi(staticDir: string, trustProxy = false) {
  const server = createServer({ store: makeStore(), authToken: ACCESS_TOKEN, staticDir, trustProxy });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return { server, base, close };
}

async function login(base: string): Promise<{ cookie: string; setCookie: string; body: unknown }> {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ token: ACCESS_TOKEN }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return { cookie: setCookie.split(";", 1)[0]!, setCookie, body: await response.json() };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Scriptorium HTTP boundary", () => {
  it("keeps health public, protects project data, and serves the app shell", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-"));
    tempDirs.push(staticDir);
    await writeFile(resolve(staticDir, "index.html"), '<meta name="scriptorium-style-nonce" content="__SCRIPTORIUM_STYLE_NONCE__"><h1>Scriptorium</h1>');
    await Promise.all(["main.js", "api.js", "drafts.js", "styles.css"].map((name) => writeFile(resolve(staticDir, name), name)));
    await writeFile(resolve(staticDir, "server.test.js"), "private test file");
    const apiServer = await startApi(staticDir);
    t.after(apiServer.close);

    const health = await fetch(`${apiServer.base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody: unknown = await health.json();
    assert.deepEqual(healthBody, { status: "ok" });
    assert.equal(JSON.stringify(healthBody).includes(ACCESS_TOKEN), false);

    const projects = await fetch(`${apiServer.base}/api/projects`);
    assert.equal(projects.status, 401);
    assert.equal((await projects.json() as { code: string }).code, "UNAUTHORIZED");

    const shell = await fetch(`${apiServer.base}/`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /Scriptorium/u);
    const nonce = /name="scriptorium-style-nonce" content="([^"]+)"/u.exec(html)?.[1];
    assert.ok(nonce && nonce !== "__SCRIPTORIUM_STYLE_NONCE__");
    assert.ok(shell.headers.get("content-security-policy")?.includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.ok(!shell.headers.get("content-security-policy")?.includes("unsafe-inline"));
    const nextShell = await fetch(`${apiServer.base}/`);
    assert.notEqual(nextShell.headers.get("content-security-policy"), shell.headers.get("content-security-policy"));
    for (const name of ["main.js", "api.js", "drafts.js", "styles.css"]) {
      assert.equal((await fetch(`${apiServer.base}/${name}`)).status, 200);
    }
    assert.equal((await fetch(`${apiServer.base}/server.test.js`)).status, 404);
  });

  it("uses an HttpOnly same-site session and enforces same-origin writes", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-"));
    tempDirs.push(staticDir);
    const apiServer = await startApi(staticDir);
    t.after(apiServer.close);

    const crossOrigin = await fetch(`${apiServer.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ token: ACCESS_TOKEN }),
    });
    assert.equal(crossOrigin.status, 403);

    const invalid = await fetch(`${apiServer.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ token: "wrong" }),
    });
    assert.equal(invalid.status, 401);

    const session = await login(apiServer.base);
    assert.deepEqual(session.body, { authenticated: true });
    assert.match(session.setCookie, /HttpOnly/u);
    assert.match(session.setCookie, /SameSite=Strict/u);
    assert.doesNotMatch(session.setCookie, /Secure/u);
    const cookie = session.cookie;
    const loginResponse = await fetch(`${apiServer.base}/api/session`, { headers: { Cookie: cookie } });
    assert.equal(loginResponse.status, 200);
    const projects = await fetch(`${apiServer.base}/api/projects`, { headers: { Cookie: cookie } });
    assert.deepEqual(await projects.json(), [
      { id: "project-1", url: "https://github.com/owner/work.git", branch: "main" },
    ]);

    const mutation = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-1`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "new draft", revision: "revision-1" }),
    });
    assert.equal(mutation.status, 200);
    assert.equal((await mutation.json() as { text: string }).text, "new draft");

    const stale = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-1`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "must not overwrite", revision: "revision-old" }),
    });
    assert.equal(stale.status, 412);
    assert.equal((await stale.json() as { code: string }).code, "STALE_REVISION");

    const logout = await fetch(`${apiServer.base}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${apiServer.base}/api/projects`, { headers: { Cookie: cookie } })).status, 401);
  });

  it("marks a session cookie Secure when HTTPS is asserted by a trusted proxy", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-"));
    tempDirs.push(staticDir);
    const apiServer = await startApi(staticDir, true);
    t.after(apiServer.close);
    const origin = apiServer.base.replace(/^http:/u, "https:");
    const response = await fetch(`${apiServer.base}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ token: ACCESS_TOKEN }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/u);
  });

  it("rejects short access tokens before opening a listener", () => {
    assert.throws(() => createServer({ store: makeStore(), authToken: "too-short" }), /at least 32/u);
  });
});
