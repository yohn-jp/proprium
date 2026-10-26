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

const v2 = (value: Record<string, unknown>) => {
  value.schema = "proprium.plugin/v2"; value.abi = "proprium.component/v2";
  const shape = { type: "object", properties: { text: { type: "string", maxLength: 100 } }, required: ["text"], additionalProperties: false };
  value.actions = [{ plugin_id: value.id, action_id: "search.query", schema_version: 1, effect: "read",
    input_schema: shape, output_schema: shape, required_capabilities: ["workspace.snapshot.read"],
    callers: ["ui", "mcp", "plugin"], requires_user_gesture: false }];
  value.ui = [{ id: "search", kind: "panel", title: "Search", context: {}, body: { id: "query", type: "form",
    fields: [{ id: "text", type: "string", label: "Query", max_length: 100 }],
    submit: { action_id: "search.query", input_template: { text: { data_key: "form.text" } } } } }];
  value.asset_groups = [];
};
test("v2 signed declarations are admitted and deeply immutable without guest activation", async () => {
  const { raw, wasm, policy } = await fixture(v2);
  const manifest = await admitPluginManifest(raw, policy);
  assert.equal(manifest.schema, "proprium.plugin/v2");
  if (manifest.schema !== "proprium.plugin/v2") assert.fail("Expected v2");
  assert.equal(manifest.actions[0]!.action_id, "search.query");
  assert.ok(Object.isFrozen(manifest.actions[0]!.input_schema));
  await verifyPluginArtifact(manifest, "dist/plugin.wasm", wasm);
  await assert.rejects(verifyPluginArtifact({ ...manifest }, "dist/plugin.wasm", wasm), rejected("untrusted_publisher"));
});
test("v2 rejects undeclared bindings, spoofed caller policy and version confusion", async () => {
  const patches = [
    (x: Record<string, unknown>) => { x.abi = "proprium.component/v1"; },
    (x: Record<string, unknown>) => { (x.actions as Record<string, unknown>[])[0]!.callers = ["owner"]; },
    (x: Record<string, unknown>) => { (x.actions as Record<string, unknown>[])[0]!.required_capabilities = ["credentials.read"]; },
    (x: Record<string, unknown>) => { (x.ui as { body: { submit: { action_id: string } } }[])[0]!.body.submit.action_id = "unknown"; },
    (x: Record<string, unknown>) => { x.extra = true; },
  ];
  for (const patch of patches) {
    const { raw, policy } = await fixture(value => { v2(value); patch(value); });
    await assert.rejects(admitPluginManifest(raw, policy), rejected("invalid_manifest"));
  }
});
