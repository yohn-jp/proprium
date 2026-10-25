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

async function mcpRequest(token: string, request: Record<string, unknown>, version = "2026-07-28"): Promise<{ status: number; body: JsonRpcResponse | null }> {
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
    Authorization: `Bearer ${token}`,
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

async function mcpCall(token: string, id: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const response = await mcpRequest(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
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

async function showWorkspaceTools(page: import("@playwright/test").Page): Promise<void> { await showPanel(page, "review"); }
async function hideWorkspaceTools(page: import("@playwright/test").Page): Promise<void> { await showPanel(page, "editor"); }

async function enableLiveMcp(page: import("@playwright/test").Page): Promise<void> {
  await showWorkspaceTools(page);
  const panel = page.locator("details.live-mcp-panel");
  await showPanel(page, "review");
  await panel.locator("summary").click();
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

test("a live browser Workspace serves real MCP calls through Go SSE and HTTP, and stops on disconnect", async ({ page, context }, testInfo) => {
  const accessCookie = "CF_Authorization_fixture=browser-e2e-edge-cookie";
  const accessCookiePaths = new Set<string>();
  await page.addInitScript(({ origin }) => {
    const calls: Array<{ path: string; credentials: RequestCredentials }> = [];
    Object.defineProperty(window, "__propriumGatewayFetches", { value: calls });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const requestUrl = new URL(rawUrl, window.location.href);
      if (requestUrl.origin === origin && requestUrl.pathname.startsWith("/live/")) {
        calls.push({
          path: requestUrl.pathname,
          credentials: init?.credentials ?? (input instanceof Request ? input.credentials : "same-origin"),
        });
      }
      return originalFetch(input, init);
    };
  }, { origin: gatewayOrigin });
  await context.addCookies([{ name: "CF_Authorization_fixture", value: "browser-e2e-edge-cookie", url: gatewayOrigin, sameSite: "Lax" }]);
  await context.route(`${gatewayOrigin}/live/**`, async route => {
    const request = route.request();
    const headers = await request.allHeaders();
    if (request.method() !== "OPTIONS" && (headers.cookie ?? "").split(";").some(value => value.trim() === accessCookie)) {
      accessCookiePaths.add(`${request.method()} ${new URL(request.url()).pathname}`);
    }
    await route.continue();
  });
  await openWorkspace(page);
  const origin = new URL(page.url()).origin;
  const pluginFiles = signedHostPanelFixture(origin);
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const file = pluginFiles.get(new URL(route.request().url()).pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  await showWorkspaceTools(page);
  const panel = page.locator("details.plugin-manager-panel");
  await showPanel(page, "review");
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
  // routing headers as a native MCP client against the real Go Gateway.
  const listed = await mcpRequest(token, { jsonrpc: "2.0", id: "tools-modern", method: "tools/list", params: {} });
  expect(listed.status).toBe(200);
  const available = (listed.body?.result as { tools?: Array<{ name: string }> }).tools?.map(tool => tool.name) ?? [];
  expect(available).toEqual(expect.arrayContaining(["workspace_info", "files_list", "file_read", "git_status", "git_log", "capabilities_list", "plugin_call", "proposal_submit"]));

  // Keep compatibility with the 2025-11-25 initialize handshake requested
  // for existing MCP clients while the published transport uses the latest
  // stable revision above.
  const initialized = await mcpRequest(token, {
    jsonrpc: "2.0", id: "initialize-legacy", method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Proprium Browser E2E", version: "1.0.0" } },
  }, "2025-11-25");
  expect(initialized.status).toBe(200);
  expect((initialized.body?.result as { protocolVersion?: string }).protocolVersion).toBe("2025-11-25");
  await mcpRequest(token, { jsonrpc: "2.0", method: "notifications/initialized" }, "2025-11-25");

  expect(textResult(await mcpCall(token, "info-1", "workspace_info", {}))).toMatchObject({ workspaceId: expect.stringContaining("gateway-") });
  expect(textResult(await mcpCall(token, "files-1", "files_list", {}))).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md" })]));
  const read = textResult(await mcpCall(token, "read-1", "file_read", { path: "README.md" }));
  expect(read).toMatchObject({ path: "README.md", content: "Gateway browser integration fixture.\n" });
  expect(read.revision).toBeTruthy();
  expect(textResult(await mcpCall(token, "git-status", "git_status", {}))).toHaveProperty("entries");
  expect(textResult(await mcpCall(token, "git-log", "git_log", { limit: 10 }))).toEqual([]);
  expect(textResult(await mcpCall(token, "caps", "capabilities_list", {}))).toEqual(expect.arrayContaining(["file_read", "plugin_call", "proposal_submit"]));

  const pluginRun = textResult(await mcpCall(token, "plugin-run", "plugin_call", {
    pluginId: "fixture.compute-sum",
    operation: "run",
    input: { request: JSON.stringify({ left: 20, right: 22 }) },
  }));
  expect(pluginRun).toMatchObject({ value: '{"result":42}' });

  const expectedRevision = read.revision as string;
  expect(expectedRevision).toBeTruthy();
  const proposal = await mcpCall(token, "proposal-1", "proposal_submit", {
    title: "Review a change from the MCP client",
    changes: [{ path: "README.md", content: "Approved by the workspace owner.\n", expectedRevision }],
  });
  expect(proposal.error).toBeUndefined();
  await expect(page.getByText("Review a change from the MCP client", { exact: true })).toBeVisible();
  await expectEditorText(page, "Gateway browser integration fixture.\n");
  expect(textResult(await mcpCall(token, "read-with-tools-hidden", "file_read", { path: "README.md" }))).toMatchObject({ content: "Gateway browser integration fixture.\n" });
  const gatewayFetches = await page.evaluate(() => window.__propriumGatewayFetches ?? []);
  expect(gatewayFetches.length).toBeGreaterThan(0);
  expect(gatewayFetches.every(call => call.credentials === "include")).toBe(true);
  expect(gatewayFetches.some(call => call.path === "/live/sessions")).toBe(true);
  expect(gatewayFetches.some(call => call.path.endsWith("/events"))).toBe(true);
  expect(gatewayFetches.some(call => call.path.endsWith("/responses"))).toBe(true);
  // Chromium additionally exposes the fake Access cookie on intercepted
  // requests; WebKit's synthetic route does not establish cookie forwarding.
  if (testInfo.project.name === "desktop-chromium") {
    expect([...accessCookiePaths]).toContain("POST /live/sessions");
    expect([...accessCookiePaths].some(path => path.endsWith("/events"))).toBe(true);
    expect([...accessCookiePaths].some(path => path.endsWith("/responses"))).toBe(true);
  }
  await showWorkspaceTools(page);
  await page.getByRole("button", { name: "Review and approve" }).click();
  await expectEditorText(page, "Approved by the workspace owner.\n");

  await showWorkspaceTools(page);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("list", { name: "Authorized MCP clients" }).getByRole("listitem")).toHaveCount(0);
  const revoked = await mcpRequest(token, { jsonrpc: "2.0", id: "revoked", method: "tools/list", params: {} });
  expect(revoked.status).toBe(401);
  const nextToken = await authorizeClient(page);

  await page.getByRole("button", { name: "Stop Live MCP" }).click();
  await expect(page.locator("details.live-mcp-panel").getByRole("status")).toHaveCount(0);
  await page.locator("details.live-mcp-panel summary").click();
  await expect(page.getByRole("button", { name: "Enable Live MCP" })).toBeVisible();
  const afterDisconnect = await mcpRequest(nextToken, { jsonrpc: "2.0", id: "after-close", method: "tools/list", params: {} });
  expect(afterDisconnect.status).toBeGreaterThanOrEqual(400);
  expect(afterDisconnect.body?.error).toBeDefined();

  await hideWorkspaceTools(page);
  await context.setOffline(true);
  const editor = page.getByLabel("原稿 Markdown");
  await editor.fill("Local work continues while the Gateway is disconnected.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft on this device", { exact: true })).toBeVisible();
  await showPanel(page, "inspector");
  await page.getByLabel("Commit message").fill("Commit while disconnected from the Gateway");
  await page.getByLabel("Git author name").fill("Proprium Gateway E2E");
  await page.getByLabel("Git author email").fill("gateway-e2e@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();
  await expect(page.getByText(/^Committed locally · [a-f0-9]{8}$/u)).toBeVisible();
  await showWorkspaceTools(page);
  await page.getByLabel("Plugin request").fill(JSON.stringify({ left: 20, right: 22 }));
  await plugin.getByRole("button", { name: "Run" }).click();
  await expect(page.getByLabel("fixture.compute-sum output")).toHaveText('{"result":42}');
});

test("an unexpected Live SSE disconnect clears the Browser Host session and cancels pending MCP work", async ({ page }) => {
  await page.addInitScript(({ origin }) => {
    const paths: string[] = [];
    Object.defineProperty(window, "propriumGatewayRequestPaths", { value: paths });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const requestUrl = new URL(rawUrl, window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (requestUrl.origin === origin && requestUrl.pathname.startsWith("/live/")) {
        paths.push(`${method} ${requestUrl.pathname}`);
      }
      if (requestUrl.origin === origin && method === "DELETE" && /^\/live\/sessions\/[^/]+$/u.test(requestUrl.pathname)) {
        window.propriumGatewayDeleteStarted = true;
        await new Promise<void>(resolve => { window.propriumReleaseGatewayDelete = resolve; });
      }
      const response = await originalFetch(input, init);
      if (requestUrl.origin !== origin || !requestUrl.pathname.endsWith("/events") || !response.body) return response;

      const source = response.body.getReader();
      let dropped = false;
      Object.defineProperty(window, "propriumDropLiveEventStream", {
        configurable: true,
        value: async () => {
          if (dropped) return;
          dropped = true;
          await source.cancel("fixture SSE transport failure").catch(() => undefined);
        },
      });
      const body = new ReadableStream<Uint8Array>({
        start(destination) {
          void (async () => {
            try {
              while (true) {
                const { done, value } = await source.read();
                if (done) {
                  if (dropped) destination.error(new Error("fixture SSE transport failure"));
                  else destination.close();
                  return;
                }
                destination.enqueue(value);
              }
            } catch (error) { destination.error(error); }
          })();
        },
        cancel(reason) {
          dropped = true;
          void source.cancel(reason).catch(() => undefined);
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }, { origin: gatewayOrigin });

  await openWorkspace(page);
  await page.evaluate(async () => {
    const moduleUrl = new URL("/src/browser/proprium/git/index.ts", location.origin).href;
    const runtime = await import(/* @vite-ignore */ moduleUrl) as unknown as {
      BrowserLocalGit: { prototype: Record<string, (...args: unknown[]) => unknown> };
    };
    const prototype = runtime.BrowserLocalGit.prototype;
    const originalStatus = prototype.status;
    prototype.status = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      if (window.propriumHoldGitStatus) {
        window.propriumGitStatusStarted = true;
        await new Promise<void>(resolve => { window.propriumReleaseGitStatus = resolve; });
      }
      return Reflect.apply(originalStatus, this, args);
    };
    window.propriumHoldGitStatus = true;
    window.propriumGitStatusStarted = false;
  });

  const eventConnections: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/live/sessions/") && request.url().endsWith("/events")) eventConnections.push(request.url());
  });
  await enableLiveMcp(page);
  const token = await authorizeClient(page);
  const pendingCall = mcpRequest(token, { jsonrpc: "2.0", id: "disconnect-pending-status", method: "tools/call", params: { name: "git_status", arguments: {} } });
  await expect.poll(() => page.evaluate(() => window.propriumGitStatusStarted === true)).toBe(true);
  await expect(page.locator("details.live-mcp-panel")).toContainText("Running: git_status");

  await page.evaluate(async () => {
    if (!window.propriumDropLiveEventStream) throw new Error("The fixture did not capture the live event stream.");
    await window.propriumDropLiveEventStream();
  });
  const unavailable = await pendingCall;
  expect(unavailable.status).toBe(503);
  expect(unavailable.body?.error?.message).toBe("Workspace unavailable");
  const livePanel = page.locator("details.live-mcp-panel");
  await expect(livePanel.getByRole("status")).toContainText("Gateway disconnected");
  await expect(livePanel.getByRole("alert")).toContainText("connection to the Gateway was lost");
  await expect(page.getByRole("button", { name: "Enable Live MCP" })).toBeVisible();
  await expect(page.getByLabel("New MCP client token")).toHaveCount(0);
  await expect(livePanel.getByRole("list", { name: "Authorized MCP clients" }).getByRole("listitem")).toHaveCount(0);
  await expect(livePanel).not.toContainText("Running: git_status");
  await expect(livePanel.getByRole("status")).not.toContainText("Live on");

  await page.evaluate(() => window.propriumReleaseGitStatus?.());
  await expect(livePanel.getByText("git_status: cancelled", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.propriumGatewayRequestPaths?.filter(path => path.endsWith("/responses")).length ?? 0)).toBe(0);
  await page.waitForTimeout(500);
  expect(eventConnections).toHaveLength(1);
  expect(await page.evaluate(() => window.propriumGatewayRequestPaths?.filter(path => path.endsWith("/events")).length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.propriumGatewayDeleteStarted === true)).toBe(true);
  await page.evaluate(() => window.propriumReleaseGatewayDelete?.());

  await page.getByLabel("Gateway owner key").fill(ownerKey);
  await page.getByRole("button", { name: "Enable Live MCP" }).click();
  await expect(page.getByText(/^Live on .+\/mcp\./u)).toBeVisible({ timeout: 15_000 });
  await expect(livePanel).toContainText("No requests running.");
  await expect(livePanel.getByRole("list", { name: "Authorized MCP clients" }).getByRole("listitem")).toHaveCount(0);
  expect(eventConnections).toHaveLength(2);
});
