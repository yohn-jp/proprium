import { test, expect } from "@playwright/test";
import { installStaticGitHubFixture, staticFixtureIdentity } from "./static-github-fixture.js";
import { chooseFile, showPanel, configureGateway } from "./restored-ui.helpers.js";

test("workspace picker text stays readable in every appearance mode", async ({ page }, testInfo) => {
  await page.goto("/");
  for (const theme of ["light", "dark", "paper"]) {
    await page.getByLabel("外観", { exact: true }).selectOption(theme);
    for (const target of [page.getByRole("heading", { name: "Open a GitHub workspace" }), page.locator(".welcome-copy > p").last()]) {
      const contrast = await target.evaluate(element => {
        const rgb = (value: string) => (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
        const luminance = (values: number[]) => values.map(value => { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
        let ancestor: Element | null = element;
        let background = "rgb(255, 255, 255)";
        while (ancestor) { const color = getComputedStyle(ancestor).backgroundColor; if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") { background = color; break; } ancestor = ancestor.parentElement; }
        const a = luminance(rgb(getComputedStyle(element).color)), b = luminance(rgb(background));
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      expect(contrast, `${theme} text contrast`).toBeGreaterThanOrEqual(4.5);
    }
    await page.screenshot({ path: testInfo.outputPath(`picker-${theme}.png`), fullPage: true });
  }
});

test("GitHub authorization shows its code before navigation and reconnects recent workspaces", async ({ page, context }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await installStaticGitHubFixture(page, origin);
  await configureGateway(page, origin);
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(page.getByRole("region", { name: "GitHub device authorization" })).toContainText("STAT-IC01");
  expect(context.pages()).toHaveLength(1);
  await expect(page.locator(".host-message[role='status']")).toContainText("Connected to GitHub as");
  await page.getByLabel("Repository", { exact: true }).selectOption(String(staticFixtureIdentity.repositoryId));
  await page.getByLabel("Branch", { exact: true }).fill(staticFixtureIdentity.branch);
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await chooseFile(page, "README.md");
  await page.getByRole("button", { name: "Workspaces", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`${staticFixtureIdentity.owner}/${staticFixtureIdentity.repository}`, "u") }).click();
  await showPanel(page, "outline");
  await expect(page.getByLabel("Connected to GitHub", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fetch", exact: true })).toBeEnabled();
});

test("repository-list failure does not leave a false connected account", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await installStaticGitHubFixture(page, origin);
  await page.context().route("https://api.github.com/user/repos?**", route => route.fulfill({ status: 503, contentType: "application/json", headers: { "Access-Control-Allow-Origin": origin }, body: JSON.stringify({ message: "Fixture repository list unavailable" }) }));
  await configureGateway(page, origin);
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(page.locator(".host-message[role='alert']")).toContainText("GitHub could not list repositories for this account");
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Repository", { exact: true })).toHaveCount(0);
});
test("canceling Device authorization does not interfere with a later sign-in", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await installStaticGitHubFixture(page, origin);
  let pending = true;
  await page.context().route(`${origin}/oauth/token`, route => pending
    ? route.fulfill({ status: 200, contentType: "application/json", json: { error: "authorization_pending" } })
    : route.fallback());
  await configureGateway(page, origin);
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await page.getByRole("button", { name: "Cancel GitHub sign-in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toBeEnabled();
  pending = false;
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("Connected to GitHub as");
  await expect(page.getByLabel("Repository", { exact: true })).toBeVisible();
});
