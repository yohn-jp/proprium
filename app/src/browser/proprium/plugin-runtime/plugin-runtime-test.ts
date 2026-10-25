import { admitPluginManifest } from "../plugin-artifact.js";
import { BrowserPluginRuntime } from "./runtime.js";
import { CAPABILITIES, type PluginCapability, type RuntimeSnapshot } from "./protocol.js";

declare global {
  interface Window {
    pluginRuntimeTest: {
      execute(scenario: "success" | "denied" | "stale" | "snapshot-advanced" | "snapshot-mutated-after-invoke" | "cancel" | "destroy" | "hang" | "trap" | "tampered" | "mutated-after-create" | "unadmitted-manifest" | "unknown-capability"): Promise<unknown>;
    };
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}

async function execute(bytes: Uint8Array, scenario: "success" | "denied" | "stale" | "snapshot-advanced" | "snapshot-mutated-after-invoke" | "cancel" | "destroy" | "hang" | "trap" | "tampered" | "mutated-after-create" | "unadmitted-manifest" | "unknown-capability"): Promise<unknown> {
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
  const admitted = scenario === "unadmitted-manifest" ? { ...manifest } : manifest;
  const creation = BrowserPluginRuntime.create(admitted, input);
  if (scenario === "mutated-after-create") input[input.length - 1] ^= 1;
  let runtime: BrowserPluginRuntime;
  try { runtime = await creation; }
  catch (error) { return { code: (error as { code?: string }).code ?? "unknown", workerCreated: false }; }

  const workspaceId = "browser-plugin-workspace";
  const userGrants: PluginCapability[] = scenario === "denied"
    ? ["workspace.change.propose", "workspace.ui.contribute"]
    : [...CAPABILITIES];
  await runtime.start({
    context: { pluginId: manifest.id, version: manifest.version, workspaceId },
    userGrants, hostAllowed: [...CAPABILITIES], deadlineMs: 30_000,
  });
  if (scenario === "destroy") { await runtime.destroy(); return { state: runtime.state }; }
  const snapshotFile = { path: "notes.md", revision: "revision-1", content: "before" };
  const snapshot: RuntimeSnapshot = {
    id: "snapshot-1", revision: "commit-1",
    files: [snapshotFile],
  };
  let liveSnapshotRevision = snapshot.revision;
  const isSnapshotCurrent = (id: string, revision: string) => id === snapshot.id && revision === liveSnapshotRevision;
  const request = scenario === "hang" || scenario === "cancel"
    ? { hang: true, path: "notes.md", content: "after", expectedRevision: "revision-1", snapshotId: snapshot.id, snapshotRevision: snapshot.revision }
    : {
        trap: scenario === "trap", path: "notes.md", content: "after", expectedRevision: "revision-1",
        snapshotId: scenario === "stale" ? "snapshot-old" : snapshot.id,
        snapshotRevision: snapshot.revision,
        delay: scenario === "snapshot-advanced",
      };
  try {
    if (scenario === "cancel") window.setTimeout(() => runtime.cancel(), 50);
    const invocation = runtime.invoke({ snapshot, isSnapshotCurrent, request: JSON.stringify(request), deadlineMs: scenario === "hang" ? 150 : 15_000 });
    if (scenario === "snapshot-advanced") window.setTimeout(() => { liveSnapshotRevision = "commit-2"; }, 0);
    if (scenario === "snapshot-mutated-after-invoke") {
      snapshotFile.revision = "caller-mutated";
      snapshotFile.content = "caller-mutated";
    }
    const result = await invocation;
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
