import { expect, test, type Page } from "@playwright/test";
import { handleGitHubAuthRequest } from "../../workers/github-auth/github-auth-worker.js";

const liveGitHubToken = process.env.PROPRIUM_E2E_GITHUB_TOKEN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN ?? "";
const liveGitHubOwner = process.env.PROPRIUM_E2E_GITHUB_OWNER ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_OWNER ?? "";
const liveGitHubRepository = process.env.PROPRIUM_E2E_GITHUB_REPOSITORY ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY ?? "";
const liveGitHubRepositoryId = Number(process.env.PROPRIUM_E2E_GITHUB_REPOSITORY_ID ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY_ID ?? "0");
const liveGitHubBranch = process.env.PROPRIUM_E2E_GITHUB_BRANCH ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_BRANCH ?? "";
const liveGitHubLogin = process.env.PROPRIUM_E2E_GITHUB_LOGIN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_LOGIN ?? "";
const relayOrigin = "https://oauth.example.test";

async function routeFixtureRelay(page: Page, hostOrigin: string): Promise<void> {
  await page.route(`${relayOrigin}/**`, async route => {
    const source = route.request();
    const body = source.postDataBuffer();
    const request = new Request(source.url(), {
      method: source.method(),
      headers: source.headers(),
      body: body?.byteLength ? new Uint8Array(body) : undefined,
    });
    const response = await handleGitHubAuthRequest(request, {
      GITHUB_CLIENT_ID: "Iv23liExampleClientId",
      HOST_ORIGIN: hostOrigin,
    }, async (input, init) => {
      if (String(input) === "https://github.com/login/device/code") return Response.json({
        device_code: "a".repeat(40), user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device",
        expires_in: 900, interval: 1,
      });
      if (String(input) === "https://github.com/login/oauth/access_token") return Response.json({
        access_token: liveGitHubToken,
        token_type: "bearer",
      });
      return fetch(String(input), init);
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

test("Host signs in, opens a real GitHub branch, commits locally and publishes the exact SHA", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!liveGitHubToken || !liveGitHubOwner || !liveGitHubRepository || !liveGitHubBranch ||
    !Number.isSafeInteger(liveGitHubRepositoryId) || liveGitHubRepositoryId <= 0,
  "Requires the in-memory GitHub test token and its disposable repository branch.");

  await page.addInitScript(() => { window.open = () => null; });
  await page.goto("/");
  const hostOrigin = new URL(page.url()).origin;
  await routeFixtureRelay(page, hostOrigin);

  await page.getByLabel("GitHub auth relay URL").fill(relayOrigin);
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(page.getByRole("status")).toContainText("Connected to GitHub as");
  const accountText = await page.getByRole("status").innerText();
  if (liveGitHubLogin) expect(accountText.toLowerCase()).toContain(liveGitHubLogin.toLowerCase());

  await page.getByLabel("Repository").selectOption(String(liveGitHubRepositoryId));
  await page.getByLabel("Branch").fill(liveGitHubBranch);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByText(new RegExp(`${liveGitHubRepository}.*${liveGitHubBranch}`))).toBeVisible();

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
  await expect(page.getByRole("status")).toContainText(/already matches GitHub|Updated to GitHub commit/u);

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
