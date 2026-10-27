import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chooseFile, expectEditorText, reviewChangedFiles, showPanel } from "./restored-ui.helpers.js";

const registry = resolve(process.env.PROPRIUM_KNOWLEDGE_REGISTRY ?? "/tmp/proprium-2e210ba-registry");

async function install(page: Page, id: string, grants: string[]) {
  const manager = page.locator("details.plugin-manager-panel");
  await page.getByRole("button", { name: new RegExp(`${id.replaceAll(".", "\\.")} .* の署名済みプレビューを確認`) }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました", { timeout: 60_000 });
  const plugin = manager.getByRole("listitem").filter({ hasText: id }).filter({ hasText: "installed, disabled" });
  for (const grant of grants) await plugin.getByRole("checkbox", { name: grant, exact: true }).check();
  await plugin.getByRole("button", { name: "Enable" }).click();
  await expect(manager.getByRole("status")).toContainText(`${id}@`, { timeout: 60_000 });
}

async function showAuthoringPanel(page: Page, title: string) {
  const config = page.locator(".st-workspace-configuration > summary");
  await config.click();
  const menu = page.locator(".st-workspace-panel-menu");
  if (await menu.getAttribute("open") === null) await menu.locator(":scope > summary").click();
  await page.getByRole("button", { name: `${title}を表示する`, exact: true }).click();
  await config.click();
  const tab = page.getByRole("tab", { name: title, exact: true });
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
}

test("signed Knowledge and Research surfaces read and navigate real workspace data", async ({ page }, info) => {
  const origin = new URL(info.project.use.baseURL!).origin;
  const serve = async (route: import("@playwright/test").Route) => {
    const pathname = new URL(route.request().url()).pathname;
    const relative = decodeURIComponent(pathname.split(pathname.startsWith("/plugins/") ? "/plugins/" : "/plugin-fixture/")[1] ?? "");
    const path = resolve(registry, relative);
    if (!path.startsWith(registry + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream", headers: { "Access-Control-Allow-Origin": origin } }); }
    catch { await route.fulfill({ status: 404 }); }
  };
  await page.route("**/plugin-fixture/**", serve);
  await page.route("https://authoring-build.invalid/plugins/**", serve);
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  const workspace = { origin: "https://github.com", repositoryId: 923456790, owner: "proprium-test", repository: "knowledge-e2e", branch: "main", localWorkspaceId: `knowledge-${crypto.randomUUID()}` };
  await page.evaluate(async workspace => window.propriumHostTest!.openWorkspace(workspace, {
    "plot/volumes/v/volume.yaml": "id: volume-1\ntype: volume\ntitle: 海の巻\norder: 1\n",
    "plot/volumes/v/chapters/c/chapter.yaml": "id: chapter-1\ntype: chapter\ntitle: 章\nvolume: volume-1\norder: 1\n",
    "plot/volumes/v/chapters/c/scenes/scene.yaml": "id: scene-1\ntype: scene\ntitle: 灯の場面\nvolume: volume-1\nchapter: chapter-1\norder: 1\nmanuscript: manuscript/scene.md\nappears: [char-a]\n",
    "manuscript/scene.md": "青い灯台で灯は待った。\n",
    "bible/characters/char-a.yaml": "id: char-a\ntype: character\nname: 灯\naliases: [あかり]\ntags: [lead]\nrelations:\n  - target: loc-a\n    kind: related\nnotes:\n  lead: []\n  sections: []\n",
    "bible/locations/loc-a.yaml": "id: loc-a\ntype: location\nname: 灯台\n",
  }), workspace);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "信頼済みカタログを表示" }).click();
  await install(page, "proprium.narrative", ["workspace.file.read"]);
  await install(page, "proprium.knowledge", ["workspace.file.read"]);
  await install(page, "proprium.research", ["workspace.file.read", "workspace.derived.cache"]);

  await showAuthoringPanel(page, "Bible");
  const bible = page.locator(".authoring-surface").filter({ hasText: "character records" });
  await bible.getByRole("button", { name: "character recordsを読み込む", exact: true }).click();
  await expect(bible.getByRole("button", { name: /char-a/ }).first()).toBeVisible({ timeout: 60_000 });
  await bible.getByRole("button", { name: /char-a/ }).first().click();
  await expect(bible.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  await expect(bible.getByRole("alert")).toHaveCount(0);
  await bible.getByRole("button", { name: "character recordsを読み込む", exact: true }).click();
  await expect(bible.getByRole("button", { name: /char-aの原文を開く/ })).toBeVisible({ timeout: 60_000 });
  await bible.getByRole("button", { name: /char-aの原文を開く/ }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("aliases: [あかり]", { timeout: 60_000 });

  await showAuthoringPanel(page, "検索");
  const search = page.locator(".authoring-surface").filter({ hasText: "検索条件" });
  await search.getByLabel("検索語").fill("灯台");
  await search.getByLabel("検索方法").selectOption("lexical");
  await search.getByRole("button", { name: "送信" }).click();
  await expect(search.locator("[aria-busy=false]")).toBeVisible({ timeout: 60_000 });
  await expect(search.getByRole("alert")).toHaveCount(0);
  await search.getByRole("tab", { name: "結果" }).click();
  await expect(search.getByText("manuscript/scene.md", { exact: true })).toBeVisible();
  await search.getByRole("button", { name: /manuscript\/scene\.md/ }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("青い灯台で灯は待った。", { timeout: 60_000 });

 });

test("saved manuscript and local commit survive a browser reload", async ({ page }) => {
  const workspace = { origin: "https://github.com", repositoryId: 923456791, owner: "proprium-test", repository: "recovery-e2e", branch: "main", localWorkspaceId: `recovery-${crypto.randomUUID()}` };
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async identity => window.propriumHostTest!.openWorkspace(identity, { "manuscript/scene.md": "青い灯台で灯は待った。\n" }), workspace);
  await chooseFile(page, "manuscript/scene.md");
  const edited = "青い灯台で灯は待った。\n続きはここから。\n";
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill(edited);
  await page.getByRole("button", { name: "端末に保存", exact: true }).click();
  await expect(page.getByText("端末の下書き", { exact: true })).toBeVisible();
  await showPanel(page, "inspector");
  await page.getByLabel("変更の説明").fill("灯台の原稿を保存");
  await page.getByLabel("Git author name").fill("Proprium Browser Test");
  await page.getByLabel("Git author email").fill("browser-test@example.invalid");
  await reviewChangedFiles(page);
  await page.getByRole("button", { name: "ローカルGitにコミット" }).click();
  await expect(page.getByText(/^端末のGitに記録済み · [a-f0-9]{8}$/u)).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async identity => window.propriumHostTest!.openWorkspace(identity), workspace);
  await chooseFile(page, "manuscript/scene.md");
  await expectEditorText(page, edited);
  await showPanel(page, "history");
  await expect(page.getByRole("listitem").filter({ hasText: "灯台の原稿を保存" })).toBeVisible();
});
