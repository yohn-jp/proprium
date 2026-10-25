import { showPanel, expectEditorText, chooseFile } from "./restored-ui.helpers.js";
import { expect, test } from "@playwright/test";
import { createHash, createPrivateKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

declare global {
  interface Window {
    propriumHostTest?: {
      openWorkspace(identity: import("../../app/src/browser/proprium/git/protocol.js").WorkspaceIdentity, files?: Record<string, string>): Promise<void>;
    };
    propriumDropLiveEventStream?: () => Promise<void>;
    propriumGatewayRequestPaths?: string[];
    propriumHoldGitStatus?: boolean;
    propriumGitStatusStarted?: boolean;
    propriumReleaseGitStatus?: () => void;
    propriumGatewayDeleteStarted?: boolean;
    propriumReleaseGatewayDelete?: () => void;
    __propriumGatewayFetches?: Array<{ path: string; credentials: RequestCredentials }>;
  }
}

interface ServedFile { body: Buffer; contentType: string; }
interface JsonRpcResponse { jsonrpc: string; id: string; result?: unknown; error?: { code: number; message: string }; }
const gatewayOrigin = process.env.VITE_PROPRIUM_GATEWAY_URL ?? "http://127.0.0.1:4174";
let fixtureDirectory: string;
let sumComponent: Buffer;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicKeyBytes(publicKey: KeyObject): Buffer {
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32);
}

function signedHostPanelFixture(origin: string): Map<string, ServedFile> {
  const registryUrl = `${origin}/plugin-fixture/registry.json`;
  const artifactBase = `${origin}/plugin-fixture/artifacts/`;
  const pluginId = "fixture.compute-sum";
  const artifactBytes = sumComponent;
  const publisher = generateKeyPairSync("ed25519");
  const registryKey = process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY;
  if (!registryKey) throw new Error("The Playwright config did not create the test-only registry signing key.");
  const registrySigner = createPrivateKey(registryKey);
  const assetPath = `${pluginId}/1.0.0/${sha256(artifactBytes)}/plugin.component.wasm`;
  const manifestBytes = Buffer.from(JSON.stringify({
    schema: "proprium.plugin/v1",
    id: pluginId,
    version: "1.0.0",
    abi: "proprium.component/v1",
    entrypoint: assetPath,
    capabilities: [],
    artifacts: [{ path: assetPath, bytes: artifactBytes.byteLength, sha256: sha256(artifactBytes), mediaType: "application/wasm" }],
  }), "utf8");
  const manifestPath = `${pluginId}/1.0.0/manifest/${sha256(manifestBytes)}.json`;
  const registryBytes = Buffer.from(JSON.stringify({
    schema: "proprium.registry/v1",
    id: "fixture.registry",
    version: "1.0.0",
    artifactBase,
    plugins: [{
      id: pluginId,
      version: "1.0.0",
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      manifestSignature: ed25519Sign(null, manifestBytes, publisher.privateKey).toString("base64"),
      publisherKey: publicKeyBytes(publisher.publicKey).toString("base64"),
      dependencies: [],
    }],
  }), "utf8");
  const files = new Map<string, ServedFile>();
  files.set(new URL(registryUrl).pathname, { body: registryBytes, contentType: "application/json" });
  files.set(`${new URL(registryUrl).pathname}.sig`, { body: ed25519Sign(null, registryBytes, registrySigner), contentType: "application/octet-stream" });
  files.set(new URL(manifestPath, artifactBase).pathname, { body: manifestBytes, contentType: "application/json" });
  files.set(new URL(assetPath, artifactBase).pathname, { body: artifactBytes, contentType: "application/wasm" });
  return files;
}

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "proprium-gateway-plugin-"));
  const componentPath = join(fixtureDirectory, "sum.component.wasm");
  execFileSync("pnpm", [
    "--config.verifyDepsBeforeRun=false", "exec", "jco", "componentize",
    "tests/fixtures/plugin-compute-sum.ts",
    "--wit", "app/src/browser/proprium/plugin-runtime/wit",
    "--world-name", "proprium:plugin/plugin@1.0.0",
    "--disable", "all", "--bundle", "-o", componentPath,
  ], { cwd: resolve("."), stdio: "pipe" });
  sumComponent = readFileSync(componentPath);
});

test.afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

async function mcpRequest(request: Record<string, unknown>, version = "2026-07-28"): Promise<{ status: number; body: JsonRpcResponse | null }> {
  const method = String(request.method);
  const params = { ...(request.params as Record<string, unknown> | undefined) };
  if (version === "2026-07-28") {
    params._meta = {
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientInfo": { name: "Proprium Browser E2E", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }
  const wireRequest = { ...request, ...(request.params ? { params } : {}) };
  const name = typeof params.name === "string" ? params.name : undefined;
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
  };
  if (name) headers["Mcp-Name"] = name;
  const response = await fetch(`${gatewayOrigin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(wireRequest),
    cache: "no-store",
    redirect: "error",
  });
  const source = await response.text();
  let body: JsonRpcResponse | null = null;
  if (source.trim()) {
    const json = source.startsWith("data:") ? source.split(/\r?\n/u).find(line => line.startsWith("data:"))?.slice(5).trim() : source;
    if (json) body = JSON.parse(json) as JsonRpcResponse;
  }
  return { status: response.status, body };
}

async function mcpCall(id: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const response = await mcpRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body?.error).toBeUndefined();
  return response.body!;
}

function textResult(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content?: Array<{ type: string; text?: string }> };
  const text = result.content?.find(item => item.type === "text")?.text;
  if (!text) throw new Error(`MCP response did not contain text content: ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function openWorkspace(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/?e2e=1");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async () => window.propriumHostTest!.openWorkspace({
    origin: "https://github.com",
    repositoryId: 923456789,
    owner: "proprium-test",
    repository: "gateway-live-workspace",
    branch: "main",
    localWorkspaceId: `gateway-${crypto.randomUUID()}`,
  }, { "README.md": "Gateway browser integration fixture.\n" }));
  await showPanel(page, "outline");
  await chooseFile(page, "README.md");
}


const sampleRepositoryId = 923456789;
const sampleRepository = { repository_id: sampleRepositoryId, branch: "main" };

async function waitForMCP(page: import("@playwright/test").Page): Promise<void> {
  await showPanel(page, "review");
  await expect(page.locator(".live-mcp-panel").getByRole("status").first()).toContainText("ブラウザーに接続中", { timeout: 20_000 });
}

test("exposes the fixed MCP tools without any client token and executes against the active Browser Host", async ({ page, context }, testInfo) => {
  const toolsWithoutHost = await mcpRequest({ jsonrpc: "2.0", id: "list-offline", method: "tools/list", params: {} });
  expect(toolsWithoutHost.status).toBe(200);
  const names = (toolsWithoutHost.body?.result as { tools: Array<{ name: string }> }).tools.map(item => item.name);
  expect(names).toEqual(["file_read", "files_list", "git_log", "git_status", "plugin_call", "proposal_submit", "repositories_list", "repository_info"]);
  const unavailable = await mcpRequest({
    jsonrpc: "2.0", id: "call-offline", method: "tools/call",
    params: { name: "repository_info", arguments: sampleRepository },
  });
  expect(unavailable.status).toBe(503);

  const accessCookie = "CF_Authorization_fixture=browser-e2e-edge-cookie";
  const accessCookiePaths = new Set<string>();
  await page.addInitScript(({ origin }) => {
    const calls: Array<{ path: string; credentials: RequestCredentials }> = [];
    Object.defineProperty(window, "__propriumGatewayFetches", { value: calls });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl, window.location.href);
      if (url.origin === origin && url.pathname.startsWith("/live/")) {
        calls.push({ path: url.pathname, credentials: init?.credentials ?? (input instanceof Request ? input.credentials : "same-origin") });
      }
      return originalFetch(input, init);
    };
  }, { origin: gatewayOrigin });
  await context.addCookies([{ name: "CF_Authorization_fixture", value: "browser-e2e-edge-cookie", url: gatewayOrigin, sameSite: "Lax" }]);
  await context.route("**/live/**", async route => {
    const request = route.request();
    if (!request.url().startsWith(gatewayOrigin)) return route.continue();
    const headers = await request.allHeaders();
    if (request.method() !== "OPTIONS" && (headers.cookie ?? "").split(";").some(value => value.trim() === accessCookie)) {
      accessCookiePaths.add(request.method() + " " + new URL(request.url()).pathname);
    }
    await route.continue();
  });
  await openWorkspace(page);
  await waitForMCP(page);
  await expect(page.locator(".live-mcp-panel")).not.toContainText("Gateway owner key");
  await expect(page.locator(".live-mcp-panel")).not.toContainText("Client capabilities");
  await expect(page.locator(".live-mcp-panel")).not.toContainText("Tools published for this workspace");

  // The Browser Host, not the Gateway, resolves immutable GitHub repository IDs.
  const repositories = textResult(await mcpCall("repos", "repositories_list", {}));
  expect(repositories).toEqual(expect.arrayContaining([expect.objectContaining({ repository_id: sampleRepositoryId, branch: "main", active: true })]));
  expect(textResult(await mcpCall("info", "repository_info", sampleRepository))).toMatchObject({ repository_id: sampleRepositoryId, branch: "main" });
  expect(textResult(await mcpCall("files", "files_list", sampleRepository))).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md" })]));
  const file = textResult(await mcpCall("read", "file_read", { ...sampleRepository, path: "README.md" }));
  expect(file).toMatchObject({ content: "Gateway browser integration fixture.\n", path: "README.md" });
  expect(file.revision).toBeTruthy();
  expect(textResult(await mcpCall("status", "git_status", sampleRepository))).toHaveProperty("entries");
  expect(textResult(await mcpCall("log", "git_log", { ...sampleRepository, limit: 10 }))).toEqual([]);
  const missingRepository = textResult(await mcpCall("unknown", "repository_info", { repository_id: 123456 }));
  expect(missingRepository.error).toContain("repository_unavailable");
  const missingID = await mcpRequest({ jsonrpc: "2.0", id: "missing-id", method: "tools/call", params: { name: "file_read", arguments: { path: "README.md" } } });
  expect(missingID.status).toBe(400);

  const origin = new URL(page.url()).origin;
  const pluginFiles = signedHostPanelFixture(origin);
  await page.route(origin + "/plugin-fixture/**", async route => {
    const found = pluginFiles.get(new URL(route.request().url()).pathname);
    if (!found) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: found.contentType, body: found.body });
  });
  const pluginPanel = page.locator("details.plugin-manager-panel");
  await pluginPanel.locator("summary").click();
  await page.getByLabel("Install from trusted registry").fill("fixture.compute-sum");
  await page.getByLabel("Version (optional: latest stable)").fill("1.0.0");
  await page.getByRole("button", { name: "Verify and preview" }).click();
  await page.getByRole("button", { name: "Download and install disabled" }).click();
  const plugin = page.getByRole("listitem").filter({ hasText: "fixture.compute-sum" }).filter({ hasText: "v1.0.0" });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(pluginPanel.getByRole("status")).toContainText("fixture.compute-sum@1.0.0 is enabled");
  const result = textResult(await mcpCall("plugin", "plugin_call", {
    ...sampleRepository, pluginId: "fixture.compute-sum", operation: "run",
    input: { request: JSON.stringify({ left: 20, right: 22 }) },
  }));
  expect(result).toMatchObject({ value: '{"result":42}' });

  const proposed = await mcpCall("propose", "proposal_submit", {
    ...sampleRepository, title: "Review a change from MCP",
    changes: [{ path: "README.md", content: "Approved in Browser Host.\n", expectedRevision: file.revision }],
  });
  expect(textResult(proposed)).toMatchObject({ status: "awaiting_host_review", repository_id: sampleRepositoryId });
  await expect(page.getByText("Review a change from MCP", { exact: true })).toBeVisible();
  await expectEditorText(page, "Gateway browser integration fixture.\n");
  await page.getByRole("button", { name: "Review and approve" }).click();
  await expectEditorText(page, "Approved in Browser Host.\n");

  const fetches = await page.evaluate(() => window.__propriumGatewayFetches ?? []);
  expect(fetches.length).toBeGreaterThan(0);
  expect(fetches.every(entry => entry.credentials === "include")).toBe(true);
  expect(fetches.some(entry => entry.path === "/live/sessions")).toBe(true);
  expect(fetches.some(entry => entry.path.endsWith("/events"))).toBe(true);
  expect(fetches.some(entry => entry.path.endsWith("/responses"))).toBe(true);
  if (testInfo.project.name === "desktop-chromium") {
    expect([...accessCookiePaths]).toContain("POST /live/sessions");
  }

  await context.setOffline(true);
  const editor = page.getByLabel("原稿 Markdown");
  await editor.fill("Local work continues while the Gateway is disconnected.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft on this device", { exact: true })).toBeVisible();
  await showPanel(page, "inspector");
  await page.getByLabel("Commit message").fill("Commit while disconnected from Gateway");
  await page.getByLabel("Git author name").fill("Proprium Gateway E2E");
  await page.getByLabel("Git author email").fill("gateway-e2e@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();
  await expect(page.getByText(/^Committed locally · [a-f0-9]{8}$/u)).toBeVisible();
  await context.setOffline(false);
});

test("selects locally cached repositories by immutable ID without switching the active workspace", async ({ page }) => {
  await openWorkspace(page);
  await waitForMCP(page);
  const secondRepositoryId = 923456790;
  await page.evaluate(async ({ id }) => {
    await window.propriumHostTest!.openWorkspace({
      origin: "https://github.com",
      repositoryId: id,
      owner: "proprium-test",
      repository: "another-workspace",
      branch: "main",
      localWorkspaceId: "other-" + crypto.randomUUID(),
    }, { "README.md": "Second repository content.\n" });
  }, { id: secondRepositoryId });
  await waitForMCP(page);
  const available = textResult(await mcpCall("both", "repositories_list", {})) as unknown as Array<{ repository_id: number; active: boolean }>;
  expect(available).toEqual(expect.arrayContaining([
    expect.objectContaining({ repository_id: sampleRepositoryId, active: false }),
    expect.objectContaining({ repository_id: secondRepositoryId, active: true }),
  ]));
  const first = textResult(await mcpCall("read-original", "file_read", {
    repository_id: sampleRepositoryId, branch: "main", path: "README.md",
  }));
  expect(first.content).toBe("Gateway browser integration fixture.\n");
  const second = textResult(await mcpCall("read-second", "file_read", {
    repository_id: secondRepositoryId, branch: "main", path: "README.md",
  }));
  expect(second.content).toBe("Second repository content.\n");
});

test("a disconnected Browser Host leaves tools listed but rejects calls without implicit failover", async ({ page }) => {
  await openWorkspace(page);
  await waitForMCP(page);
  const connected = await mcpCall("before-close", "repository_info", sampleRepository);
  expect(textResult(connected)).toMatchObject({ repository_id: sampleRepositoryId });
  await page.close();
  await expect.poll(async () => (await mcpRequest({
    jsonrpc: "2.0", id: "after-close", method: "tools/call",
    params: { name: "repository_info", arguments: sampleRepository },
  })).status, { timeout: 15_000 }).toBe(503);
  const listed = await mcpRequest({ jsonrpc: "2.0", id: "after-close-list", method: "tools/list", params: {} });
  expect(listed.status).toBe(200);
  const names = (listed.body?.result as { tools: Array<{ name: string }> }).tools.map(item => item.name);
  expect(names).toContain("repositories_list");
});
