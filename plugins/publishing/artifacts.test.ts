import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactSink, Sha256, ARTIFACT_CHUNK_BYTES, StoredZipArtifactWriter } from "./artifacts.js";
import { createStoredZip } from "./domain.js";
import type { ActionRequest } from "../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../shared/guest.js";

const request: ActionRequest = {
  schema_version: 1, request_id: "req-1", plugin_id: "proprium.publishing",
  action_id: "proprium.publishing.export.plaintext", deadline_ms: Date.now() + 10_000,
  scope: { workspace_id: "ws-1", repository_id: 1, branch: "main", generation: "gen-1" },
  snapshot: { id: "snap-1", local_commit: null, worktree_generation: "work-1", draft_generation: null },
  input: { scope: "all", markup: "raw" },
};

const host: GuestHost = {
  *request<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
    return (yield { kind: "host_call", call_id: "", operation, payload }) as T;
  },
};

test("streaming SHA-256 matches standard empty and multi-chunk vectors", () => {
  assert.equal(new Sha256().digest(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const hash = new Sha256();
  hash.update(new TextEncoder().encode("a"));
  hash.update(new TextEncoder().encode("b"));
  hash.update(new TextEncoder().encode("c"));
  assert.equal(hash.digest(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("artifact sink appends bounded chunks and seals the exact hash and byte count", () => {
  const sink = new ArtifactSink(host, request, "work.txt", "text/plain; charset=utf-8");
  const create = sink.create();
  let createStep = create.next();
  assert.equal(createStep.done, false);
  assert.equal((createStep.value as HostCall).operation, "artifact.create");
  createStep = create.next({ artifact_id: "artifact-1", max_bytes: ARTIFACT_CHUNK_BYTES + 20 });
  assert.equal(createStep.done, true);

  const source = new Uint8Array(ARTIFACT_CHUNK_BYTES + 5);
  source.fill(65);
  const append = sink.append(source);
  let appendStep = append.next();
  assert.equal(appendStep.done, false);
  let call = appendStep.value as HostCall;
  assert.equal(call.operation, "artifact.append");
  assert.equal((call.payload.bytes as number[]).length, ARTIFACT_CHUNK_BYTES);
  assert.equal(call.payload.sequence, 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(call)).byteLength < 1024 * 1024,
    "the decimal JSON byte array fits below the v2 HostCall ceiling");
  appendStep = append.next();
  assert.equal(appendStep.done, false);
  call = appendStep.value as HostCall;
  assert.equal(call.operation, "artifact.append");
  assert.equal((call.payload.bytes as number[]).length, 5);
  assert.equal(call.payload.sequence, 1);
  appendStep = append.next();
  assert.equal(appendStep.done, true);

  const seal = sink.seal();
  let sealStep = seal.next();
  assert.equal(sealStep.done, false);
  call = sealStep.value as HostCall;
  assert.equal(call.operation, "artifact.seal");
  assert.equal(call.payload.total_bytes, source.byteLength);
  assert.equal(call.payload.sha256, new Sha256().update(source).digest());
  sealStep = seal.next({});
  assert.equal(sealStep.done, true);
  assert.equal(sealStep.value.artifact_id, "artifact-1");
  assert.equal(sealStep.value.filename, "work.txt");
});

test("artifact sink rejects negotiated size overflow before appending and supports discard", () => {
  const sink = new ArtifactSink(host, request, "too-large.txt", "text/plain; charset=utf-8");
  const create = sink.create();
  create.next();
  create.next({ artifact_id: "small-artifact", max_bytes: 2 });
  const append = sink.append(new Uint8Array([1, 2, 3]));
  assert.throws(() => append.next(), (error: unknown) => (error as { code?: string }).code === "artifact_too_large");
  const discard = sink.discard();
  assert.equal((discard.next().value as HostCall).operation, "artifact.discard");
  assert.equal(discard.next().done, true);
});

test("artifact sink discards a Host artifact when its negotiated limit is malformed", () => {
  const sink = new ArtifactSink(host, request, "bad-limit.txt", "text/plain; charset=utf-8");
  const create = sink.create();
  let step = create.next();
  assert.equal((step.value as HostCall).operation, "artifact.create");
  step = create.next({ artifact_id: "bad-limit", max_bytes: 0 });
  assert.equal((step.value as HostCall).operation, "artifact.discard");
  assert.throws(() => create.next({}), (error: unknown) => (error as { code?: string }).code === "invalid_input");
});

test("streamed stored-ZIP artifact is byte-identical to the deterministic EPUB ZIP writer", () => {
  const sourceFiles = new Map([
    ["mimetype", new TextEncoder().encode("application/epub+zip")],
    ["OEBPS/scene.xhtml", new TextEncoder().encode("<p>本文</p>")],
  ]);
  const output: Uint8Array[] = [];
  const hostWithStorage: GuestHost = {
    *request<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
      let value: unknown;
      if (operation === "artifact.create") value = { artifact_id: "epub-1", max_bytes: 1_000_000 };
      else if (operation === "artifact.append") output.push(Uint8Array.from(payload.bytes as number[]));
      else if (operation === "artifact.seal") value = {};
      else throw new Error(`Unexpected Host operation ${operation}`);
      return (yield { kind: "host_call", call_id: "", operation, payload }) as T ?? value as T;
    },
  };
  // The continuation driver returns Host values to the guest generator.
  const continueWithHost = <T>(generator: Generator<HostCall, T, unknown>): T => {
    let step = generator.next();
    while (!step.done) {
      const call = step.value;
      const reply = call.operation === "artifact.create"
        ? { artifact_id: "epub-1", max_bytes: 1_000_000 }
        : call.operation === "artifact.seal" ? {} : undefined;
      step = generator.next(reply);
    }
    return step.value;
  };
  const sink = new ArtifactSink(hostWithStorage, request, "test.epub", "application/epub+zip");
  const writer = new StoredZipArtifactWriter(sink);
  continueWithHost(writer.start());
  for (const [path, bytes] of sourceFiles) continueWithHost(writer.add(path, bytes));
  const sealed = continueWithHost(writer.finish());
  const streamed = new Uint8Array(output.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of output) { streamed.set(chunk, offset); offset += chunk.length; }
  assert.deepEqual(streamed, createStoredZip(sourceFiles));
  assert.equal(sealed.sha256, new Sha256().update(streamed).digest());
  assert.equal(sealed.total_bytes, streamed.byteLength);
});

test('artifact sink honors a smaller Host chunk limit for streamed exports', () => {
  const sink = new ArtifactSink(host, request, 'work.txt', 'text/plain; charset=utf-8');
  const create = sink.create(); create.next(); create.next({artifact_id:'bounded',max_bytes:100,max_chunk_bytes:3});
  const append = sink.append(new Uint8Array([1,2,3,4,5,6,7]));
  const sizes:number[]=[]; let step=append.next();
  while(!step.done) { sizes.push((step.value.payload.bytes as number[]).length); step=append.next(); }
  assert.deepEqual(sizes,[3,3,1]);
});

test('artifact sink discards a reservation with an invalid Host chunk limit', () => {
  const sink = new ArtifactSink(host, request, 'work.txt', 'text/plain; charset=utf-8');
  const create=sink.create(); create.next(); const step=create.next({artifact_id:'invalid',max_bytes:100,max_chunk_bytes:0});
  assert.equal((step.value as HostCall).operation,'artifact.discard');
  assert.throws(()=>create.next({}),(error:unknown)=>(error as {code?:string}).code==='invalid_input');
});
