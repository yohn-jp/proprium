import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/protocol.js";
import { chooseFile, expectEditorText, showPanel } from "./restored-ui.helpers.js";
import { installStaticGitHubFixture, staticFixtureIdentity, staticFixtureLogin } from "./static-github-fixture.js";

declare global {
  interface Window {
    propriumHostTest?: {
      openWorkspace(identity: WorkspaceIdentity, files?: Record<string, string>): Promise<void>;
    };
  }
}

const localWorkspaceText = "Cached workspace content before GitHub sign-in.\n";
const dirtyEditorText = "Unsaved text that must survive GitHub sign-in.\n";

async function openCachedWorkspaceWithDirtyEditor(page: Page): Promise<{
  origin: string;
  identity: WorkspaceIdentity;
  fixture: Awaited<ReturnType<typeof installStaticGitHubFixture>>;
}> {
  await page.goto("/?e2e=1");
  const origin = new URL(page.url()).origin;
  const fixture = await installStaticGitHubFixture(page, origin);
  const identity: WorkspaceIdentity = {
    ...staticFixtureIdentity,
    localWorkspaceId: `cached-auth-${crypto.randomUUID()}`,
  };
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async ({ identity, text }) => {
    await window.propriumHostTest!.openWorkspace(identity, { "README.md": text });
  }, { identity, text: localWorkspaceText });

  await page.getByRole("button", { name: "Workspaces", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`${identity.owner}/${identity.repository}`, "u") }).click();
  await chooseFile(page, "README.md");
  await expectEditorText(page, localWorkspaceText);
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill(dirtyEditorText);
  await showPanel(page, "outline");
  await expect(page.getByRole("button", { name: "GitHubに接続", exact: true })).toBeVisible();
  return { origin, identity, fixture };
}

async function startWorkspaceSignIn(page: Page, origin: string): Promise<import("@playwright/test").Locator> {
  await showPanel(page, "outline");
  await page.getByRole("button", { name: "GitHubに接続", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "このWorkspaceをGitHubに接続" });
  await expect(dialog).toBeVisible();
  const gatewaySettings = dialog.locator("details.gateway-settings");
  if (await gatewaySettings.getAttribute("open") === null) await gatewaySettings.locator("summary").click();
  await dialog.getByLabel("Proprium Gateway URL").fill(origin);
  if (await gatewaySettings.getAttribute("open") !== null) await gatewaySettings.locator("summary").click();
  await dialog.getByRole("button", { name: "GitHubに接続", exact: true }).click();
  return dialog;
}

test("cached Workspace signs in in place and enables Fetch without changing dirty editor text", async ({ page }, testInfo) => {
  const { origin, identity, fixture } = await openCachedWorkspaceWithDirtyEditor(page);
  const dialog = await startWorkspaceSignIn(page, origin);

  await expect(dialog.getByRole("region", { name: "GitHub device authorization" })).toContainText("STAT-IC01");
  await expect(dialog.getByRole("status")).toContainText("GitHubでの承認を待っています");
  if (testInfo.project.name === "desktop-chromium") await expect(page.locator(".editor-protection")).not.toContainText("結果確認中");
  await page.screenshot({ path: testInfo.outputPath("cached-workspace-github-auth.png"), fullPage: true });
  await expect(dialog).toBeHidden();
  await expect(page.locator(".host-message[role='status']")).toContainText(`Connected this Workspace to GitHub as ${staticFixtureLogin}`);
  await expect(page.getByLabel("Connected to GitHub", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fetch", exact: true })).toBeEnabled();
  await expectEditorText(page, dirtyEditorText);
  await expect(page.locator(".save-state")).toHaveText("Unsaved editor text");

  const apiPaths = fixture.apiPaths().map(path => path.replaceAll(identity.localWorkspaceId, ""));
  expect(apiPaths.some(path => path.endsWith(`/repos/${identity.owner}/${identity.repository}`))).toBe(true);
  expect(apiPaths.some(path => path.endsWith(`/repos/${identity.owner}/${identity.repository}/git/ref/heads/${identity.branch}`))).toBe(true);
  expect(apiPaths.some(path => /\/commits(?:\/|$)|\/git\/(?:trees|blobs)\//u.test(path))).toBe(false);
});

test("cancel and repository verification failure leave the cached editor and Workspace intact", async ({ page }) => {
  const { origin, identity } = await openCachedWorkspaceWithDirtyEditor(page);
  let pending = true;
  await page.context().route(`${origin}/oauth/token`, route => pending
    ? route.fulfill({ status: 200, contentType: "application/json", json: { error: "authorization_pending" } })
    : route.fallback());

  let dialog = await startWorkspaceSignIn(page, origin);
  await expect(dialog.getByRole("region", { name: "GitHub device authorization" })).toContainText("STAT-IC01");
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Connected to GitHub", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fetch", exact: true })).toHaveCount(0);
  await expectEditorText(page, dirtyEditorText);

  pending = false;
  await page.context().route(`https://api.github.com/repos/${identity.owner}/${identity.repository}`, async route => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type, X-GitHub-Api-Version",
      } });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": origin }, json: {
      id: identity.repositoryId + 1,
      full_name: `${identity.owner}/${identity.repository}`,
      owner: { login: identity.owner },
      permissions: { pull: true, push: true },
    } });
  });

  dialog = await startWorkspaceSignIn(page, origin);
  await expect(dialog.getByRole("alert")).toContainText("repository_mismatch");
  await expect(page.getByLabel("Connected to GitHub", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fetch", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expectEditorText(page, dirtyEditorText);
  await expect(page.locator(".save-state")).toHaveText("Unsaved editor text");
});

test("cancel before the Device code arrives does not revive an old authorization screen", async ({ page }) => {
  const { origin } = await openCachedWorkspaceWithDirtyEditor(page);
  let releaseCode!: () => void;
  const gate = new Promise<void>(resolve => { releaseCode = resolve; });
  await page.context().route(`${origin}/oauth/device/code`, async route => { await gate; await route.fallback(); });
  const requested = page.waitForRequest(request => request.method() === "POST" && request.url() === `${origin}/oauth/device/code`);
  const dialog = await startWorkspaceSignIn(page, origin);
  await requested;
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(dialog).toBeHidden();
  const finished = page.waitForEvent("requestfinished", { predicate: request => request.method() === "POST" && request.url() === `${origin}/oauth/device/code` });
  releaseCode();
  await finished;
  await showPanel(page, "outline");
  await page.getByRole("button", { name: "GitHubに接続", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "GitHub device authorization" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "GitHubに接続", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expectEditorText(page, dirtyEditorText);
});
