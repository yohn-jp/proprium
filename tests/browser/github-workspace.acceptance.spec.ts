import { expect, test } from "@playwright/test";
import {
  connectAndOpenGitHubBranch,
  liveGitHubBranch,
  liveGitHubOwner,
  liveGitHubRepository,
  liveGitHubRepositoryId,
  liveGitHubToken,
} from "./github-fixture-relay.js";

test("Host signs in, opens a real GitHub branch, commits locally and publishes the exact SHA", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!liveGitHubToken || !liveGitHubOwner || !liveGitHubRepository || !liveGitHubBranch ||
    ["main", "master"].includes(liveGitHubBranch.toLowerCase()) ||
    !Number.isSafeInteger(liveGitHubRepositoryId) || liveGitHubRepositoryId <= 0,
  "Requires the in-memory GitHub test token and an explicit disposable non-main repository branch.");

  await page.addInitScript(() => { window.open = () => null; });
  await page.goto("/");
  const hostOrigin = new URL(page.url()).origin;
  await connectAndOpenGitHubBranch(page, hostOrigin);
  await expect(page.getByRole("status").filter({ hasText: `Opened ${liveGitHubOwner}/${liveGitHubRepository} · ${liveGitHubBranch}` })).toBeVisible();

  const mobileFiles = page.getByRole("button", { name: /^Files(?:\s|$)/u });
  if (await mobileFiles.isVisible()) await mobileFiles.click();
  await expect(page.getByRole("list", { name: "Repository files" })).toBeVisible();
  await page.getByLabel("New file path").fill(`.proprium-e2e-${crypto.randomUUID()}.txt`);
  await page.getByRole("button", { name: "Create new file" }).click();
  await page.getByRole("textbox", { name: "File contents" }).fill("Published from the Proprium browser Host.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("saved to this browser's local Git worktree");

  await page.getByLabel("Commit message").fill("Verify Proprium browser Host publication");
  await page.getByLabel("Git author name").fill("Proprium Browser Acceptance");
  await page.getByLabel("Git author email").fill("browser-acceptance@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();
  const localCommit = page.getByRole("status").filter({ hasText: "Committed locally as" });
  await expect(localCommit).toContainText("This commit is still only on this device.");
  const commitMessage = await localCommit.innerText();
  const publishedCandidate = /Committed locally as ([a-f0-9]{40})/u.exec(commitMessage)?.[1];
  expect(publishedCandidate).toMatch(/^[a-f0-9]{40}$/u);

  await page.getByRole("button", { name: "Fetch" }).click();
  await expect(page.getByRole("status")).toContainText(/Fetched \d+ commit\(s\)/u);
  await page.getByRole("button", { name: "Pull" }).click();
  const pullStatus = page.getByRole("status");
  await expect(pullStatus).toContainText(`Local commits through ${publishedCandidate} are waiting to be published.`);
  await expect(pullStatus).toContainText(/GitHub is at (?:[a-f0-9]{40}|no published commit); local history and editor contents were preserved\./u);

  await page.getByRole("button", { name: "Publish" }).click();
  const published = page.getByRole("status").filter({ hasText: "Published commit" });
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
