import type { ActionRequest } from "../../authoring/types.js";
import { verifyPluginArtifact, type PluginManifestV2 } from "../../plugin-artifact.js";
import { admitRegistry, admitRegistryManifest, registryManifestEntry } from "../../plugins/registry.js";
import { BrowserAuthoringPluginRuntime } from "./runtime.js";

interface BrowserFixture {
  registryBytes: string;
  registrySignature: string;
  manifestBytes: string;
  componentPath: string;
}
interface FixtureFilePage { entries: Array<{ path: string; revision: string; byte_length: number; media_type: string }>; next_cursor: string | null }
interface FixtureChunk { revision: string; total_bytes: number; offset: number; bytes: number[]; next_offset: number | null }

const fixturePluginId = "proprium.diagnostics";
const fixtureActionId = "proprium.diagnostics.pages.read";

declare global {
  interface Window {
    __pluginRuntimeV2PinnedRegistryKey?: string;
    pluginRuntimeV2Test: {
      execute(scenario: "success" | "snapshot-stale" | "tampered-component" | "invalid-registry-signature"): Promise<unknown>;
    };
  }
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function admitFixture(fixture: BrowserFixture): Promise<{ manifest: PluginManifestV2 }> {
  const pinnedKey = window.__pluginRuntimeV2PinnedRegistryKey;
  if (!pinnedKey) throw new Error("test registry key is not pinned by the browser harness");
  const registry = await admitRegistry(fromBase64(fixture.registryBytes), fromBase64(fixture.registrySignature), {
    url: "http://127.0.0.1:4173/plugin-runtime-v2/registry.json",
    publicKey: fromBase64(pinnedKey),
    artifactOrigins: ["http://127.0.0.1:4173"],
  });
  if (registry.document.plugins.length !== 8) throw new Error("synthetic fixture registry is incomplete");
  const entry = registryManifestEntry(registry, fixturePluginId, "1.0.0");
  if (!entry) throw new Error("signed test release is not in the registry");
  const admitted = await admitRegistryManifest(fromBase64(fixture.manifestBytes), entry);
  if (admitted.schema !== "proprium.plugin/v2") throw new Error("signed test manifest is not v2");
  const manifest: PluginManifestV2 = admitted;
  if (manifest.id !== fixturePluginId || manifest.entrypoint !== fixture.componentPath) {
    throw new Error("signed manifest identity or entrypoint rejected");
  }
  return { manifest };
}

async function execute(scenario: "success" | "snapshot-stale" | "tampered-component" | "invalid-registry-signature"): Promise<unknown> {
  const response = await fetch("/plugin-runtime-v2-fixture.json");
  if (!response.ok) throw new Error("v2 signed registry fixture is unavailable");
  const fixture = await response.json() as BrowserFixture;
  if (scenario === "invalid-registry-signature") fixture.registrySignature = btoa(String.fromCharCode(...new Uint8Array(64)));
  let admitted: Awaited<ReturnType<typeof admitFixture>>;
  try { admitted = await admitFixture(fixture); }
  catch (error) {
    if (scenario === "invalid-registry-signature" && (error as { code?: string }).code === "invalid_signature") {
      return { code: "untrusted_registry" };
    }
    throw error;
  }

  const componentResponse = await fetch("/plugin-runtime-v2-fixture.wasm");
  if (!componentResponse.ok) throw new Error("v2 WASM fixture is unavailable");
  const component = new Uint8Array(await componentResponse.arrayBuffer());
  if (scenario === "tampered-component") component[component.length - 1] ^= 1;
  const runtime = await BrowserAuthoringPluginRuntime.create(admitted.manifest, component, verifyPluginArtifact);
  const pluginId = admitted.manifest.id;
  const workspaceId = "runtime-proof-workspace";
  const scope = { workspace_id: workspaceId, repository_id: 42, branch: "main", generation: "fixture-generation" };
  const snapshot = { id: "fixture-snapshot", local_commit: "commit-a", worktree_generation: scope.generation, draft_generation: null };
  const request: ActionRequest = {
    schema_version: 1,
    request_id: "runtime-proof-request",
    plugin_id: pluginId,
    action_id: fixtureActionId,
    scope,
    snapshot,
    input: { prefix: "fixture/" },
    deadline_ms: 15_000,
  };
  let current = true;
  const hostCalls: string[] = [];
  await runtime.start({
    context: { pluginId, version: admitted.manifest.version, workspaceId },
    user_grants: ["workspace.file.read"],
    host_allowed: ["workspace.file.read"],
  });
  try {
    const result = await runtime.invoke({
      request,
      caller: "ui",
      validate_schema: () => {},
      is_snapshot_current: () => current,
      resolve_host_call: async call => {
        hostCalls.push(call.operation);
        if (scenario === "snapshot-stale" && hostCalls.length === 1) current = false;
        if (call.operation === "workspace.file.list") {
          const cursor = call.payload.cursor;
          if (cursor === null) return {
            entries: [{ path: "fixture/chapter-1.md", revision: "a".repeat(64), byte_length: 18, media_type: "text/markdown" }],
            next_cursor: "fixture-cursor-2",
          } satisfies FixtureFilePage;
          return {
            entries: [{ path: "fixture/chapter-2.md", revision: "b".repeat(64), byte_length: 20, media_type: "text/markdown" }],
            next_cursor: null,
          } satisfies FixtureFilePage;
        }
        if (call.operation === "workspace.file.read") {
          const content = new TextEncoder().encode("雨が降った。\r\n");
          return { revision: "a".repeat(64), total_bytes: content.byteLength, offset: 0, bytes: [...content], next_offset: null } satisfies FixtureChunk;
        }
        throw Object.assign(new Error(`unexpected Host operation ${call.operation}`), { code: "capability_denied" });
      },
    });
    return { result, hostCalls, state: runtime.state };
  } catch (error) {
    if (scenario !== "snapshot-stale") throw error;
    return {
      result: { ok: false, error: { code: (error as { code?: string }).code ?? "unknown" } },
      hostCalls,
      state: runtime.state,
    };
  } finally {
    await runtime.stop();
  }
}

window.pluginRuntimeV2Test = { execute };
document.querySelector("#ready")!.textContent = "ready";
