import assert from "node:assert/strict";
import test from "node:test";
import { AuthoringError } from "../../authoring/types.js";
import { thrownResponse } from "./runtime.js";

test("guest Host continuations preserve file and recovery errors instead of reporting unavailable", () => {
  for (const code of ["file_not_found", "storage_unknown", "conflict", "dirty_draft", "invalid_encoding", "unsupported_format", "idempotency_conflict", "invalid_path", "plugin_unavailable"]) {
    assert.deepEqual(thrownResponse(new AuthoringError(code, "Exact Host explanation", false)), {
      code, message: "Exact Host explanation", retryable: false,
    });
  }
  assert.equal(thrownResponse(new AuthoringError("<invalid-code>", "Rejected code")).code, "unavailable");
  assert.equal(thrownResponse(new AuthoringError("timeout", "Do not automatically retry", false)).retryable, false);
});
