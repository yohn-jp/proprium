import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256, sha256Text } from "./sha256.js";

test("WASI-safe SHA-256 matches standard empty, short and Unicode vectors", () => {
  assert.equal(sha256(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Text("灯🌙"), "dffa3809eba6627c551b67de9c07746d271de310c5774c6439b61d35d02014f2");
});
