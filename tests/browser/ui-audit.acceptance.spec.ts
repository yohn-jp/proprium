import { expect, test } from "@playwright/test";
import { reviewChangedFiles, showPanel } from "./restored-ui.helpers.js";

test("a local manuscript can be saved, renamed, reviewed, committed and inspected in history", async ({ page }) => {
  await page.goto("/?e2e=1");
  await page.getByLabel("作品名", { exact: true }).fill("UI操作の統合確認");
  await page.getByRole("button", { name: "ローカル作品を作成", exact: true }).click();

  await showPanel(page, "outline");
  await page.getByLabel("New file path", { exact: true }).fill("序章");
  await page.getByRole("button", { name: "Create new file", exact: true }).click();

  const manuscript = "冬の港に、第一章の原稿が届いた。\n"
    + "これは端末に保存してから履歴へ記録する文章です。\n";
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill(manuscript);
  await page.getByRole("button", { name: "端末に保存", exact: true }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("saved to this browser's local Git worktree");

  await showPanel(page, "outline");
  const files = page.getByRole("list", { name: "Repository files" });
  await files.getByRole("button", { name: "序章.md", exact: true }).click();
  await page.locator(".file-rename-panel > summary").click();
  await page.getByLabel("新しい名前・保存先", { exact: true }).fill("chapters/序章.md");
  await page.getByRole("button", { name: "変更する", exact: true }).click();
  await expect(files.getByRole("button", { name: "chapters/序章.md", exact: true })).toBeVisible();
  await expect(files.getByRole("button", { name: "序章.md", exact: true })).toHaveCount(0);

  await showPanel(page, "inspector");
  await page.getByLabel("変更の説明", { exact: true }).fill("Save and rename a local manuscript");
  await page.getByLabel("Git author name", { exact: true }).fill("Proprium UI Audit");
  await page.getByLabel("Git author email", { exact: true }).fill("ui-audit@example.invalid");
  await reviewChangedFiles(page);
  await page.getByRole("button", { name: "ローカルGitにコミット", exact: true }).click();

  await showPanel(page, "history");
  const commits = page.getByRole("navigation", { name: "Local commits" });
  const commit = commits.getByRole("button").filter({ hasText: "Save and rename a local manuscript" });
  await expect(commit).toBeVisible();
  await commit.click();
  const change = page.getByRole("article", { name: /chapters\/序章\.md 追加/u });
  await expect(change).toBeVisible();
  await expect(change.locator(".text-diff-line[data-kind='added']").first()).toContainText("第一章の原稿");
});
