import { defineConfig } from "@playwright/test";

const port = process.env.PROPRIUM_E2E_STATIC_PORT ?? "4275";
const baseURL = process.env.PROPRIUM_E2E_STATIC_BASE_URL ?? `http://127.0.0.1:${port}/`;
const hasLiveGitHubToken = Boolean(process.env.PROPRIUM_E2E_GITHUB_TOKEN || process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN);

export default defineConfig({
  testDir: ".",
  testMatch: "**/static-offline.acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    trace: hasLiveGitHubToken ? "off" : "retain-on-failure",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "static-desktop-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
        launchOptions: process.env.PROPRIUM_E2E_CHROMIUM
          ? { executablePath: process.env.PROPRIUM_E2E_CHROMIUM }
          : undefined,
      },
    },
    {
      name: "static-mobile-webkit",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        launchOptions: process.env.PROPRIUM_E2E_WEBKIT
          ? { executablePath: process.env.PROPRIUM_E2E_WEBKIT }
          : undefined,
      },
    },
  ],
  webServer: {
    command: "node tests/browser/start-static-preview.mjs",
    cwd: process.cwd(),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
