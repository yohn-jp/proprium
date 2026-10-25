import { expect, test } from "@playwright/test";
import {
  connectAndOpenGitHubBranch,
  liveGitHubBranch,
  liveGitHubRepository,
  liveGitHubToken,
  liveGitHubOwner,
  liveGitHubRepositoryId,
} from "./github-fixture-relay.js";

test("built static Host controls offline reload and local Git editing with a recent GitHub workspace", async ({ page, context }) => {
  test.skip(!liveGitHubToken || !liveGitHubOwner || !liveGitHubRepository || !liveGitHubBranch ||
    ["main", "master"].includes(liveGitHubBranch.toLowerCase()) || !Number.isSafeInteger(liveGitHubRepositoryId) || liveGitHubRepositoryId <= 0,
  "Requires the in-memory test token and an explicit disposable non-main branch.");
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto("/");
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active !== null;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await connectAndOpenGitHubBranch(page, new URL(page.url()).origin);
  await expect(page.getByRole("list", { name: "Repository files" })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Open a GitHub workspace" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const recentWorkspace = page.getByRole("button")
    .filter({ hasText: liveGitHubRepository })
    .filter({ hasText: liveGitHubBranch });
  await expect(recentWorkspace).toBeVisible();
  await recentWorkspace.click();

  const mobileFiles = page.getByRole("button", { name: /^Files(?:\s|$)/u });
  if (await mobileFiles.isVisible()) await mobileFiles.click();
  const files = page.getByRole("list", { name: "Repository files" });
  await expect(files).toBeVisible();
  const firstFile = files.getByRole("button").first();
  await firstFile.click();
  const editor = page.getByRole("textbox", { name: "File contents" });
  await expect(editor).toBeVisible();
  await editor.fill("Edited and committed from the cached static Host while offline.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("saved to this browser's local Git worktree");
  await page.getByLabel("Commit message").fill("Verify offline editing from the static Host");
  await page.getByLabel("Git author name").fill("Proprium Static Acceptance");
  await page.getByLabel("Git author email").fill("static-acceptance@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();
  const localCommit = page.getByRole("status").filter({ hasText: "Committed locally as" });
  await expect(localCommit).toContainText("This commit is still only on this device.");
  await expect(page.getByText(/^Committed locally · [a-f0-9]{8}$/u)).toBeVisible();
});
