import assert from "node:assert/strict";
import test from "node:test";
import { isTextRepresentedByRecoveryRecord } from "./recovery.js";

test("text is recoverable only when the current record represents the editor", () => {
  assert.equal(isTextRepresentedByRecoveryRecord("clean", null, "clean"), true);
  assert.equal(isTextRepresentedByRecoveryRecord("draft", "draft", "clean"), true);
  assert.equal(isTextRepresentedByRecoveryRecord("new input", "older draft", "clean"), false);
  assert.equal(isTextRepresentedByRecoveryRecord("new input", null, "clean"), false);
});
