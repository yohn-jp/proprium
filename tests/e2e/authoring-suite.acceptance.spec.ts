import { expect, test } from "@playwright/test";
import { showPanel } from "../browser/restored-ui.helpers.js";
import {
  inspectSyntheticAuthoringWork,
  loadSignedAuthoringRelease,
  routeSignedAuthoringRelease,
  seedSyntheticAuthoringWork,
  type VerifiedAuthoringRelease,
} from "./authoring-suite.helpers.js";

let release: VerifiedAuthoringRelease;

async function openMobileLibrary(page: import("@playwright/test").Page): Promise<void> {
  const libraryEmptyStateButton = page.getByRole("button", { name: "作品ライブラリを開く", exact: true });
  if (await libraryEmptyStateButton.count()) {
    await libraryEmptyStateButton.first().click();
    return;
  }
  const mobileNavigation = page.getByRole("navigation", { name: "モバイル画面", exact: true });
  if (await mobileNavigation.isVisible()) await mobileNavigation.getByRole("button", { name: "作品", exact: true }).click();
}

async function openRecentWorkspace(page: import("@playwright/test").Page, workspaceName: string, mobile: boolean): Promise<void> {
  if (mobile) await openMobileLibrary(page);
  const escapedName = workspaceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const recent = page.getByRole("button", { name: new RegExp(escapedName) }).first();
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(page.locator(".host-message[role='status']")).toContainText("ローカル作品を開きました");
}

test.beforeAll(async () => {
  const publicKey = process.env.PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY ?? process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY ?? "";
  const registryUrl = process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL ?? "";
  release = await loadSignedAuthoringRelease(process.env.PROPRIUM_AUTHORING_REGISTRY_DIR ?? "", publicKey, registryUrl);
});

test("normal Host installs and enables all independently signed authoring Components, then reloads persisted work and plugin state", async ({ page }, testInfo) => {
  test.setTimeout(20 * 60 * 1000);
  await routeSignedAuthoringRelease(page, release);
  const workspaceName = `Authoring certification ${testInfo.project.name} ${crypto.randomUUID()}`;
  await page.goto("/");
  if (testInfo.project.name === "webkit-mobile") await openMobileLibrary(page);
  await page.getByLabel("作品名", { exact: true }).fill(workspaceName);
  await page.getByRole("button", { name: "ローカル作品を作成", exact: true }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("ローカル作品を開きました");

  const fixture = await seedSyntheticAuthoringWork(page, workspaceName);
  expect(fixture.scene_count).toBe(301);
  expect(fixture.file_count).toBeGreaterThan(256);
  expect(fixture.total_bytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(fixture.long_body_bytes).toBeGreaterThan(130 * 1024);

  await showPanel(page, "review");
  const panel = page.locator("details.plugin-manager-panel");
  await expect(panel).toBeVisible();
  if (await panel.getAttribute("open") === null) await panel.locator("summary").click();
  await page.getByRole("button", { name: "信頼済みカタログを表示", exact: true }).click();
  const catalog = panel.locator(".registry-plugin-list");
  await expect(catalog).toBeVisible();
  const installInputs: Array<{ plugin_id: string; version: string; manifest_sha256: string; plugin_sha256: string;
    action_ids: string[]; declared_surfaces: Array<{ id: string; title: string; kind: string }>;
    requested_capabilities: string[] }> = [];
  for (const plugin of release.plugins) {
    expect(plugin.actionIds.length, `${plugin.id} has signed typed actions`).toBeGreaterThan(0);
    await expect(catalog).toContainText(plugin.id);
    await page.getByRole("button", { name: `${plugin.id} ${plugin.version} の署名済みプレビューを確認`, exact: true }).click();
    const preview = page.getByRole("region", { name: "インストールプレビュー", exact: true });
    await expect(preview).toContainText(`${plugin.id}@${plugin.version}`);
    const packageSummary = preview.locator("li article").filter({ hasText: `${plugin.id}@${plugin.version}` });
    await expect(packageSummary).toBeVisible();
    const permissions = await packageSummary.innerText();
    for (const capability of plugin.capabilities) expect(permissions).toContain(capability);
    await page.getByRole("button", { name: "ダウンロードして無効状態でインストール", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
    const card = panel.getByRole("listitem").filter({ hasText: plugin.id }).filter({ hasText: `v${plugin.version}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText("installed, disabled");
    installInputs.push({ plugin_id: plugin.id, version: plugin.version,
      manifest_sha256: plugin.manifestDigest, plugin_sha256: plugin.pluginDigest,
      action_ids: [...plugin.actionIds],
      declared_surfaces: plugin.surfaces.map(surface => ({ ...surface })),
      requested_capabilities: [...plugin.capabilities] });
  }

  await page.reload();
  await openRecentWorkspace(page, workspaceName, testInfo.project.name === "webkit-mobile");
  const persistedFixture = await inspectSyntheticAuthoringWork(page, workspaceName, fixture.long_body_path);
  expect(persistedFixture).toMatchObject({
    scene_count: fixture.scene_count,
    file_count: fixture.file_count,
    long_body_bytes: fixture.long_body_bytes,
    long_body_sha256: fixture.long_body_sha256,
  });

  await showPanel(page, "review");
  const reloadedPanel = page.locator("details.plugin-manager-panel");
  if (await reloadedPanel.getAttribute("open") === null) await reloadedPanel.locator("summary").click();
  const reloadStates = [];
  for (const plugin of release.plugins) {
    const card = reloadedPanel.getByRole("listitem").filter({ hasText: plugin.id }).filter({ hasText: `v${plugin.version}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText("installed, disabled");
    for (const capability of plugin.capabilities) {
      const checkbox = card.getByRole("checkbox", { name: capability, exact: true });
      await expect(checkbox).toBeVisible();
      await checkbox.check();
    }
    await card.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(card).toContainText(`${plugin.id}@${plugin.version} is enabled`);
    reloadStates.push({ plugin_id: plugin.id, state: "enabled-idle", granted_capabilities: [...plugin.capabilities] });
  }

  const exposedPanels: Array<{ plugin_id: string; surface_id: string; title: string }> = [];
  const workspaceConfiguration = page.locator("details.st-workspace-configuration");
  await expect(workspaceConfiguration).toBeVisible();
  if (await workspaceConfiguration.getAttribute("open") === null) await workspaceConfiguration.locator("summary").click();
  const panelMenu = workspaceConfiguration.locator("details.st-workspace-panel-menu");
  if (await panelMenu.getAttribute("open") === null) await panelMenu.locator("summary").click();
  for (const plugin of release.plugins) for (const surface of plugin.surfaces.filter(item => item.kind === "panel")) {
    const show = panelMenu.getByRole("button", { name: `${surface.title}を表示する`, exact: true });
    if (await show.count()) await show.click();
    else await expect(panelMenu.getByRole("button", { name: `${surface.title}を閉じる`, exact: true })).toBeVisible();
    const surfaceTab = page.getByRole("tab", { name: surface.title, exact: true }).first();
    if (await surfaceTab.count() && await surfaceTab.getAttribute("aria-selected") !== "true") await surfaceTab.click();
    await expect(page.getByRole("heading", { name: surface.title, level: 2, exact: true })).toBeVisible();
    exposedPanels.push({ plugin_id: plugin.id, surface_id: surface.id, title: surface.title });
  }

  await page.reload();
  await openRecentWorkspace(page, workspaceName, testInfo.project.name === "webkit-mobile");
  await showPanel(page, "review");
  const enabledPanel = page.locator("details.plugin-manager-panel");
  if (await enabledPanel.getAttribute("open") === null) await enabledPanel.locator("summary").click();
  for (const plugin of release.plugins) {
    const card = enabledPanel.getByRole("listitem").filter({ hasText: plugin.id }).filter({ hasText: `v${plugin.version}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText("enabled, idle");
  }

  await testInfo.attach("authoring-signed-release-and-host-install.json", {
    contentType: "application/json",
    body: Buffer.from(`${JSON.stringify({
      evidence_kind: "distribution_install_reload_smoke_only",
      registry: { id: release.registry.id, version: release.registry.version, sha256: release.registryDigest },
      browser_project: testInfo.project.name,
      workspace: fixture,
      reloaded_workspace: persistedFixture,
      plugins: installInputs,
      reloaded_plugin_states: reloadStates,
      host_rendered_panels: exposedPanels,
      assertions_excluded: ["feature acceptance", "action outputs", "MCP/UI equivalence", "ChangeWriter receipt", "R01-R14 status", "R14 source parity"],
    }, null, 2)}\n`),
  });
});
