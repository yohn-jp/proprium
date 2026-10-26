import { expect, test } from "@playwright/test";
import { chooseFile } from "./restored-ui.helpers.js";

test("editor controls leave usable manuscript space on a laptop and mobile viewport", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile-webkit";
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
  await page.goto("/");
  await page.waitForFunction(() => !!window.propriumHostTest);
  const text = Array.from({ length: 60 }, (_, index) => `原稿の本文 ${index + 1}。`).join("\n");
  await page.evaluate(async text => window.propriumHostTest!.openWorkspace({
    origin: "https://github.com", repositoryId: 923456791, owner: "proprium-test", repository: "editor-viewport",
    branch: "main", localWorkspaceId: `editor-viewport-${crypto.randomUUID()}`,
  }, { "chapter.md": text }), text);
  await chooseFile(page, "chapter.md");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Delete file", exact: true })).toHaveCount(1);
  const geometry = await page.locator(".cm-editor").evaluate(element => {
    const rect = element.getBoundingClientRect();
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) continue;
      const bounds = parent.getBoundingClientRect();
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
    return { visibleHeight: Math.max(0, bottom - top), top: rect.top, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry.visibleHeight, JSON.stringify(geometry)).toBeGreaterThanOrEqual(mobile ? 150 : 180);
  await testInfo.attach("editor-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
  expect(geometry.horizontalOverflow).toBe(false);
  const typography = page.locator(".typography-settings > summary");
  await typography.click();
  await expect(page.getByRole("button", { name: "文字を大きく", exact: true })).toBeVisible();
  if (!mobile) {
    const panelBottom = await page.locator(".typography-toolbar").evaluate(element => element.getBoundingClientRect().bottom);
    const manuscriptTop = await page.locator(".cm-editor").evaluate(element => element.getBoundingClientRect().top);
    expect(manuscriptTop).toBeGreaterThanOrEqual(panelBottom);
  }
  await typography.click();
  await expect(page.locator(".cm-content .cm-line").first()).toHaveText("原稿の本文 1。");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  if (!mobile) {
    const arrangement = page.locator(".st-workspace-configuration");
    await arrangement.locator(":scope > summary").click();
    const move = page.locator(".st-workspace-move-menu");
    await move.locator(":scope > summary").click();
    await expect(page.getByRole("button", { name: "パネルを移動", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await move.locator(":scope > summary").click();
  }
  await page.screenshot({ path: testInfo.outputPath("editor-viewport.png"), fullPage: true });
});
