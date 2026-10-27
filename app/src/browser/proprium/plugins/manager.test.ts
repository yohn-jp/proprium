import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPluginManager, MemoryPluginStore, PluginManagerError, PluginRegistryError } from "./index.js";
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
  const requests: string[] = [];
  const plugins: Array<Record<string, unknown>> = [];
  let registryPatch = 0;

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

  async function addAuthoringPlugin(id: string, version: string, withAssetGroup = false) {
    const entrypoint = `${id}/${version}/${await digest(rawComponent)}/plugin.wasm`;
    const chunkBytes = Uint8Array.of(0, 1, 2, 3, 4, 5);
    const chunkSha256 = await digest(chunkBytes);
    const chunkPath = `${id}/${version}/assets/embedding/${chunkSha256}/vectors.bin`;
    const assetManifestBytes = new TextEncoder().encode(JSON.stringify({
      schema: "proprium.assets/v1", id: `${id}.embedding`, version: "1.0.0", license: "CC0-1.0",
      files: [{ path: "vectors.bin", bytes: chunkBytes.byteLength, sha256: chunkSha256,
        chunks: [{ path: chunkPath, offset: 0, bytes: chunkBytes.byteLength, sha256: chunkSha256 }] }],
    }));
    const assetManifestSha256 = await digest(assetManifestBytes);
    const assetManifestPath = `${id}/${version}/assets/embedding/manifest/${assetManifestSha256}.json`;
    const assetGroup = { id: "embedding", manifest_path: assetManifestPath, sha256: assetManifestSha256, bytes: assetManifestBytes.byteLength, role: "embedding" as const };
    const manifest = {
      schema: "proprium.plugin/v2", id, version, abi: "proprium.component/v2", entrypoint,
      capabilities: ["workspace.file.read"],
      artifacts: [{ path: entrypoint, bytes: rawComponent.byteLength, sha256: await digest(rawComponent), mediaType: "application/wasm" }],
      actions: [`${id}.status.read`, `${id}.health.read`].map(action_id => ({
        plugin_id: id, action_id, schema_version: 1, effect: "read",
        input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
        output_schema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false },
        required_capabilities: ["workspace.file.read"], callers: ["ui", "mcp"], requires_user_gesture: false,
      })),
      ui: [{ id: "writer-home", kind: "panel", title: "Writer", context: {},
        body: { id: "writer-status", type: "status", title: "Writer status", state: "ready" } }],
      asset_groups: withAssetGroup ? [assetGroup] : [],
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestSignature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, publisherKeys.privateKey, manifestBytes));
    const manifestSha256 = await digest(manifestBytes);
    const manifestPath = `${id}/${version}/manifest/${manifestSha256}.json`;
    content.set(new URL(manifestPath, artifactBase).href, manifestBytes);
    content.set(new URL(entrypoint, artifactBase).href, rawComponent);
    if (withAssetGroup) {
      content.set(new URL(assetManifestPath, artifactBase).href, assetManifestBytes);
      content.set(new URL(chunkPath, artifactBase).href, chunkBytes);
    }
    plugins.push({ id, version, manifestPath, manifestSha256, manifestSignature: encodeBase64(manifestSignature), publisherKey: encodeBase64(publisherKey), dependencies: [] });
    return { assetGroup, assetManifestBytes, assetManifestPath, chunkBytes, chunkPath };
  }

  await addPlugin("example.math", "1.0.0");
  await addPlugin("example.math", "1.2.0");
  await addPlugin("example.calc", "1.0.0", [{ id: "example.math", range: "^1.0.0" }]);
  await addPlugin("example.calc", "1.1.0", [{ id: "example.math", range: "^1.0.0" }]);
  await addPlugin("example.other", "1.0.0");
  await addPlugin("example.loop-a", "1.0.0", [{ id: "example.loop-b", range: "1.0.0" }]);
  await addPlugin("example.loop-b", "1.0.0", [{ id: "example.loop-a", range: "1.0.0" }]);
  const registryBytes = new TextEncoder().encode(JSON.stringify({
    schema: "proprium.registry/v1", id: "example.public", version: "1.0.0", artifactBase, plugins,
  }));
  const registrySignature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, registryKeys.privateKey, registryBytes));
  content.set(registryUrl, registryBytes);
  content.set(`${registryUrl}.sig`, registrySignature);
  async function publishRegistry(versions: readonly string[], registryVersion = `1.0.${++registryPatch}`) {
    const registryBytes = new TextEncoder().encode(JSON.stringify({
      schema: "proprium.registry/v1", id: "example.public", version: registryVersion, artifactBase,
      plugins: plugins.filter(plugin => versions.includes(String(plugin.version))),
    }));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, registryKeys.privateKey, registryBytes));
    content.set(registryUrl, registryBytes);
    content.set(`${registryUrl}.sig`, signature);
  }
  const fetcher: typeof fetch = async (input) => {
    requests.push(String(input));
    const bytes = content.get(String(input));
    return bytes ? new Response(Uint8Array.from(bytes), { status: 200 }) : new Response("missing", { status: 404 });
  };
  const store = new MemoryPluginStore();
  const manager = new BrowserPluginManager({
    registries: [{ url: registryUrl, publicKey: registryPublicKey, artifactOrigins: approvedOrigins }],
    fetcher, store,
  });
  return { manager, store, fetcher, registryPublicKey, registryPrivateKey: registryKeys.privateKey, publishRegistry, addAuthoringPlugin, content, requests };
}

test("registry catalog discovers signed IDs and versions without installing or fetching plugin artifacts", async () => {
  const { manager, store, requests } = await fixture();
  const catalog = await manager.registryCatalog();
  assert.deepEqual(catalog.map(item => `${item.id}@${item.version}`), [
    "example.calc@1.1.0", "example.calc@1.0.0", "example.loop-a@1.0.0", "example.loop-b@1.0.0",
    "example.math@1.2.0", "example.math@1.0.0", "example.other@1.0.0",
  ]);
  assert.equal(catalog[0]!.registryId, "example.public");
  assert.equal(catalog[0]!.registryVersion, "1.0.0");
  assert.deepEqual(catalog[0]!.dependencies, [{ id: "example.math", range: "^1.0.0" }]);
  assert.deepEqual(requests, [registryUrl, `${registryUrl}.sig`]);
  assert.deepEqual(await store.listPlugins(), []);
});

test("explicit v2 grants restore only in their exact Host scope and disable revokes the intent", async () => {
  const f=await fixture();
  await f.addAuthoringPlugin("example.writer","2.0.0");
  await f.publishRegistry(["1.0.0","2.0.0"],"1.0.1");
  await f.manager.installFromRegistry(await f.manager.previewInstall({registryUrl,pluginId:"example.writer",version:"2.0.0"}));
  const selection={scope:{workspace_id:"workspace",repository_id:42,branch:"main"},hostAllowed:["workspace.file.read"]};
  await f.manager.restoreEnabled(selection);
  await f.manager.enable({pluginId:"example.writer",version:"2.0.0",workspaceId:"workspace",grants:["workspace.file.read"],hostAllowed:["workspace.file.read"]});
  const epoch=(await f.manager.verifiedActionSet("example.writer"))!.activation_epoch;
  await assert.rejects(f.manager.authoringRuntime("example.writer").invoke({
    request:{plugin_id:"example.writer",scope:{workspace_id:"workspace",repository_id:42,branch:"other"},deadline_ms:1000} as never,
    caller:"ui",activation_epoch:epoch,deadline_at:Date.now()+1000,granted_capabilities:["workspace.file.read"],
    validate_schema:()=>{},is_snapshot_current:()=>true,resolve_host_call:async()=>undefined,
  }), /another workspace, repository or branch/);
  await f.manager.dispose();
  const reloaded=new BrowserPluginManager({store:f.store,fetcher:f.fetcher,registries:[{url:registryUrl,publicKey:f.registryPublicKey,artifactOrigins:approvedOrigins}]});
  await reloaded.restoreEnabled({...selection,scope:{workspace_id:"workspace",repository_id:42,branch:"other"}});
  assert.equal((await reloaded.verifiedActionSet("example.writer"))!.enabled,false);
  await reloaded.restoreEnabled(selection);
  const restored=(await reloaded.verifiedActionSet("example.writer"))!;
  assert.equal(restored.enabled,true);
  assert.deepEqual(restored.grants,["workspace.file.read"]);
  assert.ok(restored.activation_epoch>epoch);
  assert.equal((await reloaded.installed()).find(p=>p.id==="example.writer")!.state,"enabled-idle");
  await reloaded.disable("example.writer");
  await reloaded.dispose();
  const again=new BrowserPluginManager({store:f.store,fetcher:f.fetcher,registries:[{url:registryUrl,publicKey:f.registryPublicKey,artifactOrigins:approvedOrigins}]});
  await again.restoreEnabled(selection);
  assert.equal((await again.verifiedActionSet("example.writer"))!.enabled,false);
});

test("restoration never grants a permission removed by current Host policy", async () => {
  const f=await fixture();
  await f.addAuthoringPlugin("example.writer","2.0.0");await f.publishRegistry(["1.0.0","2.0.0"],"1.0.1");
  await f.manager.installFromRegistry(await f.manager.previewInstall({registryUrl,pluginId:"example.writer",version:"2.0.0"}));
  const selection={scope:{workspace_id:"workspace",repository_id:42,branch:"main"},hostAllowed:["workspace.file.read"]};
  await f.manager.restoreEnabled(selection);
  await f.manager.enable({pluginId:"example.writer",version:"2.0.0",workspaceId:"workspace",grants:["workspace.file.read"],hostAllowed:["workspace.file.read"]});
  await f.manager.dispose();
  const next=new BrowserPluginManager({store:f.store,fetcher:f.fetcher,registries:[{url:registryUrl,publicKey:f.registryPublicKey,artifactOrigins:approvedOrigins}]});
  await next.restoreEnabled({...selection,hostAllowed:[]});
  assert.equal((await next.verifiedActionSet("example.writer"))!.enabled,false);
  await next.restoreEnabled(selection);
  assert.equal((await next.verifiedActionSet("example.writer"))!.enabled,false);
});

test("signed v2 actions and Host UI remain available while disabled, with no Worker activation", async () => {
  const { manager, store, fetcher, registryPublicKey, addAuthoringPlugin, publishRegistry } = await fixture();
  await addAuthoringPlugin("example.writer", "2.0.0");
  await publishRegistry(["1.0.0", "2.0.0"], "1.0.1");
  const preview = await manager.previewInstall({ registryUrl, pluginId: "example.writer", version: "2.0.0" });
  const installed = await manager.installFromRegistry(preview);
  const writer = installed.find(item => item.id === "example.writer")!;
  assert.equal(writer.manifest?.schema, "proprium.plugin/v2");
  assert.match(writer.manifestDigest ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(writer.actions[0]?.action_id, "example.writer.status.read");
  assert.equal(writer.surfaces[0]?.id, "writer-home");
  assert.equal(writer.state, "installed");
  const firstPage = await manager.actionsList("example.writer", "ui", undefined, 1);
  assert.deepEqual(firstPage.items.map(item => item.availability), ["disabled"]);
  assert.ok(firstPage.next_cursor);
  assert.equal((await manager.actionsList("example.writer", "ui", firstPage.next_cursor!, 1)).items[0]?.action_id, "example.writer.health.read");
  await assert.rejects(manager.actionsList("example.writer", "mcp", firstPage.next_cursor!, 1), /cursor is stale/i);

  const record = await store.getPlugin("example.writer@2.0.0");
  assert.ok(record?.manifest?.schema === "proprium.plugin/v2");
  await store.putPlugins([{ ...record, manifest: { ...record.manifest, ui: [] } }]);
  assert.equal((await manager.installed()).find(item => item.id === "example.writer")?.surfaces[0]?.id, "writer-home");
  assert.equal((await store.getPlugin("example.writer@2.0.0"))?.manifest?.schema, "proprium.plugin/v2");

  await assert.rejects(manager.enable({ pluginId: "example.writer", version: "2.0.0", workspaceId: "workspace", grants: ["unlisted.capability"], hostAllowed: [] }),
    (error: unknown) => error instanceof PluginManagerError && error.code === "capability_denied");
  await manager.enable({ pluginId: "example.writer", version: "2.0.0", workspaceId: "workspace", grants: ["workspace.file.read"], hostAllowed: ["workspace.file.read"] });
  const actionSet = await manager.verifiedActionSet("example.writer");
  assert.equal(actionSet?.manifest_digest, writer.manifestDigest);
  assert.equal(actionSet?.enabled, true);
  assert.ok((actionSet?.activation_epoch ?? 0) > 0);
  const managedRuntime = manager.authoringRuntime("example.writer");
  const actionRequest = { plugin_id: "example.writer", deadline_ms: 1000 } as never;
  const invokeOptions = {
    request: actionRequest, caller: "ui" as const, activation_epoch: actionSet!.activation_epoch,
    deadline_at: Date.now() + 1000, granted_capabilities: [], validate_schema: () => undefined,
    is_snapshot_current: () => true, resolve_host_call: async () => undefined,
  };
  await assert.rejects(managedRuntime.invoke(invokeOptions), /grant set differs/i);
  await assert.rejects(managedRuntime.invoke({ ...invokeOptions, granted_capabilities: ["workspace.file.read"], deadline_at: Date.now() - 1 }), /deadline/i);
  assert.deepEqual((await manager.actionsList("example.writer", "ui")).items.map(item => item.availability), ["ready", "ready"]);
  assert.equal((await manager.installed()).find(item => item.id === "example.writer")?.state, "enabled-idle");
  const enabledEpoch = actionSet!.activation_epoch;
  await manager.disable("example.writer");
  const disabledSet = await manager.verifiedActionSet("example.writer");
  assert.equal(disabledSet?.enabled, false);
  assert.ok((disabledSet?.activation_epoch ?? 0) > enabledEpoch);
  await assert.rejects(managedRuntime.invoke({
    request: {} as never, caller: "ui", activation_epoch: enabledEpoch, deadline_at: Date.now() + 1000,
    granted_capabilities: ["workspace.file.read"], validate_schema: () => undefined,
    is_snapshot_current: () => true, resolve_host_call: async () => undefined,
  }), (error: unknown) => error instanceof PluginManagerError && error.code === "not_active");

  const reloaded = new BrowserPluginManager({ registries: [{ url: registryUrl, publicKey: registryPublicKey, artifactOrigins: approvedOrigins }], fetcher, store });
  const afterReload = (await reloaded.installed()).find(item => item.id === "example.writer")!;
  assert.equal(afterReload.state, "installed");
  assert.equal(afterReload.actions[0]?.action_id, "example.writer.status.read");
  assert.equal(afterReload.surfaces[0]?.id, "writer-home");
  await Promise.all([manager.dispose(), reloaded.dispose()]);
});

test("asset group resolution uses freshly admitted metadata and the pinned registry fetch policy", async () => {
  const { manager, store, addAuthoringPlugin, publishRegistry } = await fixture();
  const asset = await addAuthoringPlugin("example.assets", "2.0.0", true);
  await publishRegistry(["1.0.0", "2.0.0"], "1.0.1");
  const preview = await manager.previewInstall({ registryUrl, pluginId: "example.assets", version: "2.0.0" });
  await manager.installFromRegistry(preview);

  const installed = await manager.resolveAssetGroup("example.assets", "embedding");
  assert.ok(installed);
  assert.equal(installed.plugin_id, "example.assets");
  assert.equal(installed.version, "2.0.0");
  assert.deepEqual(installed.ref, asset.assetGroup);
  assert.deepEqual(await installed.readObject(installed.ref.manifest_path, installed.ref.bytes), asset.assetManifestBytes);
  assert.deepEqual(await installed.readObject(asset.chunkPath, asset.chunkBytes.byteLength), asset.chunkBytes);
  await assert.rejects(installed.readObject("https://attacker.example/model.bin", 64), /relative and traversal-free/i);
  await assert.rejects(installed.readObject("../outside/model.bin", 64), /relative and traversal-free/i);
  assert.equal(await manager.resolveAssetGroup("example.assets", "missing"), undefined);

  const record = await store.getPlugin("example.assets@2.0.0");
  assert.ok(record?.manifest?.schema === "proprium.plugin/v2");
  await store.putPlugins([{ ...record, manifest: { ...record.manifest, asset_groups: [] } }]);
  assert.deepEqual((await manager.resolveAssetGroup("example.assets", "embedding"))?.ref, asset.assetGroup);
  await manager.dispose();
});

test("asset group resolution fails closed when cached manifest bytes or registry artifact base are tampered", async () => {
  const { manager, store, addAuthoringPlugin, publishRegistry } = await fixture();
  const asset = await addAuthoringPlugin("example.assets", "2.0.0", true);
  await publishRegistry(["1.0.0", "2.0.0"], "1.0.1");
  const preview = await manager.previewInstall({ registryUrl, pluginId: "example.assets", version: "2.0.0" });
  await manager.installFromRegistry(preview);

  const record = await store.getPlugin("example.assets@2.0.0");
  assert.ok(record);
  const heldResolver = await manager.resolveAssetGroup("example.assets", "embedding");
  assert.ok(heldResolver);
  await store.putPlugins([{ ...record, manifestBytes: new TextEncoder().encode(JSON.stringify({ ...record.manifest, asset_groups: [] })) }]);
  await assert.rejects(manager.resolveAssetGroup("example.assets", "embedding"), /manifest|digest|signature/i);
  await assert.rejects(heldResolver.readObject(asset.assetManifestPath, asset.assetGroup.bytes), /manifest|digest|signature/i);

  const fresh = await fixture();
  await fresh.addAuthoringPlugin("example.assets", "2.0.0", true);
  await fresh.publishRegistry(["1.0.0", "2.0.0"], "1.0.1");
  const freshPreview = await fresh.manager.previewInstall({ registryUrl, pluginId: "example.assets", version: "2.0.0" });
  await fresh.manager.installFromRegistry(freshPreview);
  const freshRecord = await fresh.store.getPlugin("example.assets@2.0.0");
  assert.ok(freshRecord);
  const proof = await fresh.store.getRegistry(registryUrl, freshRecord.registryDigest);
  assert.ok(proof);
  const changedRegistry = JSON.parse(new TextDecoder().decode(proof.bytes)) as Record<string, unknown>;
  changedRegistry.artifactBase = "https://attacker.example/plugins/";
  await fresh.store.putRegistry({ ...proof, bytes: new TextEncoder().encode(JSON.stringify(changedRegistry)) });
  await assert.rejects(fresh.manager.resolveAssetGroup("example.assets", "embedding"), /signature|origin/i);

  await Promise.all([manager.dispose(), fresh.manager.dispose()]);
});

test("registry catalog rejects invalid signatures and unapproved artifact origins", async () => {
  const invalidSignature = await fixture();
  invalidSignature.content.set(`${registryUrl}.sig`, new Uint8Array(64));
  await assert.rejects(invalidSignature.manager.registryCatalog(), (error: unknown) =>
    error instanceof PluginRegistryError && error.code === "invalid_signature");

  const unapprovedOrigin = await fixture();
  const registryBytes = JSON.parse(new TextDecoder().decode(unapprovedOrigin.content.get(registryUrl)!)) as Record<string, unknown>;
  registryBytes.artifactBase = "https://unapproved.example.test/plugins/";
  const bytes = new TextEncoder().encode(JSON.stringify(registryBytes));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, unapprovedOrigin.registryPrivateKey, bytes));
  unapprovedOrigin.content.set(registryUrl, bytes);
  unapprovedOrigin.content.set(`${registryUrl}.sig`, signature);
  await assert.rejects(unapprovedOrigin.manager.registryCatalog(), /Host has not approved artifact origin/i);
});

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

test("observed revocations cannot be undone by replaying an older signed registry", async () => {
  const { manager, publishRegistry, content } = await fixture();
  await manager.installFromRegistry(await manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" }));
  const originalBytes = Uint8Array.from(content.get(registryUrl)!);
  const originalSignature = Uint8Array.from(content.get(`${registryUrl}.sig`)!);

  // Re-fetching the exact observed snapshot is idempotent.
  await manager.previewInstall({ registryUrl, pluginId: "example.math", version: "1.2.0" });
  await publishRegistry(["1.2.0", "1.1.0"], "1.0.1");
  await manager.previewInstall({ registryUrl, pluginId: "example.math", version: "1.2.0" });
  assert.equal((await manager.installed()).find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.state, "revoked");

  // A changed snapshot cannot reuse the version number already observed.
  await publishRegistry(["1.2.0"], "1.0.1");
  await assert.rejects(manager.previewInstall({ registryUrl, pluginId: "example.math", version: "1.2.0" }), /reuse an observed registry version/i);

  // Nor can a compromised distribution serve the previously valid, older root-signed index.
  content.set(registryUrl, originalBytes);
  content.set(`${registryUrl}.sig`, originalSignature);
  await assert.rejects(manager.previewInstall({ registryUrl, pluginId: "example.math", version: "1.2.0" }), /version rollback/i);
  assert.equal((await manager.installed()).find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.state, "revoked");
  await assert.rejects(manager.enable({ pluginId: "example.calc", version: "1.0.0", workspaceId: "workspace", grants: [], hostAllowed: [] }), /revoked/i);
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

test("rotating the Host-pinned registry key revokes cached code and leaves it removable", async () => {
  const { manager, store, fetcher } = await fixture();
  await manager.installFromRegistry(await manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" }));
  const rotated = new BrowserPluginManager({
    registries: [{ url: registryUrl, publicKey: new Uint8Array(32), artifactOrigins: approvedOrigins }], fetcher, store,
  });
  const plugins = await rotated.installed();
  assert.equal(plugins.find(plugin => plugin.id === "example.calc")?.state, "revoked");
  assert.deepEqual(plugins.find(plugin => plugin.id === "example.calc")?.capabilities, []);
  await rotated.uninstall("example.calc", "1.0.0");
  await rotated.uninstall("example.math", "1.2.0");
  assert.deepEqual(await rotated.installed(), []);
});

test("rotating the registry root at the same URL starts a separate monotonic index and revokes old installs", async () => {
  const { manager, store, fetcher, content } = await fixture();
  await manager.installFromRegistry(await manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" }));

  const nextKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const nextPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", nextKeys.publicKey));
  // Re-sign exactly the same bytes at the new root. The URL+digest cache slot
  // is shared, but old installations must remain bound to the previous root.
  const nextBytes = Uint8Array.from(content.get(registryUrl)!);
  const nextSignature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, nextKeys.privateKey, nextBytes));
  content.set(registryUrl, nextBytes);
  content.set(`${registryUrl}.sig`, nextSignature);

  const rotated = new BrowserPluginManager({
    registries: [{ url: registryUrl, publicKey: nextPublicKey, artifactOrigins: approvedOrigins }], fetcher, store,
  });
  const preview = await rotated.previewInstall({ registryUrl, pluginId: "example.other", version: "1.0.0" });
  await rotated.installFromRegistry(preview);
  const listed = await rotated.installed();
  assert.equal(listed.find(plugin => plugin.id === "example.other")?.state, "installed");
  assert.equal(listed.find(plugin => plugin.id === "example.calc" && plugin.version === "1.0.0")?.state, "revoked");
  await rotated.uninstall("example.calc", "1.0.0");
  await rotated.uninstall("example.math", "1.2.0");
});

test("a missing latest proof is rejected within the same pinned registry root", async () => {
  const { manager, store, registryPublicKey } = await fixture();
  await manager.previewInstall({ registryUrl, pluginId: "example.math", version: "1.2.0" });
  const rootFingerprint = Array.from(registryPublicKey, byte => byte.toString(16).padStart(2, "0")).join("");
  await store.setState(`registry-latest:${registryUrl}:${rootFingerprint}`, "0".repeat(64));
  await assert.rejects(manager.previewInstall({ registryUrl, pluginId: "example.math", version: "1.2.0" }), /latest signed registry proof is missing/i);
});

test("the default fetch adapter preserves the browser global receiver", async () => {
  const { registryPublicKey, content } = await fixture();
  const previousFetch = globalThis.fetch;
  let receivedGlobal = false;
  globalThis.fetch = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
    receivedGlobal = this === globalThis;
    const bytes = content.get(String(input));
    return Promise.resolve(bytes ? new Response(Uint8Array.from(bytes), { status: 200 }) : new Response("missing", { status: 404 }));
  } as typeof fetch;
  try {
    const manager = new BrowserPluginManager({
      registries: [{ url: registryUrl, publicKey: registryPublicKey, artifactOrigins: approvedOrigins }],
      store: new MemoryPluginStore(),
    });
    await manager.previewInstall({ registryUrl, pluginId: "example.calc", version: "1.0.0" });
    assert.equal(receivedGlobal, true);
  } finally { globalThis.fetch = previousFetch; }
});
