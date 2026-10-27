import { ed25519 } from "@noble/curves/ed25519.js";

/** Strict RFC 8032 verification of exact signed bytes, including large manifests.
 * WebKit's libgcrypt Ed25519 path can abort the process around 64 KiB; use the
 * pinned portable verifier consistently rather than invoking that native path.
 */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.byteLength !== 64 || publicKey.byteLength !== 32) return false;
  try { return ed25519.verify(signature, message, publicKey, { zip215: false }); }
  catch { return false; }
}
