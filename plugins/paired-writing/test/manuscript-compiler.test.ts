import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { compileManuscriptReplacement } from "../src/manuscript-compiler.js";
import { sha256 } from "../src/sha256.js";
import { canonicalJson } from "../src/sha256.js";

const scope = { workspace_id: "workspace-1", repository_id: 41, branch: "main", generation: "generation-1" };
const snapshot = { id: "snapshot-1", local_commit: "commit-1", worktree_generation: "worktree-1", draft_generation: null };
const scenePath = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
const manuscriptPath = "manuscript/v1/c1/s1.md";
const manuscript = "---\r\ntitle: Scene\r\ncustom: keep\r\n---\r\n  🌙彼女は悲しかった。\r\n終わり。\r\n";
const bytes = new TextEncoder().encode(manuscript);
const body = "🌙彼女は悲しかった。\r\n終わり。";
const fileRevision = `sha256:${sha256(bytes)}`;
const scene = {
  scene_id: "s1", title: "Scene", metadata_path: scenePath, metadata_revision: "metadata-rev",
  manuscript_path: manuscriptPath, manuscript_revision: fileRevision,
};

const sceneOperation = {
  id: "op-rewrite", kind: "manuscript.replace-range", evidenceIds: ["e1"],
  precondition: { kind: "content-hash", value: (() => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < body.length; i++) { hash ^= body.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    return (hash >>> 0).toString(16).padStart(8, "0");
  })() },
  target: { manuscriptId: "ms-v1-c1-s1", sceneId: "s1" },
  range: { start: 2, end: 11 }, replacement: "肩が強張った。",
};
const evidence = [{ id: "e1", sourceKind: "manuscript", sourceId: "ms-v1-c1-s1", revision: fileRevision, range: { start: 2, end: 11 } }];
const request: ActionRequest = {
  schema_version: 1, request_id: "compile-1", plugin_id: "proprium.paired-writing", action_id: "paired.changeset.validate",
  scope, snapshot, input: {}, deadline_ms: 30_000,
};

function* hostRequest<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
  return (yield { kind: "host_call", call_id: "", operation, payload }) as T;
}

function fakeHost(): GuestHost {
  return { request: hostRequest };
}

async function drive<T>(generator: Generator<HostCall, T, unknown>): Promise<T> {
  let state = generator.next();
  while (!state.done) {
    const call = state.value;
    let value: unknown;
    if (call.operation === "workspace.plugin.invoke") {
      const { metadata_path, ...context } = scene;
      const nested = call.payload.action_id === "proprium.narrative.scene.open"
        ? { scene: { id: scene.scene_id, metadata_path, metadata_revision: scene.metadata_revision }, manuscript_path: scene.manuscript_path, manuscript_revision: scene.manuscript_revision }
        : context;
      value = { ok: true, request_id: "nested", scope, snapshot, value: nested, warnings: [] };
    } else if (call.operation === "workspace.file.read") {
      const offset = Number(call.payload.offset);
      const part = Array.from(bytes.slice(offset, offset + Number(call.payload.length)));
      const end = offset + part.length;
      value = { revision: fileRevision, total_bytes: bytes.length, offset, bytes: part, next_offset: end < bytes.length ? end : null };
    } else throw new Error(`Unexpected Host operation ${call.operation}`);
    state = generator.next(value);
  }
  return state.value;
}

test("Paired exact-range compiler resolves only the Narrative-linked legacy manuscript identity", async () => {
  const result = await drive(compileManuscriptReplacement(
    sceneOperation, evidence, 0, "paired-source-set", fakeHost(), request,
  ));
  assert.equal(result.read_set[0]?.path, manuscriptPath);
  assert.equal(result.read_set[0]?.revision, fileRevision);
  assert.deepEqual(result.evidence, [{
    path: manuscriptPath, revision: fileRevision,
    start: manuscript.indexOf("🌙") + 2, end: manuscript.indexOf("🌙") + 11,
    quote: "彼女は悲しかった。",
  }]);
  const operation = result.unit.operations[0]!;
  assert.equal(operation.expected_revision, fileRevision);
  assert.equal(new TextDecoder().decode(new Uint8Array(operation.content)),
    manuscript.slice(0, manuscript.indexOf("🌙") + 2) + "肩が強張った。" + manuscript.slice(manuscript.indexOf("🌙") + 11));
});

test("manuscript source identity mismatch fails before any proposal operation", async () => {
  const mismatch = { ...sceneOperation, target: { manuscriptId: "ms-other", sceneId: "s1" } };
  await assert.rejects(drive(compileManuscriptReplacement(mismatch, evidence, 0, "paired-source-set", fakeHost(), request)), /not the linked manuscript/);
});

test("legacy source manuscript revision agrees with source entity hash, not just the file path", async () => {
  const raw = { title: "Scene", custom: "keep" };
  const sourceEntityRevision = `\"sha256-${sha256(new TextEncoder().encode(canonicalJson({ raw, body })))}\"`;
  const legacyEvidence = [{ ...evidence[0]!, revision: sourceEntityRevision }];
  const result = await drive(compileManuscriptReplacement(sceneOperation, legacyEvidence, 0, "paired-source-set", fakeHost(), request));
  assert.equal(result.evidence[0]?.revision, fileRevision);
  const staleEvidence = [{ ...evidence[0]!, revision: "other-entity-revision" }];
  await assert.rejects(drive(compileManuscriptReplacement(sceneOperation, staleEvidence, 0, "paired-source-set", fakeHost(), request)), /Evidence e1 revision/);
});
