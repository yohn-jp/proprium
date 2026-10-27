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

test("a workspace at the 64 MiB content limit can import its own exported ZIP", () => {
  const bytes = new Uint8Array(64 * 1024 * 1024);
  bytes[0] = 17; bytes[bytes.length - 1] = 29;
  const archive = createWorkspaceArchive([{ path: "at-limit.bin", data: bytes }]);
  assert.ok(archive.byteLength > bytes.byteLength);
  const [restored] = readWorkspaceArchive(archive);
  assert.equal(restored!.data.byteLength, bytes.byteLength);
  assert.equal(restored!.data[0], 17);
  assert.equal(restored!.data[restored!.data.length - 1], 29);
});

test("ZIP rejects a forged smaller uncompressed size rather than importing truncated text", () => {
  const zip = zipSync({ "chapter.md": new TextEncoder().encode("The remaining content must survive") }, { level: 0 });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i < zip.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) {
    view.setUint32(i + 24, 3, true);
    break;
  }
  assert.throws(() => readWorkspaceArchive(zip), /破損/u);
});

test("ZIP preserves a literal __proto__ filename without prototype mutation", () => {
  const file = { path: "__proto__", data: new TextEncoder().encode("literal file content") };
  const archive = createWorkspaceArchive([file]);
  assert.deepEqual(readWorkspaceArchive(archive), [file]);
  assert.equal(Object.prototype.hasOwnProperty.call({}, "__proto__"), false);
});
