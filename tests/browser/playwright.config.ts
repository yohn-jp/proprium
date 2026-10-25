import { defineConfig } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";

const configuredPort = process.env.PROPRIUM_E2E_PORT ?? "4173";
const baseURL = process.env.PROPRIUM_E2E_BASE_URL ?? `http://127.0.0.1:${configuredPort}/`;
const externalServer = Boolean(process.env.PROPRIUM_E2E_BASE_URL);
process.env.VITE_PROPRIUM_E2E = "true";
const hasLiveGitHubToken = Boolean(process.env.PROPRIUM_E2E_GITHUB_TOKEN || process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN);
const pluginFixtureSigner = generateKeyPairSync("ed25519");
const pluginFixturePublicKey = pluginFixtureSigner.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const pluginFixtureOrigin = new URL(baseURL).origin;
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `${pluginFixtureOrigin}/plugin-fixture/registry.json`;
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = pluginFixturePublicKey.toString("base64");
process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = pluginFixtureOrigin;
// This per-run key signs the test server's fixture data. It has no relationship
// to a production trust root and is never exposed through Vite's VITE_ prefix.
process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY = pluginFixtureSigner.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

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
        command: `pnpm --config.verifyDepsBeforeRun=false dev:browser --host 127.0.0.1 --port ${configuredPort} --strictPort`,
        cwd: process.cwd(),
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
