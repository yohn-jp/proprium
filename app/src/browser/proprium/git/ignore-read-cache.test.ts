import assert from "node:assert/strict";
import test from "node:test";
import { createIgnoreReadCache } from "./ignore-read-cache.js";

test("one ignore-rule scan shares successful and missing lookups without caching future generations", async () => {
  let calls = 0;
  let rules = "drafts/";
  const source = { async readFile(path: string) { calls++; if (path.endsWith("missing")) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return rules; } };
  const transaction = createIgnoreReadCache(source);
  assert.deepEqual(await Promise.all([transaction.readFile(".gitignore"), transaction.readFile(".gitignore")]), [rules, rules]);
  await assert.rejects(transaction.readFile("missing"));
  await assert.rejects(transaction.readFile("missing"));
  assert.equal(calls, 2);
  rules = "cache/";
  assert.equal(await createIgnoreReadCache(source).readFile(".gitignore"), "cache/");
  assert.equal(calls, 3);
});
