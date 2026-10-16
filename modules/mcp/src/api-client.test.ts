import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeOperation, RemoteObservation, SnapshotId } from "@scriptorium/contracts";
import { ApiClient } from "./api-client.js";

const snapshot: SnapshotId = {
  repository: {
    provider: "local",
    repositoryId: "repo-one",
    defaultBranch: "main",
    ownerScope: "owner-one",
    url: "file:///repo-one",
  },
  remoteCommit: "b".repeat(40),
};

test("stdio API client uses bearer actions and host-sourced proposals only", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const observation: RemoteObservation = {
    snapshot,
    checkpointHead: "c".repeat(40),
    observedAt: "2026-10-17T00:00:00.000Z",
    state: "fresh",
    pending: [],
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/projects")) {
      return Response.json([{ id: "project-one", url: "https://example.test/one", branch: "main" }]);
    }
    if (url.endsWith("/actions")) {
      return Response.json({ actions: [{ id: "core.status", module: "core", effect: "read" }] });
    }
    if (url.endsWith("/observation")) return Response.json(observation);
    if (url.endsWith("/proposals")) {
      return Response.json({ id: "proposal-1", snapshot, operations: [], source: "mcp" });
    }
    if (url.endsWith("/actions/core.status")) {
      return Response.json({ ok: true, snapshot, data: { status: "ready" } });
    }
    return Response.json({ error: "missing" }, { status: 404 });
  };
  const client = new ApiClient({
    baseUrl: "https://scriptorium.test/",
    token: "test-token",
    projectId: "project-one",
    fetch: fetcher,
  });

  assert.deepEqual(await client.listActions(), [{ id: "core.status", module: "core", effect: "read" }]);
  assert.deepEqual(await client.listProjects(), [
    { id: "project-one", url: "https://example.test/one", branch: "main" },
  ]);
  assert.deepEqual(await client.forProject("project-two").listActions(), [
    { id: "core.status", module: "core", effect: "read" },
  ]);
  assert.deepEqual(await client.invoke("core.status", {}), { ok: true, snapshot, data: { status: "ready" } });
  const operation = { id: "op-one" } as ChangeOperation;
  const proposal = await client.propose([operation], undefined, "source-change-set-1");

  assert.equal(proposal.source, "mcp");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/api/projects/project-one/actions",
    "/api/projects",
    "/api/projects/project-two/actions",
    "/api/projects/project-one/actions/core.status",
    "/api/projects/project-one/observation",
    "/api/projects/project-one/proposals",
  ]);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer test-token");
  }
  const body = JSON.parse(String(calls.at(-1)?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body, { id: "source-change-set-1", snapshot, operations: [operation] });
  assert.equal("source" in body, false);
});

test("stdio API client can bind a requested owner project", async () => {
  const client = new ApiClient({ baseUrl: "http://127.0.0.1:3000", token: "token", projectId: "project-one" });
  assert.equal(client.forProject("project-two").projectId, "project-two");
});
