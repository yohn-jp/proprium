import { expect, test } from "@playwright/test";
import { createHash, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ServedFile { body: Buffer; contentType: string; }

let fixtureDirectory: string;
let component: Buffer;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicKeyBytes(publicKey: KeyObject): Buffer {
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32);
}

function signedFixture(origin: string): { files: Map<string, ServedFile>; registryPublicKey: Buffer } {
  const registryUrl = `${origin}/plugin-fixture/registry.json`;
  const artifactBase = `${origin}/plugin-fixture/artifacts/`;
  const pluginId = "fixture.compute";
  const capabilities = ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"];
  const publisher = generateKeyPairSync("ed25519");
  const registrySigner = generateKeyPairSync("ed25519");
  const artifactBytes = new Uint8Array(component);
  const files = new Map<string, ServedFile>();
  const entries = [];

  for (const version of ["1.0.0", "1.0.1"]) {
    const assetPath = `${pluginId}/${version}/plugin.component.wasm`;
    const manifestPath = `${pluginId}/${version}/manifest.json`;
    const manifest = JSON.stringify({
      schema: "proprium.plugin/v1",
      id: pluginId,
      version,
      abi: "proprium.component/v1",
      entrypoint: "plugin.component.wasm",
      capabilities,
      artifacts: [{ path: "plugin.component.wasm", bytes: artifactBytes.byteLength, sha256: sha256(artifactBytes), mediaType: "application/wasm" }],
    });
    const manifestBytes = Buffer.from(manifest, "utf8");
    const manifestSignature = ed25519Sign(null, manifestBytes, publisher.privateKey);
    entries.push({
      id: pluginId,
      version,
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      manifestSignature: manifestSignature.toString("base64"),
      publisherKey: publicKeyBytes(publisher.publicKey).toString("base64"),
      dependencies: [],
    });
    files.set(new URL(manifestPath, artifactBase).pathname, { body: manifestBytes, contentType: "application/json" });
    files.set(new URL(assetPath, artifactBase).pathname, { body: Buffer.from(artifactBytes), contentType: "application/wasm" });
  }

  const registryBytes = Buffer.from(JSON.stringify({
    schema: "proprium.registry/v1",
    id: "fixture.registry",
    version: "1.0.0",
    artifactBase,
    plugins: entries,
  }), "utf8");
  const registrySignature = ed25519Sign(null, registryBytes, registrySigner.privateKey);
  files.set(new URL(registryUrl).pathname, { body: registryBytes, contentType: "application/json" });
  files.set(`${new URL(registryUrl).pathname}.sig`, { body: registrySignature, contentType: "application/octet-stream" });
  return { files, registryPublicKey: publicKeyBytes(registrySigner.publicKey) };
}

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "proprium-plugin-component-"));
  const componentPath = join(fixtureDirectory, "plugin.component.wasm");
  execFileSync("pnpm", [
    "exec", "jco", "componentize",
    "tests/fixtures/plugin-runtime/component.ts",
    "--wit", "app/src/browser/proprium/plugin-runtime/wit",
    "--world-name", "proprium:plugin/plugin@1.0.0",
    "--disable", "all", "--bundle", "-o", componentPath,
  ], { cwd: resolve("."), stdio: "pipe" });
  component = readFileSync(componentPath);
});

test.afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

test("signed registry installs a real Component, enforces grants, stops and updates it", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const registryUrl = `${origin}/plugin-fixture/registry.json`;
  const pluginId = "fixture.compute";
  const fixture = signedFixture(origin);
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const file = fixture.files.get(new URL(route.request().url()).pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  const result = await page.evaluate(async ({ registryUrl, pluginId, pinnedRegistryKey }) => {
    const moduleUrl = new URL("/src/browser/proprium/plugins/index.ts", location.origin).href;
    const { BrowserPluginManager, MemoryPluginStore } = await import(/* @vite-ignore */ moduleUrl);
    const manager = new BrowserPluginManager({
      registries: [{ url: registryUrl, publicKey: Uint8Array.from(pinnedRegistryKey), artifactOrigins: [location.origin] }],
      store: new MemoryPluginStore(),
    });
    const installed = await manager.installFromRegistry({ registryUrl, pluginId, version: "1.0.0" });
    let denied = "none";
    try {
      await manager.enable({ pluginId, version: "1.0.0", workspaceId: "host-e2e", grants: ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"], hostAllowed: ["workspace.snapshot.read", "workspace.ui.contribute"] });
      await manager.invoke({
        pluginId,
        request: JSON.stringify({ path: "notes.md", content: "after", expectedRevision: "revision-1", snapshotId: "snapshot-1", snapshotRevision: "commit-1" }),
        snapshot: { id: "snapshot-1", revision: "commit-1", files: [{ path: "notes.md", revision: "revision-1", content: "before" }] },
        isSnapshotCurrent: () => true,
      });
    } catch (error) { denied = (error as { code?: string }).code ?? "unknown"; }
    await manager.disable(pluginId);
    const afterDenied = await manager.installed();

    await manager.enable({ pluginId, version: "1.0.0", workspaceId: "host-e2e", grants: ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"], hostAllowed: ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"] });
    const firstRun = await manager.invoke({
      pluginId,
      request: JSON.stringify({ path: "notes.md", content: "after", expectedRevision: "revision-1", snapshotId: "snapshot-1", snapshotRevision: "commit-1" }),
      snapshot: { id: "snapshot-1", revision: "commit-1", files: [{ path: "notes.md", revision: "revision-1", content: "before" }] },
      isSnapshotCurrent: () => true,
    });
    await manager.disable(pluginId);
    const afterStop = await manager.installed();
    const upgraded = await manager.update(pluginId, "1.0.1");
    await manager.enable({ pluginId, version: "1.0.1", workspaceId: "host-e2e", grants: ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"], hostAllowed: ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"] });
    const secondRun = await manager.invoke({
      pluginId,
      request: JSON.stringify({ path: "notes.md", content: "after v2", expectedRevision: "revision-1", snapshotId: "snapshot-1", snapshotRevision: "commit-1" }),
      snapshot: { id: "snapshot-1", revision: "commit-1", files: [{ path: "notes.md", revision: "revision-1", content: "before" }] },
      isSnapshotCurrent: () => true,
    });
    await manager.disable(pluginId);
    const rolledBack = await manager.rollback(pluginId);
    const removed = await manager.uninstall(pluginId, "1.0.1");
    await manager.dispose();
    return { installed, denied, afterDenied, firstRun, afterStop, upgraded, secondRun, rolledBack, removed };
  }, { registryUrl, pluginId, pinnedRegistryKey: [...fixture.registryPublicKey] });

  expect(result.installed.map(plugin => plugin.version)).toContain("1.0.0");
  expect(result.denied).toBe("capability_denied");
  expect(result.afterDenied.find(plugin => plugin.version === "1.0.0")?.state).toBe("installed");
  expect(JSON.parse(result.firstRun.value)).toMatchObject({ before: "before", workspaceId: "host-e2e" });
  expect(result.firstRun.proposals).toHaveLength(1);
  expect(result.firstRun.contributions).toEqual([{ kind: "panel", id: "fixture-panel", title: "Fixture panel" }]);
  expect(result.afterStop.find(plugin => plugin.version === "1.0.0")?.state).toBe("installed");
  expect(result.upgraded.find(plugin => plugin.id === pluginId)?.activeVersion).toBe("1.0.1");
  expect(JSON.parse(result.secondRun.value)).toMatchObject({ before: "before", workspaceId: "host-e2e" });
  expect(result.rolledBack.find(plugin => plugin.id === pluginId)?.activeVersion).toBe("1.0.0");
  expect(result.removed.map(plugin => plugin.version)).toEqual(["1.0.0"]);
});
