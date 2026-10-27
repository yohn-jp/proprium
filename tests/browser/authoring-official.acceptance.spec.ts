import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expectEditorText, showPanel } from "./restored-ui.helpers.js";

// These are actual Narrative sources and actual signed registry artifacts. Only
// repository provisioning and the test registry HTTP transport are fixtures.
test("signed Narrative installs and navigates a large work in the real Host", async ({ page }) => {
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const files: Record<string, string> = {
    "plot/volumes/v/volume.yaml": "id: volume-1\ntype: volume\ntitle: Volume One\norder: 1\n",
    "plot/volumes/v/chapters/c/chapter.yaml": "id: chapter-1\ntype: chapter\ntitle: Chapter One\nvolume: volume-1\norder: 1\n",
  };
  for (let n = 1; n <= 301; n++) {
    const id = `scene-${n}`;
    files[`plot/volumes/v/chapters/c/scenes/${id}.yaml`] = `id: ${id}\ntype: scene\ntitle: Scene ${n}\nvolume: volume-1\nchapter: chapter-1\norder: ${n}\nmanuscript: manuscript/custom/${id}.md\n`;
    files[`manuscript/custom/${id}.md`] = n === 301 ? "目的の原稿 |漢字《かんじ》\r\n" + "文".repeat(50000) : `Scene ${n}\n` + "x".repeat(7000);
  }
  expect(Object.keys(files).length).toBeGreaterThan(256);
  expect(Buffer.byteLength(Object.values(files).join(""))).toBeGreaterThan(2 * 1024 * 1024);
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin: "https://github.com", repositoryId: 923456789, owner: "proprium-test", repository: "official-e2e", branch: "main", localWorkspaceId: `official-${crypto.randomUUID()}` }, files), files);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "信頼済みカタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative 0.1.0 の署名済みプレビューを確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.getByRole("listitem").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByText("Volume One", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByText("Volume One", { exact: true }).click();
  await expect(page.getByText("Chapter One", { exact: true })).toBeVisible();
  await page.getByText("Chapter One", { exact: true }).click();
  for (let n = 0; n < 2; n++) await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(page.getByText("Scene 301", { exact: true })).toBeVisible();
  await page.getByText("Scene 301", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("目的の原稿", { timeout: 120_000 });
  await expectEditorText(page, files["manuscript/custom/scene-301.md"]!);
});

test("signed Narrative proposes and applies a reviewed volume", async ({ page }) => {
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const files: Record<string, string> = {
    "plot/volumes/v/volume.yaml": "id: volume-1\ntype: volume\ntitle: Volume One\norder: 1\n",
    "plot/volumes/v/chapters/c/chapter.yaml": "id: chapter-1\ntype: chapter\ntitle: Chapter One\nvolume: volume-1\norder: 1\n",
  };
  for (let n = 1; n <= 3; n++) {
    const id = `scene-${n}`;
    files[`plot/volumes/v/chapters/c/scenes/${id}.yaml`] = `id: ${id}\ntype: scene\ntitle: Scene ${n}\nvolume: volume-1\nchapter: chapter-1\norder: ${n}\nmanuscript: manuscript/custom/${id}.md\n`;
    files[`manuscript/custom/${id}.md`] = n === 3 ? "目的の原稿 |漢字《かんじ》\r\n" + "文".repeat(50000) : `Scene ${n}\n` + "x".repeat(7000);
  }


  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin: "https://github.com", repositoryId: 923456789, owner: "proprium-test", repository: "official-e2e", branch: "main", localWorkspaceId: `official-${crypto.randomUUID()}` }, files), files);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "信頼済みカタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative 0.1.0 の署名済みプレビューを確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.getByRole("listitem").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByText("Volume One", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByText("Volume One", { exact: true }).click();
  await expect(page.getByText("Chapter One", { exact: true })).toBeVisible();
  await page.getByText("Chapter One", { exact: true }).click();

  await expect(page.getByText("Scene 3", { exact: true })).toBeVisible();
  await page.getByText("Scene 3", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("目的の原稿", { timeout: 120_000 });
  await showPanel(page, "review");
  await page.getByRole("button", { name: /巻を作成 proprium.narrative/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "読み込む" }).click();
  await dialog.getByLabel("タイトル").fill("新しい巻");
  await expect(dialog.getByRole("button", { name: "送信" })).toBeEnabled({ timeout: 60000 });
  await dialog.getByRole("button", { name: "送信" }).click();
  await expect(page.getByRole("region", { name: "Authoring proposals" }).getByRole("button").first()).toBeVisible({ timeout: 60000 });
  await dialog.getByRole("button", { name: "巻を作成を閉じる" }).click();
  const review = page.getByRole("region", { name: "Authoring proposals" });
  await review.getByRole("button").first().click();
  await expect(review.getByRole("checkbox").first()).toBeVisible();
  await review.getByRole("checkbox").first().check();
  await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();
  await expect(review.getByRole("button", { name: /proprium.narrative · applied/ })).toBeVisible({ timeout: 60000 });
  await showPanel(page, "outline");
  await expect(page.getByRole("list", { name: "Repository files" }).getByRole("button", { name: "plot/volumes/vol-1/volume.yaml" })).toBeVisible();
});

test("signed Narrative reviews and applies a scene title", async ({ page }) => {
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const files: Record<string, string> = {
    "plot/volumes/v/volume.yaml": "id: volume-1\ntype: volume\ntitle: Volume One\norder: 1\n",
    "plot/volumes/v/chapters/c/chapter.yaml": "id: chapter-1\ntype: chapter\ntitle: Chapter One\nvolume: volume-1\norder: 1\n",
  };
  for (let n = 1; n <= 3; n++) {
    const id = `scene-${n}`;
    files[`plot/volumes/v/chapters/c/scenes/${id}.yaml`] = `id: ${id}\ntype: scene\ntitle: Scene ${n}\nvolume: volume-1\nchapter: chapter-1\norder: ${n}\nmanuscript: manuscript/custom/${id}.md\n`;
    files[`manuscript/custom/${id}.md`] = n === 3 ? "目的の原稿 |漢字《かんじ》\r\n" + "文".repeat(50000) : `Scene ${n}\n` + "x".repeat(7000);
  }


  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin: "https://github.com", repositoryId: 923456789, owner: "proprium-test", repository: "official-e2e", branch: "main", localWorkspaceId: `official-${crypto.randomUUID()}` }, files), files);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "信頼済みカタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative 0.1.0 の署名済みプレビューを確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.getByRole("listitem").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByText("Volume One", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByText("Volume One", { exact: true }).click();
  await expect(page.getByText("Chapter One", { exact: true })).toBeVisible();
  await page.getByText("Chapter One", { exact: true }).click();

  await page.getByRole("button", { name: "Scene 3 を編集対象に選択" }).click();
  await page.getByRole("tab", { name: "名前を変更" }).click();
  const title = page.getByLabel("新しいタイトル");
  await expect(title).toHaveValue("Scene 3", { timeout: 60000 });
  await title.fill("新しい場面名");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await showPanel(page, "review");
  const review = page.getByRole("region", { name: "Authoring proposals" });
  await expect(review.getByRole("button").first()).toBeVisible({ timeout: 60000 });
  await review.getByRole("button").first().click();
  await expect(review).toContainText("新しい場面名");
  await review.getByRole("checkbox").first().check();
  await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();
  await expect(review.getByRole("button", { name: /proprium.narrative · applied/ })).toBeVisible({ timeout: 60000 });
});

test("signed Narrative reviews and applies a scene manuscript link", async ({ page }) => {
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const files: Record<string, string> = {
    "plot/volumes/v/volume.yaml": "id: volume-1\ntype: volume\ntitle: Volume One\norder: 1\n",
    "plot/volumes/v/chapters/c/chapter.yaml": "id: chapter-1\ntype: chapter\ntitle: Chapter One\nvolume: volume-1\norder: 1\n",
  };
  for (let n = 1; n <= 3; n++) {
    const id = `scene-${n}`;
    files[`plot/volumes/v/chapters/c/scenes/${id}.yaml`] = `id: ${id}\ntype: scene\ntitle: Scene ${n}\nvolume: volume-1\nchapter: chapter-1\norder: ${n}\nmanuscript: manuscript/custom/${id}.md\n`;
    files[`manuscript/custom/${id}.md`] = n === 3 ? "目的の原稿 |漢字《かんじ》\r\n" + "文".repeat(50000) : `Scene ${n}\n` + "x".repeat(7000);
  }


  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin: "https://github.com", repositoryId: 923456789, owner: "proprium-test", repository: "official-e2e", branch: "main", localWorkspaceId: `official-${crypto.randomUUID()}` }, files), files);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "信頼済みカタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative 0.1.0 の署名済みプレビューを確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.getByRole("listitem").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByText("Volume One", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByText("Volume One", { exact: true }).click();
  await expect(page.getByText("Chapter One", { exact: true })).toBeVisible();
  await page.getByText("Chapter One", { exact: true }).click();

  await page.getByRole("button", { name: "Scene 3 を編集対象に選択" }).click();
  await page.getByRole("tab", { name: "原稿リンク" }).click();
  const title = page.getByLabel("原稿のパス");
  await expect(title).toHaveValue("manuscript/custom/scene-3.md", { timeout: 60000 });
  await title.fill("manuscript/custom/scene-1.md");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await showPanel(page, "review");
  const review = page.getByRole("region", { name: "Authoring proposals" });
  await expect(review.getByRole("button").first()).toBeVisible({ timeout: 60000 });
  await review.getByRole("button").first().click();
  await expect(review).toContainText("manuscript/custom/scene-1.md");
  await review.getByRole("checkbox").first().check();
  await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();
  await expect(review.getByRole("button", { name: /proprium.narrative · applied/ })).toBeVisible({ timeout: 60000 });
});
