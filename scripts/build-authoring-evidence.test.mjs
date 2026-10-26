import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const ledgerPath = resolve(root, "evidence/authoring/implementation.json");
const command = resolve(root, "scripts/build-authoring-evidence.mjs");
test("evidence ledger covers every current canon feature and source contribution", async () => {
  const checked = spawnSync(process.execPath, [command, "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.matrix.length, 14);
  assert.equal(ledger.plugins.reduce((total, plugin) => total + plugin.features.length, 0), 114);
  assert.equal(ledger.recovered_source.source_actions.length, 136);
  assert.equal(ledger.recovered_source.ui_contributions.length, 42);
  assert.equal(ledger.recovered_source.source_tools.length, 33);
  assert.ok(ledger.matrix.every(item => item.status === "NOT_CHECKED"));
});
test("evidence validator rejects invented or missing source-parity rows", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "proprium-authoring-evidence-"));
  const path = resolve(directory, "ledger.json");
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.recovered_source.ui_contributions.pop();
    await writeFile(path, JSON.stringify(ledger));
    const checked = spawnSync(process.execPath, [command, "--validate", path], { cwd: root, encoding: "utf8" });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /source parity rows differ/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("evidence validator refuses PASS without signed artifact identity and archived run evidence", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "proprium-authoring-evidence-"));
  const path = resolve(directory, "ledger.json");
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const feature = ledger.plugins[0].features[0];
    Object.assign(feature, { status: "PASS", fixture: "synthetic", command: "pnpm test", git_sha: "a".repeat(40),
      browser_platform: "Chromium", input: "fixture", output: "result", receipt: "receipt", evidence_ref: "https://ci.example/run/1",
      source_revisions: ["b".repeat(40)], artifact: null });
    await writeFile(path, JSON.stringify(ledger));
    const checked = spawnSync(process.execPath, [command, "--validate", path], { cwd: root, encoding: "utf8" });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /actual signed artifact and registry digests/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
