import { configureGateway } from "./restored-ui.helpers.js";
import type { Page } from "@playwright/test";
import { installMockGitHubOAuth } from "../helpers/github-relay-fixture.js";

export const liveGitHubToken = process.env.PROPRIUM_E2E_GITHUB_TOKEN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN ?? "";
export const liveGitHubOwner = process.env.PROPRIUM_E2E_GITHUB_OWNER ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_OWNER ?? "";
export const liveGitHubRepository = process.env.PROPRIUM_E2E_GITHUB_REPOSITORY ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY ?? "";
export const liveGitHubRepositoryId = Number(process.env.PROPRIUM_E2E_GITHUB_REPOSITORY_ID ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY_ID ?? "0");
export const liveGitHubBranch = process.env.PROPRIUM_E2E_GITHUB_BRANCH ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_BRANCH ?? "";
export const liveGitHubLogin = process.env.PROPRIUM_E2E_GITHUB_LOGIN ?? process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_LOGIN ?? "";
export const liveGatewayUrl = process.env.PROPRIUM_E2E_GATEWAY_URL ?? "";

/** Mocks only GitHub OAuth; Smart HTTP Git requests travel to the configured Go Gateway. */
export async function routeFixtureRelay(page: Page, hostOrigin: string, relayUrl = liveGatewayUrl): Promise<void> {
  if (!relayUrl) throw new Error("Live GitHub acceptance requires PROPRIUM_E2E_GATEWAY_URL.");
  await installMockGitHubOAuth(page, { relayUrl, hostOrigin, accessToken: liveGitHubToken });
}

export async function connectAndOpenGitHubBranch(page: Page, hostOrigin: string, relayUrl = liveGatewayUrl): Promise<void> {
  if (!relayUrl) throw new Error("Live GitHub acceptance requires PROPRIUM_E2E_GATEWAY_URL.");
  if (!liveGitHubBranch || ["main", "master"].includes(liveGitHubBranch.toLowerCase())) {
    throw new Error("GitHub browser acceptance requires an explicit disposable non-main branch.");
  }
  await routeFixtureRelay(page, hostOrigin, relayUrl);
  await configureGateway(page, relayUrl);
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
