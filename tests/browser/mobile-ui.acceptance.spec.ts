import { expect, test } from "@playwright/test";

test("Mobile WebKit library keeps GitHub access visible without a neutral status overlay", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-webkit", "This acceptance check targets the Mobile WebKit shell.");

  await page.goto("/?view=library");

  await expect(page.locator(".mobile-shell-current-title")).toHaveText("作品ライブラリ");
  const libraryHeading = page.locator("#mobile-library-title");
  await expect(libraryHeading).toHaveText("作品ライブラリ");
  await expect(libraryHeading).toHaveClass(/\bsr-only\b/u);
  await expect(page.locator(".mobile-shell-status")).toHaveCount(0);

  const connect = page.getByRole("button", { name: "Connect GitHub", exact: true });
  await expect(connect).toBeVisible();
  await expect(connect).toBeInViewport();

  const gatewaySettings = page.locator("details.gateway-settings");
  if (await gatewaySettings.getAttribute("open") === null) await gatewaySettings.locator("summary").click();
  await page.getByLabel("Proprium Gateway URL", { exact: true }).fill("");
  await connect.click();

  const error = page.getByRole("alert");
  await expect(error).toContainText("Enter the Proprium Gateway URL");
  await expect(error).toBeVisible();
  const status = page.locator(".mobile-shell-status");
  await expect(status).toBeVisible();
  expect(await status.evaluate(element => getComputedStyle(element).position)).toBe("relative");
  await connect.scrollIntoViewIfNeeded();
  const buttonBounds = await connect.boundingBox();
  const statusBounds = await status.boundingBox();
  expect(buttonBounds).not.toBeNull();
  expect(statusBounds).not.toBeNull();
  expect(buttonBounds!.y + buttonBounds!.height).toBeLessThanOrEqual(statusBounds!.y + 1);
});
