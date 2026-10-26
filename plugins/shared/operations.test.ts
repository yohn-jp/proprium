import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readFileVersioned, type FileChunk } from "./operations.js";
import type { GuestHost, HostCall } from "./guest.js";

const snapshot = { id: "snap", local_commit: null, worktree_generation: "gen", draft_generation: null };
const revision = "d".repeat(64);

function fakeHost(chunks: FileChunk[]): { host: GuestHost; calls: HostCall[] } {
  const calls: HostCall[] = [];
  let next = 0;
  const host: GuestHost = {
    *request<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
      const call: HostCall = { kind: "host_call", call_id: "", operation, payload };
      calls.push(call);
      return (yield call) as T;
    },
  };
  Object.defineProperty(host, "nextChunk", { value: () => chunks[next++] });
  return { host, calls };
}

function consume<T>(reader: Generator<HostCall, T, unknown>, chunks: FileChunk[]): T {
  let step = reader.next();
  let index = 0;
  while (!step.done) {
    assert.ok(chunks[index], "reader requested an unexpected extra chunk");
    step = reader.next(chunks[index++]);
  }
  assert.equal(index, chunks.length, "reader must consume each expected chunk exactly once");
  return step.value;
}

test("versioned read checks every bounded chunk and returns the exact Host revision", () => {
  const bytes = new Uint8Array(65_537);
  bytes[65_536] = 255;
  const { host, calls } = fakeHost([
    { revision, total_bytes: bytes.length, offset: 0, bytes: Array.from(bytes.slice(0, 65_536)), next_offset: 65_536 },
    { revision, total_bytes: bytes.length, offset: 65_536, bytes: [255], next_offset: null },
  ]);
  const result = consume(readFileVersioned(host, snapshot, "manuscript/a.md", revision), [
    { revision, total_bytes: bytes.length, offset: 0, bytes: Array.from(bytes.slice(0, 65_536)), next_offset: 65_536 },
    { revision, total_bytes: bytes.length, offset: 65_536, bytes: [255], next_offset: null },
  ]);
  assert.equal(result.revision, revision);
  assert.equal(result.bytes.length, bytes.length);
  assert.equal(result.bytes[65_536], 255);
  assert.deepEqual(calls.map((call) => call.payload.offset), [0, 65_536]);
  assert.ok(calls.every((call) => call.operation === "workspace.file.read" && call.payload.snapshot === snapshot));
});

test("versioned read rejects a chunk revision change and an unexpected expected revision", () => {
  const { host } = fakeHost([]);
  const changed: FileChunk = { revision: "e".repeat(64), total_bytes: 1, offset: 0, bytes: [97], next_offset: null };
  const reader = readFileVersioned(host, snapshot, "manuscript/a.md", revision);
  assert.equal(reader.next().done, false);
  assert.throws(() => reader.next(changed), (error: unknown) => (error as { code?: string }).code === "snapshot_stale");
});

test("byte-only helper preserves its return shape while using version checks", () => {
  const { host } = fakeHost([]);
  const bytes = consume(readFile(host, snapshot, "manuscript/a.md"), [
    { revision, total_bytes: 3, offset: 0, bytes: [97, 98, 99], next_offset: null },
  ]);
  assert.deepEqual([...bytes], [97, 98, 99]);
});
