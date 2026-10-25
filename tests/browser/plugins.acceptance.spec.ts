import { expect, test } from "@playwright/test";
import { createHash, createPrivateKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ServedFile { body: Buffer; contentType: string; }

declare global {
  interface Window {
    propriumHostTest?: {
      openWorkspace(identity: import("../../app/src/browser/proprium/git/protocol.js").WorkspaceIdentity, files?: Record<string, string>): Promise<void>;
    };
  }
}

let fixtureDirectory: string;
let component: Buffer;
let sumComponent: Buffer;

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
    const artifactSha = sha256(artifactBytes);
    const assetPath = `${pluginId}/${version}/${artifactSha}/plugin.component.wasm`;
    const manifest = JSON.stringify({
      schema: "proprium.plugin/v1",
      id: pluginId,
      version,
      abi: "proprium.component/v1",
      entrypoint: assetPath,
      capabilities,
      artifacts: [{ path: assetPath, bytes: artifactBytes.byteLength, sha256: sha256(artifactBytes), mediaType: "application/wasm" }],
    });
    const manifestBytes = Buffer.from(manifest, "utf8");
    const manifestPath = `${pluginId}/${version}/manifest/${sha256(manifestBytes)}.json`;
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

function signedHostPanelFixture(origin: string): Map<string, ServedFile> {
  const registryUrl = `${origin}/plugin-fixture/registry.json`;
  const artifactBase = `${origin}/plugin-fixture/artifacts/`;
  const pluginId = "fixture.compute-sum";
  const publisher = generateKeyPairSync("ed25519");
  const registryKey = process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY;
  if (!registryKey) throw new Error("The Playwright config did not create a test-only pinned registry key.");
  const registrySigner = createPrivateKey(registryKey);
  const files = new Map<string, ServedFile>();
  const entries = [];

  for (const version of ["1.0.0", "1.0.1"]) {
    const artifactSha = sha256(sumComponent);
    const assetPath = `${pluginId}/${version}/${artifactSha}/plugin.component.wasm`;
    const manifestBytes = Buffer.from(JSON.stringify({
      schema: "proprium.plugin/v1",
      id: pluginId,
      version,
      abi: "proprium.component/v1",
      entrypoint: assetPath,
      capabilities: [],
      artifacts: [{ path: assetPath, bytes: sumComponent.byteLength, sha256: artifactSha, mediaType: "application/wasm" }],
    }), "utf8");
    const manifestPath = `${pluginId}/${version}/manifest/${sha256(manifestBytes)}.json`;
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
    files.set(new URL(assetPath, artifactBase).pathname, { body: Buffer.from(sumComponent), contentType: "application/wasm" });
  }

  const registryBytes = Buffer.from(JSON.stringify({
    schema: "proprium.registry/v1",
    id: "fixture.registry",
    version: "1.0.0",
    artifactBase,
    plugins: entries,
  }), "utf8");
  const registrySignature = ed25519Sign(null, registryBytes, registrySigner);
  files.set(new URL(registryUrl).pathname, { body: registryBytes, contentType: "application/json" });
  files.set(`${new URL(registryUrl).pathname}.sig`, { body: registrySignature, contentType: "application/octet-stream" });
  return files;
}

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "proprium-plugin-component-"));
  const componentPath = join(fixtureDirectory, "plugin.component.wasm");
  execFileSync("pnpm", [
    "--config.verifyDepsBeforeRun=false", "exec", "jco", "componentize",
    "tests/fixtures/plugin-runtime/component.ts",
    "--wit", "app/src/browser/proprium/plugin-runtime/wit",
    "--world-name", "proprium:plugin/plugin@1.0.0",
    "--disable", "all", "--bundle", "-o", componentPath,
  ], { cwd: resolve("."), stdio: "pipe" });
  component = readFileSync(componentPath);
  const sumComponentPath = join(fixtureDirectory, "sum.component.wasm");
  execFileSync("pnpm", [
    "--config.verifyDepsBeforeRun=false", "exec", "jco", "componentize",
    "tests/fixtures/plugin-compute-sum.ts",
    "--wit", "app/src/browser/proprium/plugin-runtime/wit",
    "--world-name", "proprium:plugin/plugin@1.0.0",
    "--disable", "all", "--bundle", "-o", sumComponentPath,
  ], { cwd: resolve("."), stdio: "pipe" });
  sumComponent = readFileSync(sumComponentPath);
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
    const installPlan = await manager.previewInstall({ registryUrl, pluginId, version: "1.0.0" });
    const installed = await manager.installFromRegistry(installPlan);
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
    const updatePlan = await manager.previewUpdate({ registryUrl, pluginId, version: "1.0.1" });
    const upgraded = await manager.update(updatePlan);
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

test("Host Plugin panel previews, installs, runs, stops, updates and rolls back an independent Component", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const fixtureFiles = signedHostPanelFixture(origin);
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const file = fixtureFiles.get(new URL(route.request().url()).pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async () => window.propriumHostTest!.openWorkspace({
    origin: "https://github.com", repositoryId: 923456789, owner: "proprium-test", repository: "plugin-e2e",
    branch: "main", localWorkspaceId: `plugin-${crypto.randomUUID()}`,
  }, { "notes.md": "before" }));
  const mobileFiles = page.getByRole("button", { name: /^Files(?:\s|$)/u });
  if (await mobileFiles.isVisible()) await mobileFiles.click();

  const panel = page.locator("details.plugin-manager-panel");
  const panelNotice = panel.getByRole("status");
  await panel.locator("summary").click();
  await page.getByLabel("Install from trusted registry").fill("fixture.compute-sum");
  await page.getByLabel("Version (optional: latest stable)").fill("1.0.0");
  await page.getByRole("button", { name: "Verify and preview" }).click();
  const preview = page.getByRole("region", { name: "Plugin installation preview" });
  await expect(preview).toContainText("fixture.compute-sum@1.0.0");
  await expect(preview).toContainText("Capabilities: none");
  await page.getByRole("button", { name: "Download and install disabled" }).click();
  await expect(panelNotice).toContainText("Plugin artifact bytes passed signature and digest verification");

  const pluginV1 = page.getByRole("listitem").filter({ hasText: "fixture.compute-sum" }).filter({ hasText: "v1.0.0" });
  await pluginV1.getByRole("button", { name: "Enable" }).click();
  await expect(panelNotice).toContainText("fixture.compute-sum@1.0.0 is enabled");
  await page.getByLabel("Plugin request").fill(JSON.stringify({ left: 20, right: 22 }));
  await pluginV1.getByRole("button", { name: "Run" }).click();
  await expect(page.getByLabel("fixture.compute-sum output")).toHaveText('{"result":42}');
  await pluginV1.getByRole("button", { name: "Stop" }).click();
  await expect(pluginV1).toContainText("v1.0.0 · installed, disabled");

  await page.once("dialog", dialog => dialog.accept("1.0.1"));
  await pluginV1.getByRole("button", { name: "Update version" }).click();
  await expect(preview).toContainText("Update preview");
  await expect(preview).toContainText("fixture.compute-sum@1.0.1");
  await page.getByRole("button", { name: "Download and pin update" }).click();
  await expect(panelNotice).toContainText("Installed version 1.0.1 is pinned");

  const pluginV2 = page.getByRole("listitem").filter({ hasText: "fixture.compute-sum" }).filter({ hasText: "v1.0.1" });
  await expect(pluginV2).toContainText("pinned 1.0.1");
  await pluginV2.getByRole("button", { name: "Rollback" }).click();
  await expect(panelNotice).toContainText("fixture.compute-sum was rolled back to its retained verified version");
  await expect(pluginV1).toContainText("pinned 1.0.0");
});
