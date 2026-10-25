import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPluginManager, MemoryPluginStore, PluginManagerError } from "./index.js";
import { encodeBase64, satisfiesVersion } from "./registry.js";

const registryUrl = "https://registry.example.test/registry.json";
const artifactBase = "https://assets.example.test/plugins/";
const approvedOrigins = [new URL(artifactBase).origin];
const rawComponent = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

async function digest(bytes: Uint8Array): Promise<string> {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(result, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture() {
  const registryKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publisherKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const registryPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", registryKeys.publicKey));
  const publisherKey = new Uint8Array(await crypto.subtle.exportKey("raw", publisherKeys.publicKey));
  const content = new Map<string, Uint8Array>();
  const plugins: Array<Record<string, unknown>> = [];

  async function addPlugin(id: string, version: string, dependencies: unknown[] = []) {
    const entrypoint = `${id}/${version}/${await digest(rawComponent)}/plugin.wasm`;
    const manifest = {
      schema: "proprium.plugin/v1", id, version, abi: "proprium.component/v1", entrypoint,
      capabilities: [],
      artifacts: [{ path: entrypoint, bytes: rawComponent.byteLength, sha256: await digest(rawComponent), mediaType: "application/wasm" }],
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestSignature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, publisherKeys.privateKey, manifestBytes));
    const manifestSha256 = await digest(manifestBytes);
    const manifestPath = `${id}/${version}/manifest/${manifestSha256}.json`;
    content.set(new URL(manifestPath, artifactBase).href, manifestBytes);
    content.set(new URL(entrypoint, artifactBase).href, rawComponent);
    plugins.push({
      id, version, manifestPath, manifestSha256,
      manifestSignature: encodeBase64(manifestSignature), publisherKey: encodeBase64(publisherKey), dependencies,
    });
  }

  await addPlugin("example.math", "1.0.0");
  await addPlugin("example.math", "1.2.0");
  await addPlugin("example.calc", "1.0.0", [{ id: "example.math", range: "^1.0.0" }]);
  await addPlugin("example.calc", "1.1.0", [{ id: "example.math", range: "^1.0.0" }]);
  await addPlugin("example.loop-a", "1.0.0", [{ id: "example.loop-b", range: "1.0.0" }]);
  await addPlugin("example.loop-b", "1.0.0", [{ id: "example.loop-a", range: "1.0.0" }]);
  const registryBytes = new TextEncoder().encode(JSON.stringify({
    schema: "proprium.registry/v1", id: "example.public", version: "1.0.0", artifactBase, plugins,
  }));
  const registrySignature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, registryKeys.privateKey, registryBytes));
  content.set(registryUrl, registryBytes);
  content.set(`${registryUrl}.sig`, registrySignature);
  async function publishRegistry(versions: readonly string[]) {
    const registryBytes = new TextEncoder().encode(JSON.stringify({
      schema: "proprium.registry/v1", id: "example.public", version: versions.includes("1.1.0") ? "1.1.0" : "1.0.0", artifactBase,
      plugins: plugins.filter(plugin => versions.includes(String(plugin.version))),
    }));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, registryKeys.privateKey, registryBytes));
    content.set(registryUrl, registryBytes);
    content.set(`${registryUrl}.sig`, signature);
  }
  const fetcher: typeof fetch = async (input) => {
    const bytes = content.get(String(input));
    return bytes ? new Response(Uint8Array.from(bytes), { status: 200 }) : new Response("missing", { status: 404 });
  };
  const store = new MemoryPluginStore();
  const manager = new BrowserPluginManager({
    registries: [{ url: registryUrl, publicKey: registryPublicKey, artifactOrigins: approvedOrigins }],
    fetcher, store,
  });
  return { manager, store, fetcher, registryPublicKey, publishRegistry, content };
}

test("plugin distribution pins signed versions and resolves dependencies", async () => {
  const { manager } = await fixture();
  const installPlan = await manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" });
  assert.equal(installPlan.downloadBytes, rawComponent.byteLength * 2);
  assert.deepEqual(installPlan.packages.map(item => item.capabilities), [[], []]);
  let plugins = await manager.installFromRegistry(installPlan);
  assert.deepEqual(plugins.map(plugin => `${plugin.id}@${plugin.version}`), ["example.calc@1.0.0", "example.math@1.2.0"]);
  assert.deepEqual(plugins[0]!.dependencies, [{ id: "example.math", range: "^1.0.0", version: "1.2.0" }]);
  assert.equal(plugins[0]!.activeVersion, "1.0.0");
  await manager.enable({ pluginId: "example.calc", version: "1.0.0", workspaceId: "workspace", grants: [], hostAllowed: [] });
  assert.equal((await manager.installed()).find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.state, "enabled-idle");
  await manager.disable("example.calc", "1.0.0");
  assert.equal((await manager.installed()).find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.state, "installed");

  const updatePlan = await manager.previewUpdate({ registryUrl, pluginId: "example.calc", version: "1.1.0" });
  plugins = await manager.update(updatePlan);
  assert.equal(plugins.find(plugin => plugin.id === "example.calc" && plugin.version === "1.1.0")?.activeVersion, "1.1.0");
  plugins = await manager.rollback("example.calc");
  assert.equal(plugins.find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.activeVersion, "1.0.0");

  await assert.rejects(manager.uninstall("example.math", "1.2.0"), (error: unknown) => error instanceof PluginManagerError && error.code === "dependency_in_use");
  await manager.uninstall("example.calc", "1.1.0");
  await manager.uninstall("example.calc", "1.0.0");
  await manager.uninstall("example.math", "1.2.0");
  assert.deepEqual(await manager.installed(), []);
});

test("registry signatures, publisher keys, manifest hashes and artifact digests fail closed", async () => {
  const { manager, store, fetcher } = await fixture();
  await manager.installFromRegistry(await manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" }));
  const records = await store.listPlugins();
  const tampered = records.find(record => record.id === "example.calc")!;
  tampered.artifacts[0]!.bytes[0] ^= 1;
  await store.putPlugins([tampered]);
  await assert.rejects(manager.previewInstall({ registryUrl, pluginId: tampered.id, version: tampered.version }),
    (error: unknown) => error instanceof Error && /digest|artifact/i.test(error.message));

  const unsigned = new BrowserPluginManager({
    registries: [{ url: registryUrl, publicKey: new Uint8Array(32), artifactOrigins: approvedOrigins }], fetcher,
    store: new MemoryPluginStore(),
  });
  await assert.rejects(unsigned.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" }));
});

test("dependency version ranges are deterministic and reject unsupported syntax", () => {
  assert.equal(satisfiesVersion("1.8.0", "^1.0.0"), true);
  assert.equal(satisfiesVersion("2.0.0", "^1.0.0"), false);
  assert.equal(satisfiesVersion("1.8.0", "~1.2.0"), false);
  assert.equal(satisfiesVersion("1.2.9", "~1.2.0"), true);
  assert.equal(satisfiesVersion("1.2.0", "../1.2.0"), false);
  assert.equal(satisfiesVersion("1.2.3-beta.1", "^1.0.0"), false);
  assert.equal(satisfiesVersion("1.2.3-beta.1", "^1.2.3-beta.0"), true);
});

test("a failed update keeps the current pin, while the latest signed index can revoke an old version", async () => {
  const { manager, publishRegistry, content } = await fixture();
  const firstPlan = await manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" });
  await manager.installFromRegistry(firstPlan);
  const failedUpdate = await manager.previewUpdate({ registryUrl, pluginId: "example.calc", version: "1.1.0" });
  content.delete(new URL(`example.calc/1.1.0/${await digest(rawComponent)}/plugin.wasm`, artifactBase).href);
  await assert.rejects(manager.update(failedUpdate));
  assert.equal((await manager.installed()).find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.activeVersion, "1.0.0");

  await publishRegistry(["1.2.0", "1.1.0"]);
  await manager.installFromRegistry(await manager.previewInstall({ registryUrl, pluginId: "example.math", version: "1.2.0" }));
  const listed = await manager.installed();
  assert.equal(listed.find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.state, "revoked");
  await assert.rejects(manager.enable({ pluginId: "example.calc", version: "1.0.0", workspaceId: "workspace", grants: [], hostAllowed: [] }));
});

test("dependency cycles fail closed and revoked transitive dependencies block activation", async () => {
  const cycle = await fixture();
  await assert.rejects(cycle.manager.previewInstall({ registryUrl, pluginId: "example.loop-a", version: "1.0.0" }), /cycle/i);

  const closure = await fixture();
  await closure.manager.installFromRegistry(await closure.manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" }));
  await closure.publishRegistry(["1.0.0", "1.1.0"]);
  await assert.rejects(closure.manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.1.0" }), /revoked/i);
  await assert.rejects(closure.manager.enable({ pluginId: "example.calc", version: "1.0.0", workspaceId: "workspace", grants: [], hostAllowed: [] }), /revoked/i);
});
