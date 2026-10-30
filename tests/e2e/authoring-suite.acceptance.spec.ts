import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chooseFile, showPanel } from "../browser/restored-ui.helpers.js";
import {
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
  const mobileNavigation = page.getByRole("navigation", { name: "モバイルの主要画面", exact: true });
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
  await page.getByRole("button", { name: "カタログを表示", exact: true }).click();
  const catalog = panel.locator(".registry-plugin-list");
  await expect(catalog).toBeVisible();
  const installInputs: Array<{ plugin_id: string; version: string; manifest_sha256: string; plugin_sha256: string;
    action_ids: string[]; declared_surfaces: Array<{ id: string; title: string; kind: string }>;
    requested_capabilities: string[] }> = [];
  for (const plugin of release.plugins) {
    expect(plugin.actionIds.length, `${plugin.id} has signed typed actions`).toBeGreaterThan(0);
    await expect(catalog).toContainText(plugin.id);
    await page.getByRole("button", { name: `${plugin.id} v${plugin.version} の導入内容と署名を確認`, exact: true }).click();
    const preview = page.getByRole("region", { name: "インストールプレビュー", exact: true });
    await expect(preview).toContainText(`${plugin.id}@${plugin.version}`);
    const packageSummary = preview.locator("li article").filter({ hasText: `${plugin.id}@${plugin.version}` });
    await expect(packageSummary).toBeVisible();
    const permissions = await packageSummary.innerText();
    for (const capability of plugin.capabilities) expect(permissions).toContain(capability);
    await page.getByRole("button", { name: "ダウンロードして無効状態でインストール", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
    const card = panel.getByRole("listitem").filter({ has: page.locator(".plugin-card-head strong", { hasText: new RegExp(`^${plugin.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`) }) }).filter({ hasText: `v${plugin.version}` });
    await expect(card).toBeVisible();
    await expect(card.locator(".plugin-card-head small")).toHaveText(`v${plugin.version} · 無効`);
    installInputs.push({ plugin_id: plugin.id, version: plugin.version,
      manifest_sha256: plugin.manifestDigest, plugin_sha256: plugin.pluginDigest,
      action_ids: [...plugin.actionIds],
      declared_surfaces: plugin.surfaces.map(surface => ({ ...surface })),
      requested_capabilities: [...plugin.capabilities] });
  }

  await page.reload();
  await openRecentWorkspace(page, workspaceName, testInfo.project.name === "webkit-mobile");
  // Reopen the long manuscript through the Host UI; do not open a second Git worker.
  await chooseFile(page, fixture.long_body_path);
  await expect.poll(() => page.locator(".cm-content").evaluate(el => {
    const root = el as HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } };
    return root.cmTile?.root?.view?.state.doc.toString() ?? "";
  })).toContain("最終行");
  const persistedFixture = { ui_reopened_long_body: true, byte_identity: "NOT_CHECKED" };


  await showPanel(page, "review");
  const reloadedPanel = page.locator("details.plugin-manager-panel");
  if (await reloadedPanel.getAttribute("open") === null) await reloadedPanel.locator("summary").click();
  const reloadStates = [];
  for (const plugin of release.plugins) {
    const card = reloadedPanel.getByRole("listitem").filter({ has: page.locator(".plugin-card-head strong", { hasText: new RegExp(`^${plugin.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`) }) }).filter({ hasText: `v${plugin.version}` });
    await expect(card).toBeVisible();
    await expect(card.locator(".plugin-card-head small")).toHaveText(`v${plugin.version} · 無効`);
    for (const capability of plugin.capabilities) {
      const checkbox = card.getByRole("checkbox", { name: capability, exact: true });
      await expect(checkbox).toBeVisible();
      await checkbox.check();
    }
    await card.getByRole("button", { name: "有効化", exact: true }).click();
    await expect(card.locator(".plugin-card-head small")).toHaveText(`v${plugin.version} · 有効（待機中）`);
    reloadStates.push({ plugin_id: plugin.id, state: "enabled-idle", granted_capabilities: [...plugin.capabilities] });
  }

  const exposedPanels: Array<{ plugin_id: string; surface_id: string; title: string }> = [];
  const workspaceConfiguration = page.locator("details.st-workspace-configuration");
  await expect(workspaceConfiguration).toBeVisible();
  if (await workspaceConfiguration.getAttribute("open") === null) await workspaceConfiguration.locator(":scope > summary").click();
  const panelMenu = workspaceConfiguration.locator("details.st-workspace-panel-menu");
  if (await panelMenu.getAttribute("open") === null) await panelMenu.locator(":scope > summary").click();
  for (const plugin of release.plugins) for (const surface of plugin.surfaces.filter(item => item.kind === "panel")) {
    const show = panelMenu.getByRole("button", { name: `${surface.title}を表示する`, exact: true });
    if (await show.count()) await show.click();
    else await expect(panelMenu.getByRole("button", { name: `${surface.title}を閉じる`, exact: true })).toBeVisible();
    const surfaceTab = page.getByRole("tab", { name: surface.title, exact: true }).first();
    if (await surfaceTab.count() && await surfaceTab.getAttribute("aria-selected") !== "true") await surfaceTab.click();
    await expect(page.locator(".authoring-surface").getByRole("heading", { name: surface.title, level: 2, exact: true })).toBeVisible();
    exposedPanels.push({ plugin_id: plugin.id, surface_id: surface.id, title: surface.title });
  }

  await page.reload();
  await openRecentWorkspace(page, workspaceName, testInfo.project.name === "webkit-mobile");
  await showPanel(page, "review");
  const enabledPanel = page.locator("details.plugin-manager-panel");
  if (await enabledPanel.getAttribute("open") === null) await enabledPanel.locator("summary").click();
  for (const plugin of release.plugins) {
    const card = enabledPanel.getByRole("listitem").filter({ has: page.locator(".plugin-card-head strong", { hasText: new RegExp(`^${plugin.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`) }) }).filter({ hasText: `v${plugin.version}` });
    await expect(card).toBeVisible();
    await expect(card.locator(".plugin-card-head small")).toHaveText(`v${plugin.version} · 有効（待機中）`);
  }

  // Exercise a real leaf package through disable, uninstall and verified reinstall.
  const leaf = release.plugins.find(plugin => plugin.id === "proprium.publishing")!;
  const leafCard = enabledPanel.getByRole("listitem").filter({ has: page.locator(".plugin-card-head strong", { hasText: /^proprium\.publishing$/ }) }).filter({ hasText: `v${leaf.version} ·` });
  await leafCard.getByRole("button", { name: "無効化", exact: true }).click();
  await expect(leafCard.locator(".plugin-card-head small")).toHaveText(`v${leaf.version} · 無効`);
  page.once("dialog", dialog => void dialog.accept());
  await leafCard.getByRole("button", { name: "アンインストール", exact: true }).click();
  await expect(leafCard).toHaveCount(0);
  await enabledPanel.getByRole("button", { name: "更新", exact: true }).click();
  await page.getByRole("button", { name: `${leaf.id} v${leaf.version} の導入内容と署名を確認`, exact: true }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール", exact: true }).click();
  await expect(leafCard.locator(".plugin-card-head small")).toHaveText(`v${leaf.version} · 無効`);

  // Metadata-only patch versions reuse the exact previously verified source components.
  // A newer root-signed snapshot retains the old entries and delegates new manifests.
  const fixtureDir = process.env.PROPRIUM_VERSION_FIXTURE_DIR;
  if (fixtureDir) {
    const registryUrl = process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL!;
    const origin = new URL(registryUrl).origin;
    const artifactBase = new URL(release.registry.artifactBase);
    const next = await readFile(join(fixtureDir, "next.json"));
    const signature = await readFile(join(fixtureDir, "next.json.sig"));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.href === registryUrl) return route.fulfill({status:200, contentType:"application/json",body:next,headers:{"cache-control":"no-store"}});
      if (url.href === `${registryUrl}.sig`) return route.fulfill({status:200,contentType:"application/octet-stream",body:signature,headers:{"cache-control":"no-store"}});
      if (url.origin === artifactBase.origin && url.pathname.startsWith(artifactBase.pathname)) {
        const relative = decodeURIComponent(url.pathname.slice(artifactBase.pathname.length));
        if (!/^[A-Za-z0-9._/-]+$/u.test(relative) || relative.split("/").some(part => part === "." || part === ".." || !part)) return route.fulfill({status:400});
        try { const body = await readFile(join(fixtureDir, relative)); return route.fulfill({status:200,body,contentType:relative.endsWith(".json") ? "application/json" : relative.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",headers:{"access-control-allow-origin":origin,"cache-control":"no-store"}}); }
        catch { return route.fulfill({status:404}); }
      }
      return route.fallback();
    });
    // Disable dependents first, then update and roll back a leaf package.
    // This tests real retained bytes, while versions are fixture metadata only.
    const leafVersion = leaf.version.split("."); leafVersion[2] = String(Number(leafVersion[2]) + 1);
    const patchVersion = leafVersion.join(".");
    page.once("dialog", dialog => void dialog.accept(patchVersion));
    await leafCard.getByRole("button", {name:"バージョンを更新",exact:true}).click();
    await page.getByRole("button", {name:"ダウンロードして更新版を固定",exact:true}).click();
    const patchCard = enabledPanel.getByRole("listitem").filter({has:page.locator(".plugin-card-head strong",{hasText:/^proprium\.publishing$/})}).filter({hasText:`v${patchVersion}`});
    await expect(patchCard).toContainText(`pinned ${patchVersion}`);
    await patchCard.getByRole("button",{name:"以前の版に戻す",exact:true}).click();
    await expect(leafCard).toContainText(`pinned ${leaf.version}`);
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
      real_leaf_lifecycle: { plugin_id: leaf.id, disable: "PASS", uninstall: "PASS", reinstall: "PASS", update_rollback: fixtureDir ? "PASS (metadata-only patch fixture)" : "NOT_CHECKED" },
      host_rendered_panels: exposedPanels,
      assertions_excluded: ["feature acceptance", "action outputs", "MCP/UI equivalence", "ChangeWriter receipt", "R01-R14 status", "R14 source parity"],
    }, null, 2)}\n`),
  });
});
