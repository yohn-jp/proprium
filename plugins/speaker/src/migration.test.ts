import assert from "node:assert/strict";
import test from "node:test";
import type { Scope, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import { prepareSpeakerRecovery, SPEAKER_RECOVERY_FILES, type SpeakerRecoveryFileState } from "./migration.js";

const scope: Scope = { workspace_id: "workspace-recovery", repository_id: 12, branch: "main", generation: "generation-4" };
const snapshot: Snapshot = { id: "snapshot-recovery", local_commit: "commit-4", worktree_generation: "worktree-4", draft_generation: null };
const [corrections, model] = SPEAKER_RECOVERY_FILES;
const correctionBytes = new Uint8Array([0x7b, 0x22, 0x75, 0x6e, 0x6b, 0x6e, 0x6f, 0x77, 0x6e, 0x22, 0x3a, 0x31, 0x7d, 0x0d, 0x0a, 0xff]);
const modelBytes = new Uint8Array([0x7b, 0x22, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x22, 0x3a, 0x39, 0x7d]);

function file(path: string, revision: string | null, bytes: Uint8Array | null): SpeakerRecoveryFileState {
  return { path, revision, bytes };
}
function sourceAndTargets(
  correctionTarget: { revision: string | null; bytes: Uint8Array | null } = { revision: null, bytes: null },
  modelTarget: { revision: string | null; bytes: Uint8Array | null } = { revision: null, bytes: null },
): SpeakerRecoveryFileState[] {
  return [
    file(corrections.source_path, "legacy-corrections-r1", correctionBytes),
    file(corrections.target_path, correctionTarget.revision, correctionTarget.bytes),
    file(model.source_path, "legacy-model-r1", modelBytes),
    file(model.target_path, modelTarget.revision, modelTarget.bytes),
  ];
}
function plan(files: readonly SpeakerRecoveryFileState[], options: { enabled?: boolean; max?: number; key?: string } = {}) {
  return prepareSpeakerRecovery({ enabled: options.enabled ?? true, idempotency_key: options.key ?? "recovery-1",
    scope, snapshot, files, ...(options.max === undefined ? {} : { max_proposal_bytes: options.max }) });
}

test("Speaker recovery inventories and compiles exact legacy bytes into absent-only reviewed creates", () => {
  const input = sourceAndTargets();
  const result = plan(input);
  assert.deepEqual(result.inventory.map((entry) => entry.disposition), ["restore", "restore"]);
  const operations = result.changeset!.units[0]!.operations;
  assert.deepEqual(operations.map((operation) => operation.path), [corrections.target_path, model.target_path]);
  assert.deepEqual(operations.map((operation) => operation.kind), ["create", "create"]);
  assert.deepEqual(operations[0]!.content, [...correctionBytes]);
  assert.deepEqual(operations[1]!.content, [...modelBytes]);
  assert.equal(operations.every((operation) => operation.expected_revision === null), true);
  assert.equal(result.changeset!.read_set.find((entry) => entry.path === corrections.source_path)?.revision, "legacy-corrections-r1");
  assert.equal(result.changeset!.read_set.find((entry) => entry.path === corrections.target_path)?.revision, null);
  assert.deepEqual(plan(input).changeset, result.changeset, "retry compiles the same proposal identity and byte operations");
});

test("identical targets are unchanged and conflicting targets are reported without overwriting them", () => {
  const identical = plan(sourceAndTargets({ revision: "current-corrections", bytes: correctionBytes }, { revision: "current-model", bytes: modelBytes }));
  assert.deepEqual(identical.inventory.map((entry) => entry.disposition), ["unchanged", "unchanged"]);
  assert.equal(identical.changeset, null);

  const conflicted = plan(sourceAndTargets({ revision: null, bytes: null }, { revision: "different-model", bytes: new Uint8Array([9, 9]) }));
  assert.deepEqual(conflicted.inventory.map((entry) => entry.disposition), ["restore", "conflict"]);
  assert.deepEqual(conflicted.changeset!.units[0]!.operations.map((operation) => operation.path), [corrections.target_path]);
  assert.equal(conflicted.changeset!.units[0]!.operations.some((operation) => operation.path === model.target_path), false);
});

test("missing, disabled, and over-limit recovery is visible and produces no unsafe proposal", () => {
  const missing = plan([
    file(corrections.source_path, null, null), file(corrections.target_path, null, null),
    file(model.source_path, null, null), file(model.target_path, null, null),
  ]);
  assert.deepEqual(missing.inventory.map((entry) => entry.disposition), ["absent", "absent"]);
  assert.equal(missing.changeset, null);

  const disabled = plan(sourceAndTargets(), { enabled: false });
  assert.deepEqual(disabled.inventory.map((entry) => entry.disposition), ["disabled", "disabled"]);
  assert.equal(disabled.changeset, null);

  const overLimit = plan(sourceAndTargets(), { max: 1 });
  assert.deepEqual(overLimit.inventory.map((entry) => entry.disposition), ["blocked", "blocked"]);
  assert.equal(overLimit.changeset, null);
});
