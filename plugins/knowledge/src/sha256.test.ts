import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "./sha256.js";

test("pure SHA-256 matches empty, ASCII and multibyte vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("灯😀"), "cd1c36862a0000fea42408afad0f8797ac83f8c51f3ad65f334337da5db3465f");
});
