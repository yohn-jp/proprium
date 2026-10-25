import { defineConfig } from "@playwright/test";

const baseURL = process.env.PROPRIUM_E2E_BASE_URL ?? "http://127.0.0.1:4173/";
const externalServer = Boolean(process.env.PROPRIUM_E2E_BASE_URL);
process.env.VITE_PROPRIUM_E2E = "true";
const hasLiveGitHubToken = Boolean(process.env.PROPRIUM_E2E_GITHUB_TOKEN || process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN);

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
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
      name: "desktop-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
        launchOptions: process.env.PROPRIUM_E2E_CHROMIUM
          ? { executablePath: process.env.PROPRIUM_E2E_CHROMIUM }
          : undefined,
      },
    },
    {
      name: "mobile-webkit",
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
  webServer: externalServer
    ? undefined
    : {
        command: "pnpm dev:browser -- --host 127.0.0.1 --port 4173 --strictPort",
        cwd: process.cwd(),
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
