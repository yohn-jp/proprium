import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const port = process.env.PROPRIUM_E2E_PORT ?? "4183";
const root = resolve(process.cwd());
export default defineConfig({
  testDir: ".",
  testMatch: "diagnostic-margin.acceptance.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}/`, headless: true },
  projects: [{ name: "desktop-chromium", use: {
    browserName: "chromium",
    launchOptions: process.env.PROPRIUM_E2E_CHROMIUM ? { executablePath: process.env.PROPRIUM_E2E_CHROMIUM } : undefined,
  } }],
  // The editor fixture exercises CodeMirror from the Browser Host source without a Gateway.
  webServer: {
    command: `pnpm --config.verifyDepsBeforeRun=false dev:browser --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root, url: `http://127.0.0.1:${port}/`, reuseExistingServer: false, timeout: 120_000,
  },
});
