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
  }
}

interface ServedFile { body: Buffer; contentType: string; }
interface JsonRpcResponse { jsonrpc: string; id: string; result?: unknown; error?: { code: number; message: string }; }
const ownerKey = "proprium-gateway-browser-e2e-owner-key-32-bytes";
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

async function mcpRequest(page: import("@playwright/test").Page, token: string, request: Record<string, unknown>, version = "2026-07-28"): Promise<{ status: number; body: JsonRpcResponse | null }> {
  return page.evaluate(async ({ gatewayOrigin, token, request, version }) => {
    const method = String(request.method);
    const params = request.params as Record<string, unknown> | undefined;
    const name = typeof params?.name === "string" ? params.name : undefined;
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": version,
      "Mcp-Method": method,
    };
    if (name) headers["Mcp-Name"] = name;
    const response = await fetch(`${gatewayOrigin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    const source = await response.text();
    let body: JsonRpcResponse | null = null;
    if (source.trim()) {
      const json = source.startsWith("data:") ? source.split(/\r?\n/u).find(line => line.startsWith("data:"))?.slice(5).trim() : source;
      if (json) body = JSON.parse(json) as JsonRpcResponse;
    }
    return { status: response.status, body };
  }, { gatewayOrigin, token, request, version });
}

async function mcpCall(page: import("@playwright/test").Page, token: string, id: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const response = await mcpRequest(page, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
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
  const filesToggle = page.getByRole("button", { name: /^Files(?:\s|$)/u });
  if (await filesToggle.isVisible()) await filesToggle.click();
  await page.getByRole("list", { name: "Repository files" }).getByRole("button", { name: "README.md" }).click();
}

async function enableLiveMcp(page: import("@playwright/test").Page): Promise<void> {
  const live = page.getByText("Live MCP", { exact: true });
  await expect(live).toBeVisible();
  await page.locator("#live-gateway-url").fill(gatewayOrigin);
  await page.locator("#live-owner-key").fill(ownerKey);
  const toolNames = ["capabilities_list", "files_list", "file_read", "git_log", "git_status", "plugin_call", "proposal_submit", "workspace_info"];
  for (const tool of toolNames) await page.getByLabel(tool, { exact: true }).check();
  await page.getByRole("button", { name: "Enable Live MCP" }).click();
  await expect(page.getByText(/^Live on .+\/mcp\./u)).toBeVisible({ timeout: 15_000 });
}

async function authorizeClient(page: import("@playwright/test").Page): Promise<string> {
  await page.locator("#mcp-client-name").fill("Browser integration MCP client");
  for (const tool of ["capabilities_list", "files_list", "file_read", "git_log", "git_status", "plugin_call", "proposal_submit", "workspace_info"]) {
    await page.getByLabel(tool, { exact: true }).last().check();
  }
  await page.getByRole("button", { name: "Authorize client" }).click();
  const tokenField = page.getByLabel("New MCP client token");
  await expect(tokenField).toBeVisible();
  return (await tokenField.inputValue()).trim();
}

test("a live browser Workspace serves real MCP calls through Go SSE and HTTP, and stops on disconnect", async ({ page, context }) => {
  await openWorkspace(page);
  const origin = new URL(page.url()).origin;
  const pluginFiles = signedHostPanelFixture(origin);
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const file = pluginFiles.get(new URL(route.request().url()).pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  const panel = page.locator("details.plugin-manager-panel");
  await panel.locator("summary").click();
  await page.getByLabel("Install from trusted registry").fill("fixture.compute-sum");
  await page.getByLabel("Version (optional: latest stable)").fill("1.0.0");
  await page.getByRole("button", { name: "Verify and preview" }).click();
  await page.getByRole("button", { name: "Download and install disabled" }).click();
  const plugin = page.getByRole("listitem").filter({ hasText: "fixture.compute-sum" }).filter({ hasText: "v1.0.0" });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(panel.getByRole("status")).toContainText("fixture.compute-sum@1.0.0 is enabled");

  const eventConnections: string[] = [];
  let webSocketConnections = 0;
  page.on("request", request => {
    if (request.url().includes("/live/sessions/") && request.url().endsWith("/events")) eventConnections.push(request.url());
  });
  page.on("websocket", () => { webSocketConnections += 1; });
  await enableLiveMcp(page);
  await page.waitForTimeout(600);
  expect(eventConnections).toHaveLength(1);
  expect(webSocketConnections).toBe(0);
  const token = await authorizeClient(page);

  // Exercise the current stable Streamable HTTP transport with its required
  // routing headers, through the real browser-to-Go HTTP connection.
  const listed = await mcpRequest(page, token, { jsonrpc: "2.0", id: "tools-modern", method: "tools/list", params: {} });
  expect(listed.status).toBe(200);
  const available = (listed.body?.result as { tools?: Array<{ name: string }> }).tools?.map(tool => tool.name) ?? [];
  expect(available).toEqual(expect.arrayContaining(["workspace_info", "files_list", "file_read", "git_status", "git_log", "capabilities_list", "plugin_call", "proposal_submit"]));

  // Keep compatibility with the 2025-11-25 initialize handshake requested
  // for existing MCP clients while the published transport uses the latest
  // stable revision above.
  const initialized = await mcpRequest(page, token, {
    jsonrpc: "2.0", id: "initialize-legacy", method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Proprium Browser E2E", version: "1.0.0" } },
  }, "2025-11-25");
  expect(initialized.status).toBe(200);
  expect((initialized.body?.result as { protocolVersion?: string }).protocolVersion).toBe("2025-11-25");
  await mcpRequest(page, token, { jsonrpc: "2.0", method: "notifications/initialized" }, "2025-11-25");

  expect(textResult(await mcpCall(page, token, "info-1", "workspace_info", {}))).toMatchObject({ id: expect.stringContaining("gateway-") });
  expect(textResult(await mcpCall(page, token, "files-1", "files_list", {}))).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: "README.md" })]) });
  const read = textResult(await mcpCall(page, token, "read-1", "file_read", { path: "README.md" }));
  expect(read).toMatchObject({ path: "README.md", content: "Gateway browser integration fixture.\n" });
  expect(read.revision).toBeTruthy();
  expect(textResult(await mcpCall(page, token, "git-status", "git_status", {}))).toHaveProperty("entries");
  expect(textResult(await mcpCall(page, token, "git-log", "git_log", { limit: 10 }))).toHaveProperty("commits");
  expect(textResult(await mcpCall(page, token, "caps", "capabilities_list", {}))).toHaveProperty("capabilities");

  const pluginRun = textResult(await mcpCall(page, token, "plugin-run", "plugin_call", {
    pluginId: "fixture.compute-sum",
    operation: "run",
    input: { request: JSON.stringify({ left: 20, right: 22 }) },
  }));
  expect(pluginRun).toMatchObject({ value: '{"result":42}' });

  const revision = read.revision as string | { oid?: string | null };
  const expectedRevision = typeof revision === "string" ? revision : revision.oid;
  expect(expectedRevision).toBeTruthy();
  const proposal = await mcpCall(page, token, "proposal-1", "proposal_submit", {
    title: "Review a change from the MCP client",
    changes: [{ path: "README.md", content: "Approved by the workspace owner.\n", expectedRevision }],
  });
  expect(proposal.error).toBeUndefined();
  await expect(page.getByText("Review a change from the MCP client", { exact: true })).toBeVisible();
  await expect(page.getByLabel("File contents")).toHaveValue("Gateway browser integration fixture.\n");
  await page.getByRole("button", { name: "Review and approve" }).click();
  await expect(page.getByLabel("File contents")).toHaveValue("Approved by the workspace owner.\n");

  await page.getByRole("button", { name: "Disable Live MCP" }).click();
  await expect(page.getByText("Live MCP is disabled", { exact: true })).toBeVisible();
  const afterDisconnect = await mcpRequest(page, token, { jsonrpc: "2.0", id: "after-close", method: "tools/list", params: {} });
  expect(afterDisconnect.status).toBeGreaterThanOrEqual(400);
  expect(afterDisconnect.body?.error).toBeDefined();

  await context.setOffline(true);
  const editor = page.getByLabel("File contents");
  await editor.fill("Local work continues while the Gateway is disconnected.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft on this device", { exact: true })).toBeVisible();
  await page.getByLabel("Commit message").fill("Commit while disconnected from the Gateway");
  await page.getByLabel("Git author name").fill("Proprium Gateway E2E");
  await page.getByLabel("Git author email").fill("gateway-e2e@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();
  await expect(page.getByText(/^Committed locally · [a-f0-9]{8}$/u)).toBeVisible();
  await page.getByLabel("Plugin request").fill(JSON.stringify({ left: 20, right: 22 }));
  await plugin.getByRole("button", { name: "Run" }).click();
  await expect(page.getByLabel("fixture.compute-sum output")).toHaveText('{"result":42}');
});
