import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ChangeOperation } from "@scriptorium/contracts";
import { api, ApiError } from "./api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const invalid = (error: unknown) => error instanceof ApiError && error.code === "INVALID_RESPONSE";

test("audit browser API rejects malformed, empty and incorrectly shaped successful session responses", async () => {
  for (const response of [new Response("not json"), Response.json(null), Response.json({}), new Response(null, { status: 204 }), Response.json({ authenticated: true, authorScope: 5 })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(api.session(), invalid);
  }
  globalThis.fetch = async () => Response.json({ authenticated: true, authorScope: "owner", permissions: ["read", "write"], futureField: true });
  assert.equal((await api.session()).authorScope, "owner");
});

test("audit browser API rejects a partial runtime-version DTO rather than configuring refresh from it", async () => {
  globalThis.fetch = async () => Response.json({ hosted: true });
  await assert.rejects(api.version(), invalid);
});

test("audit browser API validates checkpoint and publication receipts before recovery accepts them", async () => {
  const operation: ChangeOperation = {
    id: "op-1", generation: 0, effect: "manuscript", message: "save",
    repository: { provider: "local", repositoryId: "1", ownerScope: "owner", defaultBranch: "main", url: "file:///fixture" },
    baseRemoteCommit: "a".repeat(40), reads: [], writes: [{ path: "manuscript/a.md", revision: null, content: "text" }],
  };
  globalThis.fetch = async () => Response.json({ operationId: operation.id, generation: "0", localCommit: "b".repeat(40), remoteBase: operation.baseRemoteCommit, revisions: [] });
  await assert.rejects(api.checkpoint("project-1", operation), invalid);
  globalThis.fetch = async () => Response.json({ batchId: "b1", state: "confirmed", remoteCommit: "a".repeat(40), acknowledged: [{}] });
  await assert.rejects(api.publish("project-1", "b1"), invalid);
  globalThis.fetch = async () => Response.json({ batchId: "b1", state: "publication_unknown", remoteCommit: "", acknowledged: [] });
  assert.equal((await api.publish("project-1", "b1")).state, "publication_unknown");
});

test("audit browser API preserves service errors and permits 204 only for no-content endpoints", async () => {
  globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
  await assert.rejects(api.session(), (error: unknown) => error instanceof ApiError && error.status === 503);
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api.detachProject("project-1"), undefined);
  await assert.rejects(api.projects(), invalid);
});
