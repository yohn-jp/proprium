import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expectEditorText, reviewChangedFiles, showPanel } from "./restored-ui.helpers.js";

async function showNarrativeOutline(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("tabpanel", { name: "Work outline", exact: true }).first().getByRole("tab", { name: "構成", exact: true }).click();
}

async function activateNarrativeOutline(page: import("@playwright/test").Page): Promise<import("@playwright/test").Locator> {
  let tab = page.getByRole("tab", { name: "Work outline", exact: true }).first();
  if (!(await tab.isVisible())) {
    const configuration = page.locator(".st-workspace-configuration");
    if (await configuration.getAttribute("open") === null) await configuration.locator(":scope > summary").click();
    const menu = page.locator(".st-workspace-panel-menu");
    if (await menu.getAttribute("open") === null) await menu.locator(":scope > summary").click();
    await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
    if (await configuration.getAttribute("open") !== null) await configuration.locator(":scope > summary").click();
    tab = page.getByRole("tab", { name: "Work outline", exact: true }).first();
  }
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  return page.getByRole("tabpanel", { name: "Work outline", exact: true }).first();
}

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
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  const outlinePanel = page.getByRole("tabpanel", { name: "Work outline", exact: true }).first();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(outlinePanel.getByRole("status")).toContainText("このリポジトリの作品構成を認識しました。");
  await showNarrativeOutline(page);
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

test("signed Narrative explains an unrecognized repository and leaves generic Files available", async ({ page }) => {
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const files = { "README.md": "通常のメモです。作品構成はありません。\n" };
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin: "https://github.com", repositoryId: 923456790, owner: "proprium-test", repository: "ordinary-files", branch: "main", localWorkspaceId: `ordinary-${crypto.randomUUID()}` }, files), files);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) await plugin.getByRole("checkbox", { name: capability, exact: true }).check();
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const outline = page.getByRole("tabpanel", { name: "Work outline", exact: true }).first();
  await outline.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(outline.getByRole("status")).toContainText("作品構成は見つかりません。通常のファイル表示はそのまま利用でき", { timeout: 60_000 });
  await expect(page.getByRole("list", { name: "Repository files" }).getByRole("button", { name: "README.md" })).toBeVisible();
});

test("signed Narrative reorders chapters and scenes with accessible move controls", async ({ page }) => {
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const identity = { origin: "https://github.com" as const, repositoryId: 923456791, owner: "proprium-test", repository: "reorder-e2e", branch: "main", localWorkspaceId: `reorder-${crypto.randomUUID()}` };
  const files: Record<string, string> = {
    "plot/volumes/v/volume.yaml": "id: volume-1\ntype: volume\ntitle: Volume One\norder: 1\n",
    "plot/volumes/v/chapters/a/chapter.yaml": "id: chapter-one\ntype: chapter\ntitle: Chapter One\nvolume: volume-1\norder: 1\n",
    "plot/volumes/v/chapters/b/chapter.yaml": "id: chapter-two\ntype: chapter\ntitle: Chapter Two\nvolume: volume-1\norder: 2\n",
    "plot/volumes/v/chapters/a/scenes/one.yaml": "id: scene-one\ntype: scene\ntitle: Scene One\nvolume: volume-1\nchapter: chapter-one\norder: 1\nmanuscript: manuscript/one.md\n",
    "plot/volumes/v/chapters/a/scenes/two.yaml": "id: scene-two\ntype: scene\ntitle: Scene Two\nvolume: volume-1\nchapter: chapter-one\norder: 2\nmanuscript: manuscript/two.md\n",
    "manuscript/one.md": "First scene.\n",
    "manuscript/two.md": "Second scene.\n",
  };
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async ({ identity, files }) => window.propriumHostTest!.openWorkspace(identity, files), { identity, files });
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) await plugin.getByRole("checkbox", { name: capability, exact: true }).check();
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");

  let outline = await activateNarrativeOutline(page);
  await outline.getByRole("button", { name: "読み込む", exact: true }).click();
  await showNarrativeOutline(page);
  await outline.getByRole("button", { name: "Volume One を編集対象に選択", exact: true }).click();
  await outline.getByRole("tab", { name: "章を並べ替え", exact: true }).click();
  const chapterOrder = outline.getByRole("textbox", { name: "章の順序（1行に1件）", exact: true });
  await expect(chapterOrder).toHaveValue("chapter-one\nchapter-two");
  const chapterMove = outline.getByRole("button", { name: "章の順序 2行目を上へ移動", exact: true });
  if (await page.locator(".mobile-shell").count()) await chapterMove.click();
  else { await chapterMove.focus(); await page.keyboard.press("Enter"); }
  await expect(chapterOrder).toHaveValue("chapter-two\nchapter-one");
  await outline.getByRole("button", { name: "送信", exact: true }).click();
  await expect(outline.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  await expect(outline.getByRole("alert")).toHaveCount(0);
  await showPanel(page, "review");
  const review = page.getByRole("region", { name: "Authoring proposals" });
  await review.getByRole("button", { name: /proprium\.narrative · proposed/u }).last().click();
  await expect(review).toContainText("chapter-two");
  await expect(review).toContainText("order: 1");
  await review.getByRole("checkbox").last().check();
  await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).last().click();
  await expect(review.getByRole("button", { name: /proprium\.narrative · applied/u })).toHaveCount(1, { timeout: 60_000 });

  await showPanel(page, "outline");
  outline = await activateNarrativeOutline(page);
  await outline.getByRole("button", { name: "読み込む", exact: true }).click();
  await showNarrativeOutline(page);
  await outline.getByRole("button", { name: "Chapter One を編集対象に選択", exact: true }).click();
  await outline.getByRole("tab", { name: "シーンを並べ替え", exact: true }).click();
  const sceneOrder = outline.getByRole("textbox", { name: "シーンの順序（1行に1件）", exact: true });
  await expect(sceneOrder).toHaveValue("scene-one\nscene-two");
  const sceneMove = outline.getByRole("button", { name: /2行目を上へ移動/u });
  await sceneMove.click();
  await expect(sceneOrder).toHaveValue("scene-two\nscene-one");
  await outline.getByRole("button", { name: "送信", exact: true }).click();
  await expect(outline.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  await expect(outline.getByRole("alert")).toHaveCount(0);
  await showPanel(page, "review");
  await review.getByRole("button", { name: /proprium\.narrative · proposed/u }).last().click();
  await expect(review).toContainText("scene-two");
  await review.getByRole("checkbox").last().check();
  await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).last().click();
  await expect(review.getByRole("button", { name: /proprium\.narrative · applied/u })).toHaveCount(2, { timeout: 60_000 });

  const saved = await page.evaluate(async identity => {
    const { BrowserLocalGit } = await import(/* @vite-ignore */ new URL("/src/browser/proprium/git/index.ts", location.origin).href);
    const git = new BrowserLocalGit(identity); await git.init();
    const paths = ["plot/volumes/v/chapters/a/chapter.yaml", "plot/volumes/v/chapters/b/chapter.yaml", "plot/volumes/v/chapters/a/scenes/one.yaml", "plot/volumes/v/chapters/a/scenes/two.yaml"];
    const values: Record<string, string> = {};
    for (const path of paths) { const file = await git.read(path); if (!file.data) throw new Error(`Saved source missing: ${path}`); values[path] = new TextDecoder().decode(file.data); }
    git.close();
    return values;
  }, identity);
  expect(saved["plot/volumes/v/chapters/a/chapter.yaml"]).toContain("order: 2");
  expect(saved["plot/volumes/v/chapters/b/chapter.yaml"]).toContain("order: 1");
  expect(saved["plot/volumes/v/chapters/a/scenes/one.yaml"]).toContain("order: 2");
  expect(saved["plot/volumes/v/chapters/a/scenes/two.yaml"]).toContain("order: 1");
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
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await showNarrativeOutline(page);
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
  await expect(dialog.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60000 });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
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
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await showNarrativeOutline(page);
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
  const surface = page.locator(".authoring-workspace-panel");
  await expect(surface.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60000 });
  await expect(surface.getByRole("alert")).toHaveCount(0);
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
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await showNarrativeOutline(page);
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
  const surface = page.locator(".authoring-workspace-panel");
  await expect(surface.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60000 });
  await expect(surface.getByRole("alert")).toHaveCount(0);
  await showPanel(page, "review");
  const review = page.getByRole("region", { name: "Authoring proposals" });
  await expect(review.getByRole("button").first()).toBeVisible({ timeout: 60000 });
  await review.getByRole("button").first().click();
  await expect(review).toContainText("manuscript/custom/scene-1.md");
  await review.getByRole("checkbox").first().check();
  await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();
  await expect(review.getByRole("button", { name: /proprium.narrative · applied/ })).toBeVisible({ timeout: 60000 });
});

test("local authoring edits, reviews, commits and recovers a large work", async ({ page }) => {
  test.setTimeout(360_000);
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  await page.route("https://authoring-build.invalid/plugins/**", async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugins/".length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream", headers: { "access-control-allow-origin": "*" } }); }
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
  const identity = { provider: "local" as const, name: "P0 synthetic work", branch: "main", localWorkspaceId: `p0-${crypto.randomUUID()}` };
  // Provision a committed synthetic baseline; all author changes below use the UI.
  await page.evaluate(async ({ identity, files }) => {
    const moduleUrl = new URL("/src/browser/proprium/git/index.ts", location.origin).href;
    const { BrowserLocalGit } = await import(/* @vite-ignore */ moduleUrl);
    const git = new BrowserLocalGit(identity); await git.init();
    const entries = Object.entries(files);
    let head: string | null = null;
    for (let offset = 0; offset < entries.length; offset += 200) {
      const batch = entries.slice(offset, offset + 200);
      await git.applyChanges(batch.map(([path, text]) => ({ path, content: new TextEncoder().encode(text), expectedRevision: { oid: null } })));
      await git.add(batch.map(([path]) => path), head);
      head = (await git.commit("Synthetic fixture baseline", { name: "Fixture", email: "fixture@example.invalid" }, head)).head;
    }
    git.close();
    await window.propriumHostTest!.openWorkspace(identity);
  }, { identity, files });
  await showPanel(page, "review");
  await expect(page.locator(".authoring-command-menu")).toHaveCount(0);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await page.getByRole("button", { name: "proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: "proprium.narrative" }).filter({ hasText: "v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) {
    const grant = plugin.getByRole("checkbox", { name: capability, exact: true });
    await expect(grant).not.toBeChecked();
    await grant.check();
  }
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await page.locator(".st-workspace-configuration > summary").click();
  await page.locator(".st-workspace-panel-menu > summary").click();
  await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
  await page.locator(".st-workspace-configuration > summary").click();
  const tab = page.getByRole("tab", { name: "Work outline", exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await showNarrativeOutline(page);
  await expect(page.getByText("Volume One", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByText("Volume One", { exact: true }).click();
  await expect(page.getByText("Chapter One", { exact: true })).toBeVisible({ timeout: 35000 });
  await page.getByText("Chapter One", { exact: true }).click();
  for (let n = 0; n < 2; n++) await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(page.getByText("Scene 301", { exact: true })).toBeVisible({ timeout: 35000 });
  await page.getByText("Scene 301", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("目的の原稿", { timeout: 120_000 });
  await expectEditorText(page, files["manuscript/custom/scene-301.md"]!);
  const edited = "新しい原稿 |漢字《かんじ》\n二行目。\n";
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill(edited);
  await page.getByRole("button", { name: "端末に保存", exact: true }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("saved to this browser's local Git worktree");
  await showPanel(page, "review");
  await page.getByRole("button", { name: /巻を作成 proprium.narrative/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "読み込む" }).click();
  await dialog.getByLabel("タイトル").fill("新しい巻");
  await expect(dialog.getByRole("button", { name: "送信" })).toBeEnabled({ timeout: 60000 });
  await dialog.getByRole("button", { name: "送信" }).click();
  await expect(dialog.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60000 });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const review = page.getByRole("region", { name: "Authoring proposals" });
  await expect(review.getByRole("button").first()).toBeVisible({ timeout: 60000 });
  await dialog.getByRole("button", { name: "巻を作成を閉じる" }).click();
  await review.getByRole("button").first().click();
  await expect(review).toContainText("新しい巻");
  await review.getByRole("checkbox").first().check();
  await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();
  await expect(review.getByRole("button", { name: /proprium.narrative · applied/ })).toBeVisible({ timeout: 60000 });
  await expectEditorText(page, edited);
  await showPanel(page, "inspector");
  await page.getByLabel("変更の説明", { exact: true }).fill("P0 local authoring");
  await page.getByLabel("Git author name", { exact: true }).fill("Test author");
  await page.getByLabel("Git author email", { exact: true }).fill("author@example.invalid");
  await reviewChangedFiles(page);
  await page.getByRole("button", { name: "ローカルGitにコミット", exact: true }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("Committed locally as");
  await page.reload();
  await page.getByRole("button", { name: /P0 synthetic work/ }).click();
  // Reopening restores the saved manuscript asynchronously. Wait for its
  // real editor bytes rather than racing that navigation with a Files click.
  await expectEditorText(page, edited);

});
