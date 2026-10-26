import { defineConfig } from "@playwright/test";

const port = process.env.PROPRIUM_E2E_PORT ?? "4173";
process.env.PROPRIUM_E2E_PORT = port;
const baseURL = process.env.PROPRIUM_E2E_BASE_URL ?? `http://127.0.0.1:${port}/`;
const externalServer = Boolean(process.env.PROPRIUM_E2E_BASE_URL);
process.env.VITE_PROPRIUM_E2E = "true";

export default defineConfig({
  testDir: ".",
  testMatch: "**/plugin-runtime-v2.acceptance.spec.ts",
  outputDir: "test-results/plugin-runtime-v2",
  globalSetup: "./plugin-runtime-v2.setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
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
  webServer: externalServer ? undefined : {
    command: `pnpm --config.verifyDepsBeforeRun=false dev:browser --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: process.cwd(),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
