import { expect, test } from "@playwright/test";
import { chooseFile, reviewChangedFiles, showPanel } from "./restored-ui.helpers.js";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/protocol.js";

declare global {
  interface Window {
    propriumHostTest?: {
      openWorkspace(identity: WorkspaceIdentity, files?: Record<string, string>): Promise<void>;
    };
  }
}

test("Mobile WebKit library keeps GitHub access visible without a neutral status overlay", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-webkit", "This acceptance check targets the Mobile WebKit shell.");

  await page.goto("/?view=library");

  await expect(page.locator(".mobile-shell-current-title")).toHaveText("作品ライブラリ");
  const libraryHeading = page.locator("#mobile-library-title");
  await expect(libraryHeading).toHaveText("作品ライブラリ");
  await expect(libraryHeading).toHaveClass(/\bsr-only\b/u);
  await expect(page.locator(".mobile-shell-status")).toHaveCount(0);

  const connect = page.getByRole("button", { name: "GitHubに接続", exact: true });
  await expect(connect).toBeVisible();
  await connect.scrollIntoViewIfNeeded();
  await expect(connect).toBeInViewport();

  const gatewaySettings = page.locator("details.gateway-settings");
  if (await gatewaySettings.getAttribute("open") === null) await gatewaySettings.locator("summary").click();
  await page.getByLabel("Proprium Gateway URL", { exact: true }).fill("");
  await connect.click();

  const error = page.locator(".github-authorization-error");
  await expect(error).toContainText("Enter the Proprium Gateway URL");
  await expect(error).toBeVisible();
  const status = page.locator(".mobile-shell-status");
  await expect(status).toBeVisible();
  expect(await status.evaluate(element => getComputedStyle(element).position)).toBe("relative");
  const buttonBounds = await connect.boundingBox();
  const statusBounds = await status.boundingBox();
  expect(buttonBounds).not.toBeNull();
  expect(statusBounds).not.toBeNull();
  expect(buttonBounds!.y + buttonBounds!.height).toBeLessThanOrEqual(statusBounds!.y + 1);
});

test("Mobile WebKit keeps workspace panels, routes Settings separately, and reviews local Git diffs by touch navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-webkit", "This acceptance check targets the Mobile WebKit shell.");
  await page.setViewportSize({ width: 390, height: 430 });

  const workspace: WorkspaceIdentity = {
    origin: "https://github.com",
    repositoryId: 923456792,
    owner: "proprium-test",
    repository: "mobile-shell-navigation",
    branch: "main",
    localWorkspaceId: `mobile-shell-${crypto.randomUUID()}`,
  };
  await page.goto("/mobile?view=writing");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async workspace => {
    await window.propriumHostTest!.openWorkspace(workspace, { "chapter.md": "最初の本文です。\n" });
  }, workspace);

  const screenNavigation = page.getByRole("navigation", { name: "モバイルの主要画面" });
  await expect(screenNavigation).toBeVisible();
  await expect(screenNavigation.getByRole("button")).toHaveCount(4);
  await expect(page.locator('summary[aria-label="別の画面へ移動"]')).toHaveCount(0);
  await expect(screenNavigation.getByRole("button", { name: "変更", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "設定を開く" }).click();
  await expect(page.locator(".mobile-shell-workspace-view[data-active-view='settings'] .mobile-shell-settings-card")).toBeVisible();
  await expect(page.locator(".mobile-shell-workspace-panel")).toHaveAttribute("hidden", "");
  await expect(page.locator(".commit-panel")).not.toBeVisible();
  await screenNavigation.getByRole("button", { name: "書く", exact: true }).click();
  await expect(page.locator(".mobile-shell-workspace-panel")).not.toHaveAttribute("hidden", "");
  await screenNavigation.getByRole("button", { name: "作品", exact: true }).click();
  await page.getByRole("button", { name: "chapter.md の操作メニュー" }).click();
  const fileActions = page.getByRole("dialog", { name: "ファイルの操作" });
  await expect(fileActions).toBeVisible();
  await expect(fileActions.getByLabel("名前・保存先を変更")).toHaveValue("chapter.md");
  await fileActions.getByRole("button", { name: "操作メニューを閉じる" }).click();
  await expect(fileActions).not.toBeVisible();

  await chooseFile(page, "chapter.md");
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toBeVisible();
  const manuscriptBounds = await page.locator(".cm-editor").boundingBox();
  expect(manuscriptBounds).not.toBeNull();
  const visibleManuscriptHeight = Math.max(0, Math.min(manuscriptBounds!.y + manuscriptBounds!.height, 430) - Math.max(manuscriptBounds!.y, 0));
  expect(visibleManuscriptHeight).toBeGreaterThan(120);

  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill("変更後の本文です。\n");
  await expect(screenNavigation).not.toBeVisible();
  await expect(page.getByRole("button", { name: "画面の切替を表示" })).toBeVisible();
  const saveDraft = page.getByRole("button", { name: "端末に保存", exact: true });
  await expect(saveDraft).toBeEnabled();
  await saveDraft.click();
  await reviewChangedFiles(page);
  await expect(page.locator(".git-review-files .git-review-checked")).toHaveCount(1);

  await showPanel(page, "history");
  await expect(page.locator("#git-history-heading")).toBeVisible();
});
