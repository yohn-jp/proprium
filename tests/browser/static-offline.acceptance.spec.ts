import { showPanel, expectEditorText, chooseFile, reviewChangedFiles, configureGateway } from "./restored-ui.helpers.js";
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
  liveGatewayUrl,
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
  test.skip(useLiveGitHub && (!liveGatewayUrl || !liveGitHubToken || !liveGitHubOwner || !liveGitHubRepository || !liveGitHubBranch ||
    ["main", "master"].includes(liveGitHubBranch.toLowerCase()) || !Number.isSafeInteger(liveGitHubRepositoryId) || liveGitHubRepositoryId <= 0),
  "Live static acceptance requires PROPRIUM_E2E_GATEWAY_URL, an in-memory test token, and an explicit disposable non-main branch.");

  const configuredOrigin = process.env.PROPRIUM_E2E_STATIC_BASE_URL
    ? new URL(process.env.PROPRIUM_E2E_STATIC_BASE_URL).origin
    : `http://127.0.0.1:${process.env.PROPRIUM_E2E_STATIC_PORT ?? "4276"}`;
  const fixture = useLiveGitHub ? null : await installStaticGitHubFixture(page, configuredOrigin);
  if (useLiveGitHub) await routeFixtureRelay(page, configuredOrigin, liveGatewayUrl);
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
    await configureGateway(page, liveGatewayUrl);
    await page.getByRole("button", { name: "GitHubに接続" }).click();
    await expect(operationNotice).toContainText(/Connected to GitHub as /u);
    if (liveGitHubLogin) await expect(operationNotice).toContainText(liveGitHubLogin);
    await page.getByLabel("Repository").selectOption(String(liveGitHubRepositoryId));
    await page.getByLabel("ブランチ").selectOption(liveGitHubBranch);
    await page.getByRole("button", { name: "作品を開く" }).click();
    await expect(operationNotice).toContainText(`Opened ${workspaceTitle}`);
  } else {
    await configureGateway(page, configuredOrigin);
    await page.getByRole("button", { name: "GitHubに接続" }).click();
    await expect(operationNotice).toContainText(`Connected to GitHub as ${staticFixtureLogin}`);
    await page.getByLabel("Repository").selectOption(String(staticFixtureIdentity.repositoryId));
    await page.getByLabel("ブランチ").selectOption(staticFixtureIdentity.branch);
    await page.getByRole("button", { name: "作品を開く" }).click();
    await expect(operationNotice).toContainText(`Opened ${staticFixtureTitle} at GitHub commit ${fixture!.head}.`);
  }
  const files = page.getByRole("list", { name: "Repository files" });
  const revealFilesSidebar = async (): Promise<void> => {
    await showPanel(page, "outline");
    await expect(files).toBeVisible();
  };
  await revealFilesSidebar();
  if (fixture) {
    await chooseFile(page, "README.md");
    await expectEditorText(page, fixture.content);
    await showPanel(page, "history");
    await expect(page.getByRole("heading", { name: "Static browser acceptance fixture", exact: true })).toBeVisible();
    await expect(page.locator(".git-history-list code").filter({ hasText: fixture.head.slice(0, 10) })).toBeVisible();
  }

  await revealFilesSidebar();
  const panel = page.locator("details.plugin-manager-panel");
  await showPanel(page, "review");
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: `${staticPluginId} v${staticPluginVersion} の導入内容と署名を確認`, exact: true }).click();
  const preview = page.getByRole("region", { name: "インストールプレビュー" });
  await expect(preview).toContainText(`${staticPluginId}@${staticPluginVersion}`);
  await expect(preview).toContainText("要求する権限: なし");
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  const panelNotice = panel.getByRole("status");
  await expect(panelNotice).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = panel.locator(".installed-plugins > li").filter({ hasText: staticPluginId }).filter({ hasText: `v${staticPluginVersion}` });
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(panelNotice).toContainText(`${staticPluginId}@${staticPluginVersion} is enabled`);
  await page.getByLabel("プラグイン入力（テキスト）", { exact: false }).fill(JSON.stringify({ left: 20, right: 22 }));
  await plugin.getByRole("button", { name: "実行" }).click();
  await expect(page.getByLabel(`${staticPluginId} output`)).toHaveText('{"result":42}');
  await plugin.getByRole("button", { name: "停止" }).click();
  await expect(plugin).toContainText(`v${staticPluginVersion} · 無効`);
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
  await expect(page.getByRole("heading", { name: "作品を作る・開く" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const recentWorkspace = page.getByRole("button")
    .filter({ hasText: workspaceTitle });
  await expect(recentWorkspace).toBeVisible();
  await recentWorkspace.click();
  await expect(operationNotice).toContainText("この端末の作品を開きました。");

  await revealFilesSidebar();
  const offlineFile = `.proprium-static-${crypto.randomUUID()}.txt`;
  await page.getByLabel("New file path").fill(offlineFile);
  await page.getByRole("button", { name: "Create new file" }).click();
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await expect(editor).toBeVisible();
  await editor.fill("Edited and committed from the cached static Host while offline.\n");
  await page.getByRole("button", { name: "端末に保存" }).click();
  await expect(operationNotice).toContainText("saved to this browser's local Git worktree");
  await showPanel(page, "inspector");
  await page.getByLabel("変更の説明").fill("Verify offline editing from the static Host");
  await page.getByLabel("Git author name").fill("Proprium Static Acceptance");
  await page.getByLabel("Git author email").fill("static-acceptance@example.invalid");
  await reviewChangedFiles(page);
  await page.getByRole("button", { name: "ローカルGitにコミット" }).click();
  const localCommit = operationNotice.filter({ hasText: "Committed locally as" });
  await expect(localCommit).toContainText("This commit is still only on this device.");
  await expect(page.getByText(/^端末のGitに記録済み · [a-f0-9]{8}$/u)).toBeVisible();

  const reopenedPluginPanel = page.locator("details.plugin-manager-panel");
  await revealFilesSidebar();
  await showPanel(page, "review");
  await reopenedPluginPanel.locator("summary").click();
  const reopenedPlugin = reopenedPluginPanel.locator(".installed-plugins > li").filter({ hasText: staticPluginId }).filter({ hasText: `v${staticPluginVersion}` });
  await expect(reopenedPlugin).toContainText(`v${staticPluginVersion} · 無効`);
  await reopenedPlugin.getByRole("button", { name: "有効化" }).click();
  await page.getByLabel("プラグイン入力（テキスト）", { exact: false }).fill(JSON.stringify({ left: 19, right: 23 }));
  await reopenedPlugin.getByRole("button", { name: "実行" }).click();
  await expect(page.getByLabel(`${staticPluginId} output`)).toHaveText('{"result":42}');
  await reopenedPlugin.getByRole("button", { name: "停止" }).click();
  expect(pluginRequestCount).toBe(pluginRequestsAfterInstall);
  if (fixture && githubRequestsBeforeOffline !== undefined) expect(fixture.apiRequests()).toBe(githubRequestsBeforeOffline);
});
