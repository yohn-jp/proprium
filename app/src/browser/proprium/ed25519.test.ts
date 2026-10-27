import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyEd25519 } from "./ed25519.js";

test("strict Ed25519 verifies exact large messages across the native WebKit failure boundary", () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = new Uint8Array(key.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  for (const length of [0, 65472, 65475, 65520, 65536, 512 * 1024]) {
    const message = new Uint8Array(length).fill(173);
    const signature = new Uint8Array(sign(null, message, key.privateKey));
    assert.equal(verifyEd25519(message, signature, publicKey), true, String(length));
    const damaged = signature.slice(); damaged[0] = damaged[0]! ^ 1;
    assert.equal(verifyEd25519(message, damaged, publicKey), false);
    if (length) { message[length - 1] = 0; assert.equal(verifyEd25519(message, signature, publicKey), false); }
    const noncanonical = signature.slice();
    const order = (1n << 252n) + 27742317777372353535851937790883648493n;
    let scalar = 0n;
    for (let i = 63; i >= 32; i--) scalar = (scalar << 8n) | BigInt(signature[i]!);
    scalar += order;
    for (let i = 32; i < 64; i++) { noncanonical[i] = Number(scalar & 255n); scalar >>= 8n; }
    assert.equal(verifyEd25519(message, noncanonical, publicKey), false);
  }
});

test("strict Ed25519 rejects small-order forgeries and malformed key or signature lengths", () => {
  const identity = new Uint8Array(32); identity[0] = 1;
  const forged = new Uint8Array(64); forged[0] = 1;
  assert.equal(verifyEd25519(new Uint8Array(), forged, identity), false);
  assert.equal(verifyEd25519(new Uint8Array(), new Uint8Array(63), identity), false);
  assert.equal(verifyEd25519(new Uint8Array(), forged, new Uint8Array(31)), false);
});
