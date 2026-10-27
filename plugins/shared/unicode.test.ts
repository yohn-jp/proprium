import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUnicode } from "./unicode.js";

test("normalizes Japanese, compatibility forms, Hangul and supplementary text", () => {
  assert.equal(normalizeUnicode("ｶﾞＡ", "NFKC"), "ガA");
  assert.equal(normalizeUnicode("が", "NFD"), "か\u3099");
  assert.equal(normalizeUnicode("가", "NFD"), "\u1100\u1161");
  assert.equal(normalizeUnicode("\u1100\u1161", "NFC"), "가");
  assert.equal(normalizeUnicode("🌸\ud800Ａ", "NFKC"), "🌸\ud800A");
  assert.equal(normalizeUnicode("\u212B", "NFKD"), "A\u030A");
});

test("does not replace native normalization and works when it is absent", () => {
  const original = Object.getOwnPropertyDescriptor(String.prototype, "normalize")!;
  const native = String.prototype.normalize;
  assert.equal(normalizeUnicode("Ａ", "NFKC"), "A");
  assert.equal(String.prototype.normalize, native);
  try {
    delete (String.prototype as { normalize?: unknown }).normalize;
    assert.equal(normalizeUnicode("ｶﾞ", "NFKC"), "ガ");
  } finally { Object.defineProperty(String.prototype, "normalize", original); }
});

test("invalid normalization forms throw RangeError", () => {
  assert.throws(() => normalizeUnicode("text", "bad" as never), RangeError);
});
