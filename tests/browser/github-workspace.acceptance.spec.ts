import { showPanel, expectEditorText, chooseFile } from "./restored-ui.helpers.js";
import { expect, test } from "@playwright/test";
import {
  connectAndOpenGitHubBranch,
  liveGitHubBranch,
  liveGitHubOwner,
  liveGitHubRepository,
  liveGitHubRepositoryId,
  liveGitHubToken,
  liveGatewayUrl,
} from "./github-fixture-relay.js";

async function showRepositoryFiles(page: import("@playwright/test").Page): Promise<void> {
  const files = page.getByRole("list", { name: "Repository files" });
  if (await files.isVisible()) return;
  await showPanel(page, "outline");
  await expect(files).toBeVisible();
}

test("Host signs in, opens a real GitHub branch, commits locally and publishes the exact SHA", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!liveGatewayUrl || !liveGitHubToken || !liveGitHubOwner || !liveGitHubRepository || !liveGitHubBranch ||
    ["main", "master"].includes(liveGitHubBranch.toLowerCase()) ||
    !Number.isSafeInteger(liveGitHubRepositoryId) || liveGitHubRepositoryId <= 0,
  "Requires PROPRIUM_E2E_GATEWAY_URL, the in-memory GitHub test token, and an explicit disposable non-main repository branch.");

  await page.addInitScript(() => { window.open = () => null; });
  await page.goto("/");
  const hostOrigin = new URL(page.url()).origin;
  await connectAndOpenGitHubBranch(page, hostOrigin);
  const operationNotice = page.locator(".host-message[role='status']");
  await expect(operationNotice).toContainText(`Opened ${liveGitHubOwner}/${liveGitHubRepository} · ${liveGitHubBranch}`);

  await showPanel(page, "outline");
  await expect(page.getByRole("list", { name: "Repository files" })).toBeVisible();
  await page.getByLabel("New file path").fill(`.proprium-e2e-${crypto.randomUUID()}.txt`);
  await page.getByRole("button", { name: "Create new file" }).click();
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill("Published from the Proprium browser Host.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(operationNotice).toContainText("saved to this browser's local Git worktree");

  await showPanel(page, "inspector");
  await page.getByLabel("Commit message").fill("Verify Proprium browser Host publication");
  await page.getByLabel("Git author name").fill("Proprium Browser Acceptance");
  await page.getByLabel("Git author email").fill("browser-acceptance@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();
  const localCommit = operationNotice.filter({ hasText: "Committed locally as" });
  await expect(localCommit).toContainText("This commit is still only on this device.");
  const commitMessage = await localCommit.innerText();
  const publishedCandidate = /Committed locally as ([a-f0-9]{40})/u.exec(commitMessage)?.[1];
  expect(publishedCandidate).toMatch(/^[a-f0-9]{40}$/u);

  await showRepositoryFiles(page);
  await page.getByRole("button", { name: "Fetch" }).click();
  await expect(operationNotice).toContainText(/Fetched \d+ commit\(s\)/u);
  await showRepositoryFiles(page);
  await page.getByRole("button", { name: "Pull" }).click();
  const pullStatus = operationNotice;
  await expect(pullStatus).toContainText(`Local commits through ${publishedCandidate} are waiting to be published.`);
  await expect(pullStatus).toContainText(/GitHub is at (?:[a-f0-9]{40}|no published commit); local history and editor contents were preserved\./u);

  await showRepositoryFiles(page);
  await page.getByRole("button", { name: "Publish" }).click();
  const published = operationNotice.filter({ hasText: "Published commit" });
  await expect(published).toContainText("confirmed the remote branch SHA");
  const publishedMessage = await published.innerText();
  const publishedSha = /Published commit ([a-f0-9]{40}) to GitHub/u.exec(publishedMessage)?.[1];
  expect(publishedSha).toBe(publishedCandidate);
  await expect(page.getByText(`Published · ${publishedSha?.slice(0, 8)}`, { exact: true })).toBeVisible();

  const branchRef = liveGitHubBranch.split("/").map(encodeURIComponent).join("/");
  const remoteResponse = await fetch(`https://api.github.com/repos/${liveGitHubOwner}/${liveGitHubRepository}/git/ref/heads/${branchRef}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${liveGitHubToken}`, "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  expect(remoteResponse.ok).toBe(true);
  const remoteRef = await remoteResponse.json() as { object?: { sha?: string } };
  expect(remoteRef.object?.sha).toBe(publishedCandidate);
});
