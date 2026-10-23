import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.js";

test("concurrent expired Hosted requests share the rotating refresh exchange", async () => {
  const originalFetch = globalThis.fetch;
  let projectRequests = 0;
  let refreshRequests = 0;
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
        ? Response.json({ error: "expired" }, { status: 401 })
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
