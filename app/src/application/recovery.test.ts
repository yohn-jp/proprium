import assert from "node:assert/strict";
import test from "node:test";
import { isTextRepresentedByRecoveryRecord, isUnchangedEntryConfirmedByReceipt } from "./recovery.js";

test("text is recoverable only when the current record represents the editor", () => {
  assert.equal(isTextRepresentedByRecoveryRecord("clean", null, "clean"), true);
  assert.equal(isTextRepresentedByRecoveryRecord("draft", "draft", "clean"), true);
  assert.equal(isTextRepresentedByRecoveryRecord("new input", "older draft", "clean"), false);
  assert.equal(isTextRepresentedByRecoveryRecord("new input", null, "clean"), false);
});

test("only an unchanged exact operation generation is cleared by a confirmed receipt", () => {
  const entry = { text: "published text", operation: { id: "operation-1", generation: 4 } };
  const confirmed = [{ state: "confirmed", acknowledged: [{ operationId: "operation-1", generation: 4 }] }];
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "published text", confirmed), true);
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "newer unjournaled text", confirmed), false);
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "published text", [
    { state: "publication_unknown", acknowledged: [{ operationId: "operation-1", generation: 4 }] },
  ]), false);
  assert.equal(isUnchangedEntryConfirmedByReceipt(entry, "published text", [
    { state: "confirmed", acknowledged: [{ operationId: "operation-1", generation: 5 }] },
    { state: "confirmed", acknowledged: [{ operationId: "another-operation", generation: 4 }] },
  ]), false);
});
