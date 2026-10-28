import { showPanel, expectEditorText, chooseFile } from "./restored-ui.helpers.js";
import { expect, test, type Page } from "@playwright/test";
import { createHash, createPrivateKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ServedFile { body: Buffer; contentType: string; }

declare global {
  interface Window {
    propriumReadRace?: {
      holdNext: boolean;
      started: boolean;
      release?: () => void;
    };
    propriumPluginGitCalls?: { listFiles: number; read: number };
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

function signedHostPanelFixture(
  origin: string,
  options: { pluginId?: string; artifact?: Buffer; capabilities?: string[]; versions?: readonly string[] } = {},
): Map<string, ServedFile> {
  const registryUrl = `${origin}/plugin-fixture/registry.json`;
  const artifactBase = `${origin}/plugin-fixture/artifacts/`;
  const pluginId = options.pluginId ?? "fixture.compute-sum";
  const artifactBytes = options.artifact ?? sumComponent;
  const capabilities = options.capabilities ?? [];
  const publisher = generateKeyPairSync("ed25519");
  const registryKey = process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY;
  if (!registryKey) throw new Error("The Playwright config did not create a test-only pinned registry key.");
  const registrySigner = createPrivateKey(registryKey);
  const files = new Map<string, ServedFile>();
  const entries = [];

  for (const version of options.versions ?? ["1.0.0", "1.0.1"]) {
    const artifactSha = sha256(artifactBytes);
    const assetPath = `${pluginId}/${version}/${artifactSha}/plugin.component.wasm`;
    const manifestBytes = Buffer.from(JSON.stringify({
      schema: "proprium.plugin/v1",
      id: pluginId,
      version,
      abi: "proprium.component/v1",
      entrypoint: assetPath,
      capabilities,
      artifacts: [{ path: assetPath, bytes: artifactBytes.byteLength, sha256: artifactSha, mediaType: "application/wasm" }],
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
    files.set(new URL(assetPath, artifactBase).pathname, { body: Buffer.from(artifactBytes), contentType: "application/wasm" });
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

async function previewCatalogPlugin(page: Page, pluginId: string, version: string): Promise<void> {
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await expect(page.locator(".registry-plugin-list")).toContainText(pluginId);
  await expect(page.locator(".registry-plugin-identity code").first()).toHaveText(pluginId);
  await expect(page.locator(".registry-plugin-card").getByText(`v${version}`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: `${pluginId} v${version} の導入内容と署名を確認` }).click();
}

const gatewayOrigin = process.env.VITE_PROPRIUM_GATEWAY_URL ?? "http://127.0.0.1:4174";

interface JsonRpcResponse { jsonrpc: string; id: string; result?: unknown; error?: { code: number; message: string }; }

async function mcpCall(id: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const version = "2026-07-28";
  const response = await fetch(`${gatewayOrigin}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": version,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": { name: "Proprium Plugin E2E", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    cache: "no-store",
    redirect: "error",
  });
  const source = await response.text();
  const json = source.startsWith("data:") ? source.split(/\r?\n/u).find(line => line.startsWith("data:"))?.slice(5).trim() : source;
  const result = json ? JSON.parse(json) as JsonRpcResponse : null;
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result?.error).toBeUndefined();
  return result!;
}

function mcpTextResult(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content?: Array<{ type: string; text?: string }> };
  const text = result.content?.find(item => item.type === "text")?.text;
  if (!text) throw new Error(`MCP response did not contain text content: ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
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
  const artifactDownloads: string[] = [];
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(".wasm")) artifactDownloads.push(pathname);
    const file = fixtureFiles.get(pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async () => window.propriumHostTest!.openWorkspace({
    origin: "https://github.com", repositoryId: 923456789, owner: "proprium-test", repository: "plugin-e2e",
    branch: "main", localWorkspaceId: `plugin-${crypto.randomUUID()}`,
  }, { "notes.md": "before" }));
  await showPanel(page, "outline");

  const panel = page.locator("details.plugin-manager-panel");
  const panelNotice = panel.getByRole("status");
  await showPanel(page, "review");
  await panel.locator("summary").click();
  await previewCatalogPlugin(page, "fixture.compute-sum", "1.0.0");
  expect(artifactDownloads).toEqual([]);
  const preview = page.getByRole("region", { name: "インストールプレビュー" });
  await expect(preview).toContainText("fixture.compute-sum@1.0.0");
  await expect(preview).toContainText("要求する権限: なし");
  expect(artifactDownloads).toEqual([]);
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect.poll(() => artifactDownloads).toHaveLength(1);
  await expect(panelNotice).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");

  const pluginV1 = page.locator(".installed-plugins > li").filter({ hasText: "fixture.compute-sum" }).filter({ hasText: "v1.0.0" });
  await pluginV1.getByRole("button", { name: "有効化" }).click();
  await expect(panelNotice).toContainText("fixture.compute-sum@1.0.0 is enabled");
  await pluginV1.getByLabel(/プラグイン入力（テキスト）/u).fill(JSON.stringify({ left: 20, right: 22 }));
  await pluginV1.getByRole("button", { name: "実行" }).click();
  await expect(page.getByLabel("fixture.compute-sum output")).toHaveText('{"result":42}');
  await pluginV1.getByRole("button", { name: "停止" }).click();
  await expect(pluginV1).toContainText("v1.0.0 · 無効");

  await page.once("dialog", dialog => dialog.accept("1.0.1"));
  await pluginV1.getByRole("button", { name: "バージョンを更新" }).click();
  const updatePreview = page.getByRole("region", { name: "更新プレビュー" });
  await expect(updatePreview).toContainText("fixture.compute-sum@1.0.1");
  await page.getByRole("button", { name: "ダウンロードして更新版を固定" }).click();
  await expect(panelNotice).toContainText("バージョン 1.0.1 を確認して固定しました");

  const pluginV2 = page.locator(".installed-plugins > li").filter({ hasText: "fixture.compute-sum" }).filter({ hasText: "v1.0.1" });
  await expect(pluginV2).toContainText("pinned 1.0.1");
  await pluginV2.getByRole("button", { name: "以前の版に戻す" }).click();
  await expect(panelNotice).toContainText("fixture.compute-sum was rolled back to its retained verified version");
  await expect(pluginV1).toContainText("pinned 1.0.0");
});

test("Host runs a signed no-capability Component without workspace reads in UI or Live MCP", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const pluginId = "proprium.compute-sum";
  const version = "0.1.0";
  const fixtureFiles = signedHostPanelFixture(origin, { pluginId, artifact: sumComponent, capabilities: [], versions: [version] });
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const file = fixtureFiles.get(new URL(route.request().url()).pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  const files = Object.fromEntries(Array.from({ length: 521 }, (_, index) => [
    `fixture/file-${String(index).padStart(4, "0")}.txt`, `file ${index}\n`,
  ]));
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async ({ files }) => window.propriumHostTest!.openWorkspace({
    origin: "https://github.com", repositoryId: 923456791, owner: "proprium-test", repository: "large-plugin-workspace",
    branch: "main", localWorkspaceId: `plugin-large-${crypto.randomUUID()}`,
  }, files), { files });
  await showPanel(page, "outline");
  await showPanel(page, "review");

  const panel = page.locator("details.plugin-manager-panel");
  await panel.locator("summary").click();
  await previewCatalogPlugin(page, pluginId, version);
  const preview = page.getByRole("region", { name: "インストールプレビュー" });
  await expect(preview).toContainText(`${pluginId}@${version}`);
  await expect(preview).toContainText("要求する権限: なし");
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  const plugin = panel.locator(".installed-plugins > li").filter({ hasText: pluginId }).filter({ hasText: `v${version}` });
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(panel.getByRole("status")).toContainText(`${pluginId}@${version} is enabled`);

  await page.evaluate(async () => {
    const moduleUrl = new URL("/src/browser/proprium/git/index.ts", location.origin).href;
    const { BrowserLocalGit } = await import(/* @vite-ignore */ moduleUrl);
    const prototype = BrowserLocalGit.prototype;
    const listFiles = prototype.listFiles;
    const read = prototype.read;
    window.propriumPluginGitCalls = { listFiles: 0, read: 0 };
    prototype.listFiles = async function () {
      window.propriumPluginGitCalls!.listFiles += 1;
      return listFiles.call(this);
    };
    prototype.read = async function (path: string) {
      window.propriumPluginGitCalls!.read += 1;
      return read.call(this, path);
    };
  });

  const request = JSON.stringify({ left: 20, right: 22 });
  await plugin.getByLabel(/プラグイン入力（テキスト）/u).fill(request);
  await plugin.getByRole("button", { name: "実行" }).click();
  await expect(page.getByLabel(`${pluginId} output`)).toHaveText('{"result":42}');
  await expect.poll(() => page.evaluate(() => window.propriumPluginGitCalls)).toEqual({ listFiles: 0, read: 0 });

  const livePanel = page.locator(".live-mcp-panel");
  await expect(livePanel.getByRole("status").first()).toContainText("ブラウザーに接続中", { timeout: 20_000 });
  await expect(livePanel).not.toContainText("Gateway owner key");
  await expect(livePanel).not.toContainText("Tools published for this workspace");

  await page.evaluate(() => { window.propriumPluginGitCalls = { listFiles: 0, read: 0 }; });
  const liveResult = mcpTextResult(await mcpCall("plugin-run-no-capability", "plugin_call", {
    repository_id: 923456791, branch: "main", pluginId, operation: "run", input: { request },
  }));
  expect(liveResult).toMatchObject({ pluginId, value: '{"result":42}' });
  await expect.poll(() => page.evaluate(() => window.propriumPluginGitCalls)).toEqual({ listFiles: 0, read: 0 });
});

test("Host keeps newer editor text when a reviewed plugin proposal refresh finishes late", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const pluginId = "fixture.proposal";
  const fixtureFiles = signedHostPanelFixture(origin, {
    pluginId,
    artifact: component,
    capabilities: ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"],
  });
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const file = fixtureFiles.get(new URL(route.request().url()).pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  const identity = {
    origin: "https://github.com", repositoryId: 923456790, owner: "proprium-test", repository: "plugin-refresh-race",
    branch: "main", localWorkspaceId: `plugin-refresh-race-${crypto.randomUUID()}`,
  };
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async workspace => window.propriumHostTest!.openWorkspace(workspace, { "README.md": "before\n" }), identity);
  await showPanel(page, "outline");
  const files = page.getByRole("list", { name: "Repository files" });
  await chooseFile(page, "README.md");
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await expectEditorText(page, "before\n");

  const panel = page.locator("details.plugin-manager-panel");
  await showPanel(page, "review");
  await panel.locator("summary").click();
  await previewCatalogPlugin(page, pluginId, "1.0.0");
  await expect(page.getByRole("region", { name: "インストールプレビュー" })).toContainText(`${pluginId}@1.0.0`);
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  const plugin = panel.locator(".installed-plugins > li").filter({ hasText: pluginId }).filter({ hasText: "v1.0.0" });
  await plugin.getByRole("checkbox", { name: "workspace.snapshot.read" }).check();
  await plugin.getByRole("checkbox", { name: "workspace.change.propose" }).check();
  await plugin.getByRole("checkbox", { name: "workspace.ui.contribute" }).check();
  await plugin.getByRole("button", { name: "有効化" }).click();

  // The Host's snapshot ID is intentionally random. Adapt only the test fixture's
  // request to the exact immutable snapshot supplied to the real Component.
  await page.evaluate(async () => {
    const moduleUrl = new URL("/src/browser/proprium/plugins/index.ts", location.origin).href;
    const { BrowserPluginManager } = await import(/* @vite-ignore */ moduleUrl);
    type Invocation = {
      pluginId: string;
      request: string;
      snapshot: { id: string; revision: string; files: readonly { path: string; revision: string }[] };
    };
    const original = BrowserPluginManager.prototype.invoke;
    BrowserPluginManager.prototype.invoke = function (this: InstanceType<typeof BrowserPluginManager>, options: Invocation) {
      if (options.pluginId !== "fixture.proposal") return Reflect.apply(original, this, [options]);
      const request = JSON.parse(options.request) as { path: string; content: string };
      const file = options.snapshot.files.find(candidate => candidate.path === request.path);
      if (!file) throw new Error("The proposal fixture path is not present in the Host snapshot.");
      const fixtureRequest = JSON.stringify({
        ...request,
        expectedRevision: file.revision,
        snapshotId: options.snapshot.id,
        snapshotRevision: options.snapshot.revision,
      });
      return Reflect.apply(original, this, [{ ...options, request: fixtureRequest }]);
    };
  });
  await plugin.getByLabel(/プラグイン入力（テキスト）/u).fill(JSON.stringify({ path: "README.md", content: "proposal from plugin\n" }));
  await plugin.getByRole("button", { name: "実行" }).click();
  await expect(panel.getByRole("status")).toContainText("Plugin returned 1 change proposal(s) for Host review.");
  await expect(plugin.getByRole("button", { name: "Review and apply to local worktree" })).toBeVisible();

  await page.evaluate(async () => {
    const moduleUrl = new URL("/src/browser/proprium/git/index.ts", location.origin).href;
    const { BrowserLocalGit } = await import(/* @vite-ignore */ moduleUrl);
    const prototype = BrowserLocalGit.prototype;
    const original = prototype.read;
    window.propriumReadRace = { holdNext: true, started: false };
    prototype.read = async function (this: InstanceType<typeof BrowserLocalGit>, path: string) {
      const result = await Reflect.apply(original, this, [path]);
      const race = window.propriumReadRace;
      if (path === "README.md" && race?.holdNext) {
        race.holdNext = false;
        race.started = true;
        await new Promise<void>(resolve => { race.release = resolve; });
      }
      return result;
    };
  });
  await plugin.getByRole("button", { name: "Review and apply to local worktree" }).click();
  await expect.poll(() => page.evaluate(() => window.propriumReadRace?.started ?? false)).toBe(true);
  await showPanel(page, "editor");
  await editor.fill("newer local text while plugin refresh is pending\n");
  await expectEditorText(page, "newer local text while plugin refresh is pending\n");
  await page.evaluate(() => {
    const race = window.propriumReadRace;
    if (!race?.started || !race.release) throw new Error("The plugin refresh read was not held.");
    race.release();
    race.release = undefined;
  });

  await expectEditorText(page, "newer local text while plugin refresh is pending\n");
  await showPanel(page, "review");
  await expect(panel.getByRole("status")).toContainText("Applied 1 proposed file change(s) to the local worktree.");
  await expect(page.locator(".save-state")).toHaveText("編集中・端末のファイル未保存");
  await showPanel(page, "editor");
  await expect(editor).toBeEnabled();
});
