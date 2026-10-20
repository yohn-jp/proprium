import assert from "node:assert/strict";
import test from "node:test";
import { canRetainRecoveredEditorDuringSceneLoad, isEditorTextSafeToFlush, isEntryAcknowledgedByReceipt, isNonDraftEntryAcknowledgedByReceipt, isSameSceneEditorLoad, isTextRepresentedByRecoveryRecord, isUnchangedEntryConfirmedByReceipt, mayWriteEditor, mergeLatestDraftEntry, recoveryStatusForJournalOpen } from "./recovery.js";

interface DraftEntry {
  documentKey: string;
  authorScope: string | null;
  state: string;
  operation: { id: string; generation: number };
}

function draftEntry(overrides: Omit<Partial<DraftEntry>, "operation"> & { operation?: Partial<DraftEntry["operation"]> } = {}): DraftEntry {
  const { operation, ...fields } = overrides;
  return {
    documentKey: "repository/scene-1",
    authorScope: "author-1",
    state: "draft",
    ...fields,
    operation: { id: "operation-1", generation: 1, ...operation },
  };
}

test("text is recoverable only when the current record represents the editor", () => {
  assert.equal(isTextRepresentedByRecoveryRecord("clean", null, "clean"), true);
  assert.equal(isTextRepresentedByRecoveryRecord("draft", "draft", "clean"), true);
  assert.equal(isTextRepresentedByRecoveryRecord("new input", "older draft", "clean"), false);
  assert.equal(isTextRepresentedByRecoveryRecord("new input", null, "clean"), false);
});

test("a locked pending editor may flush its canonical placeholder without replacing a checkpointed entry", () => {
  assert.equal(isEditorTextSafeToFlush("canonical", "checkpointed draft", "canonical", "pending"), true);
  assert.equal(isEditorTextSafeToFlush("new input", "checkpointed draft", "canonical", "pending"), false);
  assert.equal(isEditorTextSafeToFlush("canonical", "checkpointed draft", "canonical", "ready"), false);
  assert.equal(isEditorTextSafeToFlush("canonical", "checkpointed draft", "canonical", "unavailable"), false);
  assert.equal(isEditorTextSafeToFlush("checkpointed draft", "checkpointed draft", "canonical", "pending"), true);
});

test("only an unchanged exact operation generation is cleared by a confirmed receipt", () => {
  const entry = { text: "published text", publicationBatchId: "batch-1", operation: { id: "operation-1", generation: 4 } };
  const confirmed = [{ batchId: "batch-1", state: "confirmed", acknowledged: [{ operationId: "operation-1", generation: 4 }] }];
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "published text", confirmed), true);
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "newer unjournaled text", confirmed), false);
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "published text", [
    { batchId: "batch-1", state: "publication_unknown", acknowledged: [{ operationId: "operation-1", generation: 4 }] },
  ]), false);
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "published text", [
    { batchId: "batch-1", state: "confirmed", acknowledged: [{ operationId: "operation-1", generation: 5 }] },
    { batchId: "batch-1", state: "confirmed", acknowledged: [{ operationId: "another-operation", generation: 4 }] },
  ]), false);
  assert.equal(isEntryAcknowledgedByReceipt(entry, {
    batchId: "another-batch", state: "confirmed", acknowledged: [{ operationId: "operation-1", generation: 4 }],
  }), false);
  assert.equal(isNonDraftEntryAcknowledgedByReceipt({ ...entry, state: "publication_unknown" }, confirmed[0]!), true);
  assert.equal(isNonDraftEntryAcknowledgedByReceipt({ ...entry, state: "draft" }, confirmed[0]!), false);
});

test("the editor is writable only after its selected scene recovery is ready", () => {
  const ready = {
    hasWritePermission: true,
    recoveryStatus: "ready" as const,
    loadingScene: false,
    selectedSceneId: "scene-1",
    editorSceneId: "scene-1",
  };
  assert.equal(mayWriteEditor(ready), true);
  assert.equal(mayWriteEditor({ ...ready, recoveryStatus: "pending" }), false);
  assert.equal(mayWriteEditor({ ...ready, recoveryStatus: "unavailable" }), false);
  assert.equal(mayWriteEditor({ ...ready, loadingScene: true }), false);
  assert.equal(mayWriteEditor({ ...ready, selectedSceneId: "scene-2" }), false);
  assert.equal(mayWriteEditor({ ...ready, hasWritePermission: false }), false);
});

test("a recovered editor remains writable only for a background refresh of its current scene identity", () => {
  const sameScene = {
    currentProjectId: "project-1",
    requestedProjectId: "project-1",
    currentRepositoryMatches: true,
    currentAuthorScopeMatches: true,
    selectedSceneId: "scene-1",
    requestedSceneId: "scene-1",
    editorSceneId: "scene-1",
    recoveryStatus: "ready" as const,
    editorRecoveryStatus: "ready" as const,
  };
  assert.equal(isSameSceneEditorLoad(sameScene), true);
  const keepWritable = canRetainRecoveredEditorDuringSceneLoad(sameScene);
  assert.equal(keepWritable, true);
  assert.equal(mayWriteEditor({
    hasWritePermission: true,
    recoveryStatus: sameScene.recoveryStatus,
    loadingScene: !keepWritable,
    selectedSceneId: sameScene.selectedSceneId,
    editorSceneId: sameScene.editorSceneId,
  }), true);

  assert.equal(isSameSceneEditorLoad({ ...sameScene, requestedSceneId: "scene-2" }), false);
  assert.equal(isSameSceneEditorLoad({ ...sameScene, currentProjectId: "project-2" }), false);
  assert.equal(isSameSceneEditorLoad({ ...sameScene, currentRepositoryMatches: false }), false);
  assert.equal(isSameSceneEditorLoad({ ...sameScene, currentAuthorScopeMatches: false }), false);
  assert.equal(isSameSceneEditorLoad({ ...sameScene, editorSceneId: undefined }), false);
  assert.equal(canRetainRecoveredEditorDuringSceneLoad({ ...sameScene, recoveryStatus: "pending" }), false);
  assert.equal(canRetainRecoveredEditorDuringSceneLoad({ ...sameScene, editorRecoveryStatus: "unavailable" }), false);
});

test("a failed IndexedDB open is unavailable from project activation through scene loading", () => {
  const failedOpen = recoveryStatusForJournalOpen("IndexedDB is unavailable");
  assert.equal(failedOpen, "unavailable");
  assert.equal(mayWriteEditor({
    hasWritePermission: true,
    recoveryStatus: failedOpen,
    loadingScene: false,
    selectedSceneId: "scene-1",
    editorSceneId: "scene-1",
  }), false);
  assert.equal(recoveryStatusForJournalOpen(""), "pending");
});

test("a local draft merge replaces only older drafts for the same author and document", () => {
  const priorDraft = draftEntry();
  const otherDocument = draftEntry({ documentKey: "repository/scene-2" });
  const foreignAuthor = draftEntry({ authorScope: "author-2" });
  const protectedConflict = draftEntry({ state: "conflict", operation: { generation: 0 } });
  const savedDraft = draftEntry({ operation: { generation: 2 } });

  assert.deepEqual(mergeLatestDraftEntry([priorDraft, otherDocument, foreignAuthor, protectedConflict], savedDraft), [
    otherDocument,
    foreignAuthor,
    protectedConflict,
    savedDraft,
  ]);
});

test("a stale local save cannot replace a newer generation or clear an exact conflict", () => {
  const savedDraft = draftEntry({ operation: { generation: 2 } });
  const newerDraft = draftEntry({ operation: { generation: 3 } });
  const exactConflict = draftEntry({ state: "conflict", operation: { generation: 2 } });

  const newerEntries = [newerDraft];
  assert.equal(mergeLatestDraftEntry(newerEntries, savedDraft), newerEntries);
  const conflictedEntries = [exactConflict];
  assert.equal(mergeLatestDraftEntry(conflictedEntries, savedDraft), conflictedEntries);
});
