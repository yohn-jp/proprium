import { expect, test, type Page } from "@playwright/test";
import { expectEditorText, showPanel } from "./restored-ui.helpers.js";

const files: Record<string, string> = {
  "meta/project.yaml": "title: ネイティブ作品\\n",
  "plot/volumes/v/volume.yaml": "id: v1\\ntype: volume\\ntitle: 第一巻\\norder: 1\\n",
  "plot/volumes/v/chapters/c/chapter.yaml": "id: c1\\ntype: chapter\\ntitle: 第一章\\nvolume: v1\\norder: 1\\n",
  "plot/volumes/v/chapters/c/scenes/a.yaml": "id: s1\\ntype: scene\\ntitle: 雨の夜\\nvolume: v1\\nchapter: c1\\norder: 1\\nmanuscript: manuscript/a.md\\n",
  "manuscript/a.md": "雨の夜から始まる。\\n",
};

async function revealOutline(page: Page) {
  await showPanel(page, "review");
  const tab = page.getByRole("tab", { name: "Work outline", exact: true }).first();
  if (!(await tab.isVisible())) {
    const config = page.locator(".st-workspace-configuration");
    if (await config.getAttribute("open") === null) await config.locator(":scope > summary").click();
    const menu = page.locator(".st-workspace-panel-menu");
    if (await menu.getAttribute("open") === null) await menu.locator(":scope > summary").click();
    await page.getByRole("button", { name: "Work outlineを表示する", exact: true }).click();
    if (await config.getAttribute("open") !== null) await config.locator(":scope > summary").click();
  }
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  return page.getByRole("tabpanel", { name: "Work outline", exact: true }).first();
}

test("built-in Narrative opens a real manuscript without installing or invoking WASM", async ({ page }) => {
  const wasmRequests: string[] = [];
  page.on("request", request => { if (/\\.wasm(?:$|\\?)/u.test(request.url())) wasmRequests.push(request.url()); });
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async entries => window.propriumHostTest!.openWorkspace({
    provider: "local", name: "narrative-ts", branch: "main",
    localWorkspaceId: `narrative-ts-${crypto.randomUUID()}`,
  }, entries), files);
  const outline = await revealOutline(page);
  await outline.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(outline.getByRole("status").filter({ hasText: "このリポジトリの作品構成を認識しました。" }))
    .toBeVisible({ timeout: 60_000 });
  await expect(outline.locator(".authoring-surface-body")).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  await outline.getByRole("tab", { name: "構成", exact: true }).click();
  await outline.getByText("第一巻", { exact: true }).click();
  await outline.getByText("第一章", { exact: true }).click();
  await outline.getByText("雨の夜", { exact: true }).click();
  await showPanel(page, "editor");
  await expectEditorText(page, files["manuscript/a.md"]!);
  expect(wasmRequests).toEqual([]);
});
