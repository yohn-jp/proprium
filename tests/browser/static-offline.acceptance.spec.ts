import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  liveGitHubBranch,
  liveGitHubLogin,
  liveGitHubOwner,
  liveGitHubRepository,
  liveGitHubRepositoryId,
  liveGitHubToken,
  routeFixtureRelay,
} from "./github-fixture-relay.js";
import {
  installStaticGitHubFixture,
  staticFixtureIdentity,
  staticFixtureLogin,
  staticFixtureTitle,
} from "./static-github-fixture.js";
import { signedStaticPluginFixture, staticPluginId, staticPluginVersion } from "./static-plugin-fixture.js";

declare global {
  interface Window {
    propriumReleaseStaticServiceWorker?: () => Promise<ServiceWorkerRegistration>;
  }
}

let pluginFixtureDirectory: string;
let pluginComponent: Buffer;

test.beforeAll(() => {
  pluginFixtureDirectory = mkdtempSync(join(tmpdir(), "proprium-static-plugin-"));
  const componentPath = join(pluginFixtureDirectory, "sum.component.wasm");
  execFileSync("pnpm", [
    "--config.verifyDepsBeforeRun=false", "exec", "jco", "componentize",
    "tests/fixtures/plugin-compute-sum.ts",
    "--wit", "app/src/browser/proprium/plugin-runtime/wit",
    "--world-name", "proprium:plugin/plugin@1.0.0",
    "--disable", "all", "--bundle", "-o", componentPath,
  ], { cwd: resolve("."), stdio: "pipe" });
  pluginComponent = readFileSync(componentPath);
});

test.afterAll(() => rmSync(pluginFixtureDirectory, { recursive: true, force: true }));

test("static Host imports a GitHub REST commit, reloads offline, and edits with a new cached Git worker", async ({ page, context }, testInfo) => {
  const deferMobileServiceWorker = testInfo.project.name === "static-mobile-webkit";
  const useLiveGitHub = process.env.PROPRIUM_E2E_STATIC_LIVE_GITHUB === "true";
  test.skip(useLiveGitHub && (!liveGitHubToken || !liveGitHubOwner || !liveGitHubRepository || !liveGitHubBranch ||
    ["main", "master"].includes(liveGitHubBranch.toLowerCase()) || !Number.isSafeInteger(liveGitHubRepositoryId) || liveGitHubRepositoryId <= 0),
  "Live static acceptance requires an in-memory test token and an explicit disposable non-main branch.");

  const configuredOrigin = process.env.PROPRIUM_E2E_STATIC_BASE_URL
    ? new URL(process.env.PROPRIUM_E2E_STATIC_BASE_URL).origin
    : `http://127.0.0.1:${process.env.PROPRIUM_E2E_STATIC_PORT ?? "4276"}`;
  const fixture = useLiveGitHub ? null : await installStaticGitHubFixture(page, configuredOrigin);
  if (useLiveGitHub) await routeFixtureRelay(page, configuredOrigin, configuredOrigin);
  const workspaceTitle = useLiveGitHub ? `${liveGitHubOwner}/${liveGitHubRepository} · ${liveGitHubBranch}` : staticFixtureTitle;
  const pluginFiles = signedStaticPluginFixture(configuredOrigin, pluginComponent);
  let pluginRequestCount = 0;
  await page.context().route(`${configuredOrigin}/plugin-fixture/**`, async route => {
    pluginRequestCount += 1;
    const file = pluginFiles.get(new URL(route.request().url()).pathname);
    if (!file) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });

  await page.addInitScript((deferRegistration: boolean) => {
    window.open = () => null;
    if (!deferRegistration || !("serviceWorker" in navigator)) return;

    // Playwright WebKit does not reliably route requests initiated by a page after
    // its Service Worker takes control. Keep this Host's registration call queued
    // until the synthetic OAuth/GitHub/plugin HTTP fixtures are done. The test
    // explicitly releases the actual production registration before going offline.
    const container = navigator.serviceWorker;
    const original = container.register.bind(container);
    let pending: { scriptURL: string | URL; options?: RegistrationOptions } | undefined;
    let resolveRegistration: ((registration: ServiceWorkerRegistration) => void) | undefined;
    let rejectRegistration: ((error: unknown) => void) | undefined;
    const queued = new Promise<ServiceWorkerRegistration>((resolve, reject) => {
      resolveRegistration = resolve;
      rejectRegistration = reject;
    });
    Object.defineProperty(container, "register", {
      configurable: true,
      value: (scriptURL: string | URL, options?: RegistrationOptions) => {
        pending = { scriptURL, options };
        return queued;
      },
    });
    window.propriumReleaseStaticServiceWorker = async () => {
      if (!pending || !resolveRegistration || !rejectRegistration) throw new Error("The Host did not request its offline Service Worker.");
      const request = pending;
      pending = undefined;
      delete window.propriumReleaseStaticServiceWorker;
      Object.defineProperty(container, "register", { configurable: true, value: original });
      try {
        const registration = await original(request.scriptURL, request.options);
        resolveRegistration(registration);
        return registration;
      } catch (error) {
        rejectRegistration(error);
        throw error;
      }
    };
  }, deferMobileServiceWorker);
  await page.goto("/");
  const operationNotice = page.locator(".host-message[role='status']");

  const origin = new URL(page.url()).origin;
  expect(origin).toBe(configuredOrigin);
  if (useLiveGitHub) {
    await page.getByLabel("GitHub auth relay URL").fill(origin);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(operationNotice).toContainText(/Connected to GitHub as /u);
    if (liveGitHubLogin) await expect(operationNotice).toContainText(liveGitHubLogin);
    await page.getByLabel("Repository").selectOption(String(liveGitHubRepositoryId));
    await page.getByLabel("Branch").fill(liveGitHubBranch);
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(operationNotice).toContainText(`Opened ${workspaceTitle}`);
  } else {
    await page.getByLabel("GitHub auth relay URL").fill(origin);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(operationNotice).toContainText(`Connected to GitHub as ${staticFixtureLogin}`);
    await page.getByLabel("Repository").selectOption(String(staticFixtureIdentity.repositoryId));
    await page.getByLabel("Branch").fill(staticFixtureIdentity.branch);
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(operationNotice).toContainText(`Opened ${staticFixtureTitle} at GitHub commit ${fixture!.head}.`);
  }
  const files = page.getByRole("list", { name: "Repository files" });
  const mobileFiles = page.getByRole("button", { name: /^Files(?:\s|$)/u });
  if (await mobileFiles.isVisible() && !(await files.isVisible())) await mobileFiles.click();
  await expect(files).toBeVisible();
  if (fixture) {
    await files.getByRole("button", { name: "README.md" }).click();
    await expect(page.getByRole("textbox", { name: "File contents" })).toHaveValue(fixture.content);
    await expect(page.getByText("Static browser acceptance fixture", { exact: true })).toBeVisible();
    await expect(page.locator("code").filter({ hasText: fixture.head.slice(0, 10) })).toBeVisible();
  }

  if (await mobileFiles.isVisible() && !(await files.isVisible())) await mobileFiles.click();
  const panel = page.locator("details.plugin-manager-panel");
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  await page.getByLabel("Install from trusted registry").fill(staticPluginId);
  await page.getByLabel("Version (optional: latest stable)").fill(staticPluginVersion);
  await page.getByRole("button", { name: "Verify and preview" }).click();
  const preview = page.getByRole("region", { name: "Plugin installation preview" });
  await expect(preview).toContainText(`${staticPluginId}@${staticPluginVersion}`);
  await expect(preview).toContainText("Capabilities: none");
  await page.getByRole("button", { name: "Download and install disabled" }).click();
  const panelNotice = panel.getByRole("status");
  await expect(panelNotice).toContainText("Plugin artifact bytes passed signature and digest verification");
  const plugin = panel.getByRole("listitem").filter({ hasText: staticPluginId }).filter({ hasText: `v${staticPluginVersion}` });
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(panelNotice).toContainText(`${staticPluginId}@${staticPluginVersion} is enabled`);
  await page.getByLabel("Plugin request").fill(JSON.stringify({ left: 20, right: 22 }));
  await plugin.getByRole("button", { name: "Run" }).click();
  await expect(page.getByLabel(`${staticPluginId} output`)).toHaveText('{"result":42}');
  await plugin.getByRole("button", { name: "Stop" }).click();
  await expect(plugin).toContainText(`v${staticPluginVersion} · installed, disabled`);
  const pluginRequestsAfterInstall = pluginRequestCount;
  const githubRequestsBeforeOffline = fixture?.apiRequests();

  if (deferMobileServiceWorker) {
    const registration = await page.evaluate(async () => {
      if (!window.propriumReleaseStaticServiceWorker) throw new Error("Expected the WebKit fixture registration hold.");
      const registered = await window.propriumReleaseStaticServiceWorker();
      return { scope: registered.scope };
    });
    expect(registration.scope).toBe(`${configuredOrigin}/`);
  }
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active !== null;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Open a GitHub workspace" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const recentWorkspace = page.getByRole("button")
    .filter({ hasText: workspaceTitle });
  await expect(recentWorkspace).toBeVisible();
  await recentWorkspace.click();

  const recentFiles = page.getByRole("list", { name: "Repository files" });
  if (await mobileFiles.isVisible() && !(await recentFiles.isVisible())) await mobileFiles.click();
  await expect(recentFiles).toBeVisible();
  const offlineFile = `.proprium-static-${crypto.randomUUID()}.txt`;
  await page.getByLabel("New file path").fill(offlineFile);
  await page.getByRole("button", { name: "Create new file" }).click();
  const editor = page.getByRole("textbox", { name: "File contents" });
  await expect(editor).toBeVisible();
  await editor.fill("Edited and committed from the cached static Host while offline.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(operationNotice).toContainText("saved to this browser's local Git worktree");
  await page.getByLabel("Commit message").fill("Verify offline editing from the static Host");
  await page.getByLabel("Git author name").fill("Proprium Static Acceptance");
  await page.getByLabel("Git author email").fill("static-acceptance@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();
  const localCommit = operationNotice.filter({ hasText: "Committed locally as" });
  await expect(localCommit).toContainText("This commit is still only on this device.");
  await expect(page.getByText(/^Committed locally · [a-f0-9]{8}$/u)).toBeVisible();

  const reopenedPluginPanel = page.locator("details.plugin-manager-panel");
  await reopenedPluginPanel.locator("summary").click();
  const reopenedPlugin = reopenedPluginPanel.getByRole("listitem").filter({ hasText: staticPluginId }).filter({ hasText: `v${staticPluginVersion}` });
  await expect(reopenedPlugin).toContainText(`v${staticPluginVersion} · installed, disabled`);
  await reopenedPlugin.getByRole("button", { name: "Enable" }).click();
  await page.getByLabel("Plugin request").fill(JSON.stringify({ left: 19, right: 23 }));
  await reopenedPlugin.getByRole("button", { name: "Run" }).click();
  await expect(page.getByLabel(`${staticPluginId} output`)).toHaveText('{"result":42}');
  await reopenedPlugin.getByRole("button", { name: "Stop" }).click();
  expect(pluginRequestCount).toBe(pluginRequestsAfterInstall);
  if (fixture && githubRequestsBeforeOffline !== undefined) expect(fixture.apiRequests()).toBe(githubRequestsBeforeOffline);
});
