import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const externalRepository = Boolean(process.env.SCRIPTORIUM_E2E_REPOSITORY_URL);
const selectedTestFile = process.env.SCRIPTORIUM_E2E_TEST_FILE;
const browserGitSuite = ["browser-git.acceptance.spec.ts", "browser-git-sync.acceptance.spec.ts"].includes(selectedTestFile ?? "");
const pluginRuntimeSuite = selectedTestFile === "plugin-runtime.acceptance.spec.ts";
const coverageFile = process.env.SCRIPTORIUM_E2E_COVERAGE_FILE;
const configuredBaseURL = process.env.SCRIPTORIUM_E2E_BASE_URL ?? process.env.SCRIPTORIUM_BASE_URL;
const baseURL = configuredBaseURL ?? `http://127.0.0.1:${process.env.SCRIPTORIUM_E2E_PORT ?? "4173"}`;
const configuredPort = process.env.SCRIPTORIUM_E2E_PORT ?? "4173";
const externalServer = Boolean(configuredBaseURL);
const hasLiveGitHubToken = Boolean(process.env.PROPRIUM_E2E_GITHUB_TOKEN || process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN);
const isTemporaryStateDir = !process.env.SCRIPTORIUM_E2E_STATE_DIR && !externalServer;
const stateDir = process.env.SCRIPTORIUM_E2E_STATE_DIR
  ?? (externalServer ? tmpdir() : mkdtempSync(join(tmpdir(), "scriptorium-e2e-")));
const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN
  ?? (configuredBaseURL ? process.env.SCRIPTORIUM_AUTH_TOKEN : undefined)
  ?? "scriptorium-e2e-token-for-local-testing-only";

process.env.SCRIPTORIUM_E2E_STATE_DIR = stateDir;
process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ??= resolve(stateDir, "origin.git");
if (!configuredBaseURL && !externalRepository) {
  process.env.SCRIPTORIUM_E2E_MODULAR_REPOSITORY_URL ??= resolve(stateDir, "modular-origin.git");
}
process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ??= "main";
process.env.SCRIPTORIUM_E2E_AUTH_TOKEN = authToken;
process.env.SCRIPTORIUM_E2E_PORT ??= "4173";
process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY ??= externalRepository ? "1" : "";
process.env.SCRIPTORIUM_E2E_TEMP_STATE_DIR = isTemporaryStateDir ? "1" : "";
if (externalServer && !externalRepository) {
  throw new Error("Set SCRIPTORIUM_E2E_REPOSITORY_URL to a disposable HTTPS GitHub fixture when targeting an external app");
}
if (selectedTestFile && !/^[a-z0-9-]+\.acceptance\.spec\.ts$/u.test(selectedTestFile)) {
  throw new Error("SCRIPTORIUM_E2E_TEST_FILE must name one acceptance spec");
}

export default defineConfig({
  testDir: ".",
  testMatch: selectedTestFile ? `**/${selectedTestFile}` : "**/*.spec.ts",
  testIgnore: "**/core64-lifecycle.host.acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  reporter: coverageFile
    ? [
        ["list"],
        [resolve("scripts/browser-coverage-reporter.mjs"), { outputFile: coverageFile }],
      ]
    : "list",
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
        launchOptions: process.env.SCRIPTORIUM_E2E_CHROMIUM
          ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM }
          : undefined,
      },
    },
    {
      name: "webkit",
      testMatch: pluginRuntimeSuite
        ? "**/plugin-runtime.acceptance.spec.ts"
        : ["**/ui-v1.acceptance.spec.ts", "**/browser-git-sync.acceptance.spec.ts"],
      use: {
        browserName: "webkit",
        launchOptions: process.env.SCRIPTORIUM_E2E_WEBKIT
          ? { executablePath: process.env.SCRIPTORIUM_E2E_WEBKIT }
          : undefined,
      },
    },
  ],
  webServer: externalServer
    ? undefined
    : {
        command: browserGitSuite || pluginRuntimeSuite
          ? `pnpm --dir app exec vite --config vite.config.ts --host 127.0.0.1 --port ${configuredPort}`
          : "node --import tsx/esm tests/e2e/test-server.ts",
        cwd: resolve("."),
        url: browserGitSuite ? `${baseURL}/browser-git-test.html` : pluginRuntimeSuite ? `${baseURL}/plugin-runtime-test.html` : `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
