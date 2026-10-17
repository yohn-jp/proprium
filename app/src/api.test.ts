import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.js";

test("concurrent expired Hosted requests share the rotating refresh exchange", async () => {
  const originalFetch = globalThis.fetch;
  let projectRequests = 0;
  let refreshRequests = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ hosted: true });
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
