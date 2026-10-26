import assert from "node:assert/strict";
import test from "node:test";
import { validateNarrativeChangeSet } from "../src/changeset.js";
import { planCompilers } from "../src/compiler-plan.js";
import { canonicalJson, sha256 } from "../src/sha256.js";

function changeSet(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "source-cs-1",
    projectId: "legacy-project-1",
    goal: "Add a character",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "low" },
    operations: [{
      id: "op-create-character",
      kind: "entity.create",
      precondition: { kind: "absent" },
      target: { entityId: "character-1", entityType: "character" },
      values: { id: "character-1", type: "character", name: "Ari" },
      evidenceIds: ["evidence-1"],
      assessment: { confidence: 0.9, risk: "low" },
    }],
    evidence: [{ id: "evidence-1", sourceKind: "external", sourceId: "note-1", revision: "source-rev-1" }],
    diagnostics: { before: null, after: null },
    ...overrides,
  };
}

test("v1 intake accepts the exact source envelope and preserves source operation IDs", () => {
  const value = validateNarrativeChangeSet(changeSet());
  assert.equal(value.id, "source-cs-1");
  assert.deepEqual(value.operations.map((operation) => operation.id), ["op-create-character"]);
  assert.deepEqual(value.operations[0]?.evidenceIds, ["evidence-1"]);
});

test("v1 intake rejects unknown source fields instead of dropping them", () => {
  const source = changeSet({ future: true });
  assert.throws(() => validateNarrativeChangeSet(source), /unsupported field: future/);
  const withExtraOperation = changeSet({ operations: [{
    ...(changeSet().operations as Array<Record<string, unknown>>)[0],
    guessedPath: "bible/characters/character-1.yaml",
  }] });
  assert.throws(() => validateNarrativeChangeSet(withExtraOperation), /unsupported field: guessedPath/);
});

test("v1 intake rejects duplicate evidence IDs, duplicate operations and duplicate targets", () => {
  const validOperation = (changeSet().operations as Array<Record<string, unknown>>)[0]!;
  assert.throws(() => validateNarrativeChangeSet(changeSet({ evidence: [
    { id: "evidence-1", sourceKind: "external", sourceId: "a", revision: "r1" },
    { id: "evidence-1", sourceKind: "external", sourceId: "b", revision: "r2" },
  ] })), /duplicate evidence ID/);
  assert.throws(() => validateNarrativeChangeSet(changeSet({ operations: [validOperation, validOperation] })), /Duplicate operation ID/);
  const second = { ...validOperation, id: "op-two" };
  assert.throws(() => validateNarrativeChangeSet(changeSet({ operations: [validOperation, second] })), /Conflicting operation target/);
});

test("v1 intake requires a scene insert to follow its matching scene create", () => {
  const insert = {
    id: "op-insert-scene",
    kind: "scene.insert",
    precondition: { kind: "revision", value: "chapter-rev" },
    target: { sceneId: "scene-new", chapterId: "chapter-1" },
    position: 1,
    expectedSiblings: [],
    evidenceIds: ["evidence-1"],
    assessment: { confidence: 1, risk: "low" },
  };
  assert.throws(() => validateNarrativeChangeSet(changeSet({ operations: [insert] })), /must follow its matching scene.create/);
});

test("compiler plan preserves source order and splits mixed scene changes across owner compilers", () => {
  const create = {
    id: "scene-create", kind: "scene.create", precondition: { kind: "absent" }, target: { sceneId: "scene-new" },
    values: { id: "scene-new", type: "scene", title: "Arrival", volume: "volume-1", chapter: "chapter-1", pov: "character-1" },
    evidenceIds: ["evidence-1"], assessment: { confidence: 1, risk: "low" },
  };
  const insert = {
    id: "scene-insert", kind: "scene.insert", precondition: { kind: "revision", value: "chapter-rev" },
    target: { sceneId: "scene-new", chapterId: "chapter-1" }, position: 1, expectedSiblings: [],
    evidenceIds: ["evidence-1"], assessment: { confidence: 1, risk: "low" },
  };
  const update = {
    id: "scene-update", kind: "scene.update", precondition: { kind: "revision", value: "scene-rev" }, target: { sceneId: "scene-existing" },
    changes: { title: "At the door", pov: "character-1" }, evidenceIds: ["evidence-1"], assessment: { confidence: 1, risk: "low" },
  };
  const validated = validateNarrativeChangeSet(changeSet({ operations: [create, insert, update] }));
  const tasks = planCompilers(validated);
  assert.deepEqual(tasks.map((task) => [task.owner, task.operations.map((operation) => operation.id)]), [
    ["narrative", ["scene-create"]],
    ["knowledge", ["scene-create"]],
    ["narrative", ["scene-insert", "scene-update"]],
    ["knowledge", ["scene-update"]],
  ]);
  assert.deepEqual(tasks[0]?.operations[0]?.values, { id: "scene-new", type: "scene", title: "Arrival", volume: "volume-1", chapter: "chapter-1" });
  assert.deepEqual(tasks[1]?.operations[0]?.values, { pov: "character-1" });
  assert.deepEqual(tasks[2]?.operations[1]?.changes, { title: "At the door" });
  assert.deepEqual(tasks[3]?.operations[0]?.changes, { pov: "character-1" });
});

test("compiler plan rejects a source thread relation unsupported by the pinned builder", () => {
  const link = {
    id: "link-advanced", kind: "thread.link-scene", precondition: { kind: "revision", value: "thread-rev" },
    target: { threadId: "thread-1", sceneId: "scene-1" }, relation: "advanced",
    evidenceIds: ["evidence-1"], assessment: { confidence: 1, risk: "low" },
  };
  const validated = validateNarrativeChangeSet(changeSet({ operations: [link] }));
  assert.throws(() => planCompilers(validated), /advanced is unsupported/);
});

test("canonical JSON and SHA-256 are stable and match standard vectors", () => {
  assert.equal(sha256(new TextEncoder().encode("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: 2 } }), canonicalJson({ a: { b: 2, y: true }, z: 1 }));
});
