import type { Page, Route } from "@playwright/test";
import { handleGitHubAuthRequest } from "../../workers/github-auth/github-auth-worker.js";

export const liveGitHubToken = process.env.PROPRIUM_E2E_GITHUB_TOKEN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN ?? "";
export const liveGitHubOwner = process.env.PROPRIUM_E2E_GITHUB_OWNER ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_OWNER ?? "";
export const liveGitHubRepository = process.env.PROPRIUM_E2E_GITHUB_REPOSITORY ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY ?? "";
export const liveGitHubRepositoryId = Number(process.env.PROPRIUM_E2E_GITHUB_REPOSITORY_ID ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY_ID ?? "0");
export const liveGitHubBranch = process.env.PROPRIUM_E2E_GITHUB_BRANCH ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_BRANCH ?? "";
export const liveGitHubLogin = process.env.PROPRIUM_E2E_GITHUB_LOGIN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_LOGIN ?? "";
export const relayOrigin = "https://oauth.example.test";

/** Supplies a test OAuth relay while preserving real GitHub profile, repo, Git, and ref traffic. */
export async function routeFixtureRelay(page: Page, hostOrigin: string, relayUrl = relayOrigin): Promise<void> {
  const selectedRelayOrigin = new URL(relayUrl).origin;
  const handleRelayRoute = async (route: Route): Promise<void> => {
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
  };
  await page.route(`${selectedRelayOrigin}/oauth/**`, handleRelayRoute);
  await page.route(`${selectedRelayOrigin}/git/**`, handleRelayRoute);
}

export async function connectAndOpenGitHubBranch(page: Page, hostOrigin: string, relayUrl = relayOrigin): Promise<void> {
  if (!liveGitHubBranch || ["main", "master"].includes(liveGitHubBranch.toLowerCase())) {
    throw new Error("GitHub browser acceptance requires an explicit disposable non-main branch.");
  }
  await routeFixtureRelay(page, hostOrigin, relayUrl);
  await page.getByLabel("GitHub auth relay URL").fill(relayUrl);
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  const operationNotice = page.locator(".host-message[role='status']");
  await operationNotice.getByText(/Connected to GitHub as/u).waitFor();
  const accountText = await operationNotice.innerText();
  if (liveGitHubLogin) {
    const normalized = accountText.toLowerCase();
    if (!normalized.includes(liveGitHubLogin.toLowerCase())) throw new Error("Host connected account did not match the configured GitHub test login.");
  }
  await page.getByLabel("Repository").selectOption(String(liveGitHubRepositoryId));
  await page.getByLabel("Branch").fill(liveGitHubBranch);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.locator(".host-message[role='status']").filter({
    hasText: `Opened ${liveGitHubOwner}/${liveGitHubRepository} · ${liveGitHubBranch}`,
  }).waitFor();
}
