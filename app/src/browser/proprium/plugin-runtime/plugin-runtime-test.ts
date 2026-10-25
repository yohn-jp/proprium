import { admitPluginManifest } from "../plugin-artifact.js";
import { BrowserPluginRuntime } from "./runtime.js";
import { CAPABILITIES, type RuntimeSnapshot } from "./protocol.js";

declare global {
  interface Window {
    pluginRuntimeTest: { execute(scenario: "success" | "denied" | "hang" | "trap" | "tampered" | "unknown-capability"): Promise<unknown> };
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}

async function execute(bytes: Uint8Array, scenario: "success" | "denied" | "hang" | "trap" | "tampered" | "unknown-capability"): Promise<unknown> {
  const raw = new TextEncoder().encode(JSON.stringify({
    schema: "proprium.plugin/v1", id: "example.runtime", version: "1.0.0", abi: "proprium.component/v1",
    entrypoint: "dist/plugin.component.wasm",
    capabilities: scenario === "unknown-capability" ? ["workspace.unknown.use"] : [...CAPABILITIES],
    artifacts: [{ path: "dist/plugin.component.wasm", bytes: bytes.byteLength, sha256: await sha256(bytes), mediaType: "application/wasm" }],
  }));
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const trustedPublisherKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, raw));
  const manifest = await admitPluginManifest(raw, {
    expectedPluginId: "example.runtime", expectedSha256: await sha256(raw), trustedPublisherKey, signature,
  });
  const input = bytes.slice();
  if (scenario === "tampered") input[input.length - 1] ^= 1;
  let runtime: BrowserPluginRuntime;
  try { runtime = await BrowserPluginRuntime.create(manifest, input); }
  catch (error) { return { code: (error as { code?: string }).code ?? "unknown", workerCreated: false }; }

  await runtime.start({ context: { pluginId: manifest.id, version: manifest.version, workspaceId: "browser-plugin-workspace" }, deadlineMs: 30_000 });
  const snapshot: RuntimeSnapshot = { id: "snapshot-1", revision: "commit-1" };
  const request = JSON.stringify({ hang: scenario === "hang", read: scenario === "denied", trap: scenario === "trap" });
  try {
    const result = await runtime.invoke({ snapshot, request, deadlineMs: scenario === "hang" ? 150 : 15_000 });
    await runtime.stop();
    return { result, state: runtime.state };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown";
    const state = runtime.state;
    if (state === "active") await runtime.stop();
    return { code, state };
  }
}

const fixture = fetch("/plugin-runtime-fixture.wasm").then(async response => {
  if (!response.ok) throw new Error("Plugin component fixture is unavailable");
  return new Uint8Array(await response.arrayBuffer());
});
window.pluginRuntimeTest = { execute: async scenario => execute(await fixture, scenario) };
document.querySelector("#ready")!.textContent = "ready";
