import { defineConfig } from "@playwright/test";

const configuredPort = process.env.PROPRIUM_E2E_PORT ?? process.env.SCRIPTORIUM_E2E_PORT ?? "4173";
const baseURL = `http://127.0.0.1:${configuredPort}/`;
const selectedTestFile = process.env.PROPRIUM_E2E_TEST_FILE ?? process.env.SCRIPTORIUM_E2E_TEST_FILE;
const browserAcceptanceFiles = [
  "browser-git.acceptance.spec.ts",
  "authoring-snapshot.acceptance.spec.ts",
  "authoring-writer-git-guard.acceptance.spec.ts",
  "browser-git-sync.acceptance.spec.ts",
  "plugin-runtime.acceptance.spec.ts",
];
const webKitFiles = ["authoring-snapshot.acceptance.spec.ts", "authoring-writer-git-guard.acceptance.spec.ts", "browser-git-sync.acceptance.spec.ts", "plugin-runtime.acceptance.spec.ts"];
const hasLiveGitHubToken = Boolean(process.env.PROPRIUM_E2E_GITHUB_TOKEN || process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN);
const selectedPattern = selectedTestFile ? `**/${selectedTestFile}` : undefined;

if (selectedTestFile && !browserAcceptanceFiles.includes(selectedTestFile)) {
  throw new Error(`Unknown browser acceptance test: ${selectedTestFile}`);
}

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  testMatch: selectedPattern ?? browserAcceptanceFiles.map(file => `**/${file}`),
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
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
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: (process.env.PROPRIUM_E2E_CHROMIUM ?? process.env.SCRIPTORIUM_E2E_CHROMIUM)
          ? { executablePath: process.env.PROPRIUM_E2E_CHROMIUM ?? process.env.SCRIPTORIUM_E2E_CHROMIUM }
          : undefined,
      },
    },
    {
      name: "webkit-mobile",
      testMatch: selectedPattern ?? webKitFiles.map(file => `**/${file}`),
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        launchOptions: (process.env.PROPRIUM_E2E_WEBKIT ?? process.env.SCRIPTORIUM_E2E_WEBKIT)
          ? { executablePath: process.env.PROPRIUM_E2E_WEBKIT ?? process.env.SCRIPTORIUM_E2E_WEBKIT }
          : undefined,
      },
    },
  ],
  webServer: {
    command: `pnpm --config.verifyDepsBeforeRun=false dev:browser --host 127.0.0.1 --port ${configuredPort} --strictPort`,
    cwd: process.cwd(),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
