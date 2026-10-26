import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { createWorkspaceArchive, documentPath, readWorkspaceArchive, validateTransferFiles } from "./workspace-transfer.js";

test("ZIP transfer preserves nested Unicode paths, empty files and binary bytes", () => {
  const files = [{ path: "原稿/第一章.md", data: new TextEncoder().encode("灯里は歩き出した。\r\n") }, { path: "images/raw.bin", data: new Uint8Array([0, 255, 13, 10]) }, { path: "empty.txt", data: new Uint8Array() }];
  assert.deepEqual(readWorkspaceArchive(createWorkspaceArchive(files)), files);
});
test("ZIP imports reject traversal and Git internals rather than extracting them", () => {
  for (const path of ["../outside.md", "/absolute.md", ".git/config", "a/../b.md", "a\\b.md"]) {
    assert.throws(() => readWorkspaceArchive(zipSync({ [path]: new Uint8Array([1]) })));
  }
});
test("ZIP import rejects advertised expansion over the workspace budget before extraction", () => {
  const zip = zipSync({ "large.txt": new Uint8Array([1]) }, { level: 0 });
  const data = new DataView(zip.buffer);
  for (let i = 0; i < zip.length - 24; i++) if (data.getUint32(i, true) === 0x02014b50) data.setUint32(i + 24, 65 * 1024 * 1024, true);
  assert.throws(() => readWorkspaceArchive(zip), /64 MiB/u);
});
test("transfer refuses empty/oversized batches and duplicate paths", () => {
  assert.throws(() => validateTransferFiles([]));
  assert.throws(() => validateTransferFiles(Array.from({ length: 257 }, (_, i) => ({ path: `f${i}`, data: new Uint8Array() }))));
  assert.throws(() => validateTransferFiles([{ path: "a", data: new Uint8Array() }, { path: "a", data: new Uint8Array() }]), /同じパス/u);
});
test("document names default to Markdown without imposing a narrative hierarchy", () => {
  assert.equal(documentPath("第一章"), "第一章.md");
  assert.equal(documentPath("notes.txt"), "notes.txt");
  assert.equal(documentPath("assets/raw", true), "assets/raw");
  assert.throws(() => documentPath(""));
  assert.throws(() => documentPath("../escape"));
});
