import { expect, test } from "@playwright/test";
import { installStaticGitHubFixture, staticFixtureIdentity } from "./static-github-fixture.js";
import { configureGateway, showPanel } from "./restored-ui.helpers.js";

test("an executable addition remains reviewable but cannot be restored as a plain file", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const fixture = await installStaticGitHubFixture(page, origin, "100755");
  await configureGateway(page, origin);
  await page.getByRole("button", { name: "GitHubに接続", exact: true }).click();
  await page.getByLabel("Repository", { exact: true }).selectOption(String(staticFixtureIdentity.repositoryId));
  await page.getByLabel("ブランチ", { exact: true }).selectOption(staticFixtureIdentity.branch);
  await page.getByRole("button", { name: "作品を開く", exact: true }).click();
  await showPanel(page, "history");
  const history = page.locator(".git-history-review");
  await expect(history.locator(".git-history-restore")).toBeDisabled();
  await expect(history).toContainText("実行可能ファイルが含まれています");
  const detail = history.getByRole("article", { name: "README.md 追加", exact: true });
  await expect(detail.locator(".text-diff")).toContainText(fixture.content.trim());
});
