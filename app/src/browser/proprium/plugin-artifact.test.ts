import assert from "node:assert/strict";
import test from "node:test";
import { admitPluginManifest, PluginArtifactError, verifyPluginArtifact } from "./plugin-artifact";

const encoder = new TextEncoder();
const hash = async (content: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(content))), byte => byte.toString(16).padStart(2, "0")).join("");

async function fixture(patch?: (value: Record<string, unknown>) => void) {
  const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  const document: Record<string, unknown> = {
    schema: "proprium.plugin/v1", id: "example.search", version: "1.0.0", abi: "proprium.component/v1",
    entrypoint: "dist/plugin.wasm", capabilities: ["workspace.snapshot.read"],
    artifacts: [{ path: "dist/plugin.wasm", bytes: wasm.byteLength, sha256: await hash(wasm), mediaType: "application/wasm" }],
  };
  patch?.(document);
  const raw = encoder.encode(JSON.stringify(document));
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const trustedPublisherKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, raw));
  return { wasm, raw, policy: { expectedPluginId: "example.search", expectedSha256: await hash(raw), trustedPublisherKey, signature } };
}
function rejected(code: PluginArtifactError["code"]) {
  return (error: unknown): boolean => error instanceof PluginArtifactError && error.code === code;
}

test("a pinned publisher signature and digest admit one WASM artifact", async () => {
  const { wasm, raw, policy } = await fixture();
  const manifest = await admitPluginManifest(raw, policy);
  assert.equal(manifest.id, "example.search");
  await verifyPluginArtifact(manifest, "dist/plugin.wasm", wasm);
  await assert.rejects(verifyPluginArtifact(manifest, "dist/plugin.wasm", Uint8Array.of(0)), rejected("invalid_artifact"));
  await assert.rejects(verifyPluginArtifact(manifest, "another.wasm", wasm), rejected("invalid_artifact"));
});
test("manifest tampering is rejected before parsing", async () => {
  const { raw, policy } = await fixture(); raw[5] ^= 1;
  await assert.rejects(admitPluginManifest(raw, policy), rejected("digest_mismatch"));
});
test("untrusted, substituted and malformed signatures are rejected", async () => {
  const { raw, policy } = await fixture(); const another = await fixture();
  await assert.rejects(admitPluginManifest(raw, { ...policy, trustedPublisherKey: another.policy.trustedPublisherKey }), rejected("invalid_signature"));
  await assert.rejects(admitPluginManifest(raw, { ...policy, expectedPluginId: "other.search" }), rejected("untrusted_publisher"));
  await assert.rejects(admitPluginManifest(raw, { ...policy, signature: new Uint8Array(0) }), rejected("invalid_signature"));
});
test("a forged manifest object cannot bypass admission", async () => {
  const { wasm, raw, policy } = await fixture(); const manifest = await admitPluginManifest(raw, policy);
  await assert.rejects(verifyPluginArtifact({ ...manifest }, "dist/plugin.wasm", wasm), rejected("untrusted_publisher"));
});
test("unsafe paths, duplicate entries and unexpected ABI are rejected", async () => {
  const patches: Array<(value: Record<string, unknown>) => void> = [
    x => { x.entrypoint = "../escape.wasm"; },
    x => { x.capabilities = ["workspace.snapshot.read", "workspace.snapshot.read"]; },
    x => { x.artifacts = [...x.artifacts as unknown[], ...(x.artifacts as unknown[])]; },
    x => { (x.artifacts as Record<string, unknown>[])[0]!.path = "dist/../plugin.wasm"; },
    x => { (x.artifacts as Record<string, unknown>[])[0]!.bytes = 0; },
    x => { x.abi = "unknown"; },
  ];
  for (const patch of patches) {
    const { raw, policy } = await fixture(patch);
    await assert.rejects(admitPluginManifest(raw, policy), rejected("invalid_manifest"));
  }
});
test("same-length artifact corruption is rejected", async () => {
  const { raw, wasm, policy } = await fixture();
  const manifest = await admitPluginManifest(raw, policy);
  const altered = wasm.slice(); altered[0] = 1;
  await assert.rejects(verifyPluginArtifact(manifest, "dist/plugin.wasm", altered), rejected("digest_mismatch"));
});
