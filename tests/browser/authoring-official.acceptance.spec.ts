import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { showPanel } from "./restored-ui.helpers.js";

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
  const desktop = page.getByRole("button", { name: "パネル：Work outline", exact: true });
  if (await desktop.isVisible()) await desktop.click();
  else await page.getByRole("tab", { name: "Work outline", exact: true }).click();
  await expect(page.getByText("Volume One", { exact: true })).toBeVisible();
  await page.getByText("Volume One", { exact: true }).click();
  await expect(page.getByText("Chapter One", { exact: true })).toBeVisible();
  await page.getByText("Chapter One", { exact: true }).click();
  for (let n = 0; n < 2; n++) await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(page.getByText("Scene 301", { exact: true })).toBeVisible();
  await page.getByText("Scene 301", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("目的の原稿");
});
