import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const externalRepository = Boolean(process.env.SCRIPTORIUM_E2E_REPOSITORY_URL);
const configuredBaseURL = process.env.SCRIPTORIUM_E2E_BASE_URL ?? process.env.SCRIPTORIUM_BASE_URL;
const baseURL = configuredBaseURL ?? `http://127.0.0.1:${process.env.SCRIPTORIUM_E2E_PORT ?? "4173"}`;
const externalServer = Boolean(configuredBaseURL);
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

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/core64-lifecycle.host.acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
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
      testMatch: "**/ui-v1.acceptance.spec.ts",
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
        command: "node --import tsx/esm tests/e2e/test-server.ts",
        cwd: resolve("."),
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
