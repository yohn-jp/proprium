import { expect, test } from "@playwright/test";
import { installStaticGitHubFixture, staticFixtureIdentity } from "./static-github-fixture.js";
import { chooseFile, configureGateway } from "./restored-ui.helpers.js";

test("Desktop home links protect dirty text and preserve GitHub authentication without a document reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop exposes the two home links.");
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await installStaticGitHubFixture(page, origin);
  await configureGateway(page, origin);
  await page.getByRole("button", { name: "GitHubに接続", exact: true }).click();
  await expect(page.getByLabel("Repository", { exact: true })).toBeVisible();
  await page.getByLabel("Repository", { exact: true }).selectOption(String(staticFixtureIdentity.repositoryId));
  const branchPicker = page.getByLabel("ブランチ", { exact: true });
  await expect(branchPicker.locator(`option[value="${staticFixtureIdentity.branch}"]`)).toHaveCount(1);
  await branchPicker.selectOption(staticFixtureIdentity.branch);
  await page.getByRole("button", { name: "作品を開く", exact: true }).click();
  await chooseFile(page, "README.md");
  const text = "ホーム操作で失わない未保存の原稿\n";
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill(text);
  let documentRequests = 0;
  page.on("request", request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests += 1; });

  page.once("dialog", dialog => dialog.dismiss());
  await page.locator(".st-studio-wordmark").click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toHaveText(text);
  await expect(page.getByLabel("GitHub account", { exact: true })).toBeVisible();

  const save = page.getByRole("button", { name: "端末に保存", exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await page.getByRole("link", { name: "Proprium ホーム", exact: true }).click();
  await expect(page.getByLabel("Repository", { exact: true })).toBeVisible();
  await expect(page.getByText("GitHubに接続中", { exact: false })).toBeVisible();
  expect(documentRequests).toBe(0);
  await page.locator(".recent-card button").filter({ hasText: `${staticFixtureIdentity.owner}/${staticFixtureIdentity.repository}` }).click();
  await chooseFile(page, "README.md");
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toHaveText(text);
});
