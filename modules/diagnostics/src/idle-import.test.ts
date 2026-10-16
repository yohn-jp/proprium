import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("public NLP and diagnostics module imports do not load Lindera in the parent process", () => {
  const probe = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/no-parent-model.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});
