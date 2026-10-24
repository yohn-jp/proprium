import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.js";

test("concurrent expired Hosted requests share the rotating refresh exchange", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let projectRequests = 0;
  let refreshRequests = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: undefined } });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "scriptorium", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return Response.json({ refreshed: true });
    }
    if (path === "/api/projects") {
      projectRequests += 1;
      return projectRequests <= 2
        ? Response.json({ error: "expired", code: "UNAUTHORIZED" }, { status: 401 })
        : Response.json([]);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    const results = await Promise.all([api.projects(), api.projects()]);
    assert.deepEqual(results, [[], []]);
    assert.equal(refreshRequests, 1);
    assert.equal(projectRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("concurrent Hosted tabs serialize refresh-cookie rotation", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let projectRequests = 0;
  let refreshRequests = 0;
  let grantFresh = false;
  let lockTail = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, callback: () => Promise<Response>) => {
      const task = lockTail.then(callback, callback);
      lockTail = task.then(() => undefined, () => undefined);
      return task;
    } } },
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "scriptorium", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      grantFresh = true;
      return Response.json({ refreshed: true });
    }
    if (path === "/api/projects") {
      projectRequests += 1;
      return !grantFresh
        ? Response.json({ error: "expired", code: "UNAUTHORIZED" }, { status: 401 })
        : Response.json([]);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    assert.deepEqual(await Promise.all([api.projects(), api.projects()]), [[], []]);
    assert.equal(refreshRequests, 1);
    assert.equal(projectRequests, 5);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("Hosted dependency authorization failures do not trigger browser grant refresh", async () => {
  const originalFetch = globalThis.fetch;
  let refreshRequests = 0;
  let redirectedToReauth = false;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { assign: (url: string) => { redirectedToReauth = url === "/_platform/reauth"; } } },
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "scriptorium", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/api/projects/project-1") {
      return Response.json({ error: "Remote repository authorization failed", code: "REMOTE_AUTHORIZATION_FAILED" }, { status: 401 });
    }
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      return Response.json({ error: "Refresh grant unavailable" }, { status: 401 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    await assert.rejects(api.projectDetails("project-1"), (error: unknown) =>
      error instanceof Error && error.message === "Remote repository authorization failed");
    assert.equal(refreshRequests, 0);
    assert.equal(redirectedToReauth, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("transient Hosted refresh failures preserve their error without reauthentication", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let redirectedToReauth = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { assign: (url: string) => { redirectedToReauth = url === "/_platform/reauth"; } } },
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "scriptorium", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/api/projects") return Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
    if (path === "/_platform/refresh") return Response.json({ error: "Gateway unavailable", code: "GATEWAY_UNAVAILABLE" }, { status: 503 });
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    await assert.rejects(api.projects(), (error: unknown) =>
      error instanceof Error && "status" in error && error.status === 503 && error.message === "Gateway unavailable");
    assert.equal(redirectedToReauth, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Hosted mutation retries only after an explicit admission denial, never after response loss", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let registrationRequests = 0;
  let refreshRequests = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: undefined } });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "scriptorium", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/api/projects") {
      registrationRequests += 1;
      return registrationRequests === 1
        ? Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 })
        : Response.json({ id: "project-1", url: "https://github.com/owner/work", branch: "main" });
    }
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      return Response.json({ refreshed: true });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    assert.deepEqual(await api.registerProject("https://github.com/owner/work"), {
      id: "project-1", url: "https://github.com/owner/work", branch: "main",
    });
    assert.equal(registrationRequests, 2);
    assert.equal(refreshRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }

  let lostResponseRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/inbox/read-all") {
      lostResponseRequests += 1;
      throw new TypeError("connection reset after request send");
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  try {
    await assert.rejects(api.markAllInboxRead(), /connection reset after request send/);
    assert.equal(lostResponseRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scene views use one pinned request for remote and checkpoint content", async () => {
  const originalFetch = globalThis.fetch;
  const sha = "a".repeat(40);
  const snapshot: Parameters<typeof api.readSceneViews>[2] = { repository: { provider: "github", ownerScope: "owner", repositoryId: "1", defaultBranch: "main", url: "https://github.com/owner/work" }, remoteCommit: sha };
  let requests = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `/api/projects/project-1/scenes/scene-1/views?snapshot=${sha}`);
    requests += 1;
    const read = { snapshot, scene: { id: "scene-1", title: "One", text: "text", revision: "revision" }, document: { path: "a.md", content: "text", revision: null }, metadata: { path: "a.yaml", content: "id: scene-1", revision: null } };
    return Response.json({ remote: read, effective: read });
  };
  try {
    const views = await api.readSceneViews("project-1", "scene-1", snapshot);
    assert.equal(views.remote.snapshot.remoteCommit, sha);
    assert.equal(views.effective.snapshot.remoteCommit, sha);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("module invocations bind the exact repository snapshot including the local checkpoint overlay", async () => {
  const originalFetch = globalThis.fetch;
  const snapshot: NonNullable<Parameters<typeof api.action>[4]> = {
    repository: { provider: "local", repositoryId: "1", ownerScope: "owner", defaultBranch: "main", url: "file:///fixture" },
    remoteCommit: "a".repeat(40), overlayCommit: "b".repeat(40),
  };
  globalThis.fetch = async (_input, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), { input: { query: "term" }, snapshot });
    return Response.json({ ok: true, snapshot, data: [] });
  };
  try {
    assert.deepEqual((await api.action("project-1", "search.query", { query: "term" }, undefined, snapshot)).snapshot, snapshot);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
