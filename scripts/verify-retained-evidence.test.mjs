import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const migration = resolve(root, "evidence/migration");
test("closed migration campaign retains every referenced acceptance record", async () => {
  const campaign = JSON.parse(await readFile(resolve(migration, "docs/migration/CAMPAIGN.json"), "utf8"));
  assert.equal(campaign.status, "complete");
  for (const task of campaign.tasks) {
    for (const proof of task.proofs ?? []) {
      assert.match(proof, /^docs\/(?:migration|verification)\/[A-Za-z0-9./_-]+$/u);
      assert.ok(!proof.split("/").includes(".."));
      assert.equal((await stat(resolve(migration, proof))).isFile(), true, task.id + ": " + proof);
    }
  }
});
test("published performance archive retains its complete immutable manifest", async () => {
  const evidenceRoot = resolve(root, "evidence/performance/wave0");
  const manifest = JSON.parse(await readFile(resolve(evidenceRoot, "INDEX.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.match(manifest.storage.url, /^https:\/\/github\.com\/yohn-jp\/scriptorium\/releases\/download\//u);
  assert.match(manifest.storage.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0);
  assert.equal(new Set(manifest.artifacts.map(x => x.file)).size, manifest.artifacts.length);
  for (const member of manifest.artifacts) {
    assert.match(member.sha256, /^[a-f0-9]{64}$/u);
    assert.match(member.gzipSha256, /^[a-f0-9]{64}$/u);
  }
});
