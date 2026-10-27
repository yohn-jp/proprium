import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceOperationQueue } from "./operation-queue.js";

test("one worker queues its workspace operations without serializing other workspaces", async () => {
  const queue = new WorkspaceOperationQueue();
  const events: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run("a", async () => { events.push("first"); await pending; events.push("released"); });
  const second = queue.run("a", async () => { events.push("second"); });
  await queue.run("b", async () => { events.push("other"); });
  assert.deepEqual(events, ["first", "other"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "other", "released", "second"]);
});

test("a rejected operation does not poison the workspace queue", async () => {
  const queue = new WorkspaceOperationQueue();
  const failed = queue.run("a", async () => { throw new Error("storage failure"); });
  const next = queue.run("a", async () => "recovered");
  await assert.rejects(failed, /storage failure/);
  assert.equal(await next, "recovered");
});
