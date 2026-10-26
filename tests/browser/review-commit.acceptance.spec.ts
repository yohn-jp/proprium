import { expect, test } from "@playwright/test";
import { chooseFile, reviewChangedFiles, showPanel } from "./restored-ui.helpers.js";

for (const mutation of ["edit", "add"] as const) {
  test(`Host requires a fresh review after another tab's ${mutation}`, async ({ page, context }) => {
    await page.goto("/");
    const identity = { provider: "local" as const, name: "Review race", branch: "main", localWorkspaceId: `review-${crypto.randomUUID()}` };
    await page.waitForFunction(() => !!window.propriumHostTest);
    await page.evaluate(async identity => window.propriumHostTest!.openWorkspace(identity, { "notes.md": "initial\n" }), identity);
    await chooseFile(page, "notes.md");
    await page.getByRole("textbox", { name: "原稿 Markdown" }).fill("reviewed content\n");
    await page.getByRole("button", { name: "端末に保存", exact: true }).click();
    await showPanel(page, "inspector");
    await page.getByLabel("変更の説明", { exact: true }).fill("reviewed commit");
    await page.getByLabel("Git author name", { exact: true }).fill("Review Test");
    await page.getByLabel("Git author email", { exact: true }).fill("review@example.test");
    await reviewChangedFiles(page);
    const commit = page.getByRole("button", { name: "ローカルGitにコミット", exact: true });
    await expect(commit).toBeEnabled();

    const other = await context.newPage();
    await other.goto("/");
    await other.evaluate(async ({ identity, mutation }) => {
      const moduleUrl = new URL("/src/browser/proprium/git/index.ts", location.origin).href;
      const { BrowserLocalGit } = await import(/* @vite-ignore */ moduleUrl);
      const git = new BrowserLocalGit(identity);
      await git.init();
      const path = mutation === "add" ? "unreviewed.md" : "notes.md";
      await git.write(path, new TextEncoder().encode("unreviewed from another tab\n"), (await git.read(path)).revision);
      git.close();
    }, { identity, mutation });
    await commit.click();
    await expect(page.locator(".host-message[role='alert']")).toContainText("レビュー後に作品が変更されました");
    await expect(commit).toBeDisabled();
    await expect(page.locator(".git-review-files")).toContainText(mutation === "add" ? "unreviewed.md" : "notes.md");
    await reviewChangedFiles(page);
    await commit.click();
    await expect(page.locator(".host-message[role='status']")).toContainText("Committed locally as");
    await other.close();
  });
}
