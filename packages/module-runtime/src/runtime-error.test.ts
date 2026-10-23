import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_MODULE_IDS } from "@scriptorium/contracts";
import { isModuleId, MODULE_IDS } from "./runtime-error.js";

test("runtime module membership uses the canonical built-in IDs", () => {
  assert.strictEqual(MODULE_IDS, BUILTIN_MODULE_IDS);
  for (const id of BUILTIN_MODULE_IDS) assert.equal(isModuleId(id), true);
  for (const id of ["", "core", "unknown", "experimental"]) assert.equal(isModuleId(id), false);
});
