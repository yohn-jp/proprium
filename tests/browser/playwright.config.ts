import { defineConfig } from "@playwright/test";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

const configuredPort = process.env.PROPRIUM_E2E_PORT ?? "4173";
const gatewayPort = process.env.PROPRIUM_E2E_GATEWAY_PORT ?? "4174";
process.env.PROPRIUM_E2E_PORT = configuredPort;
const baseURL = process.env.PROPRIUM_E2E_BASE_URL ?? `http://127.0.0.1:${configuredPort}/`;
const externalServer = Boolean(process.env.PROPRIUM_E2E_BASE_URL);
process.env.VITE_PROPRIUM_E2E = "true";
process.env.VITE_PROPRIUM_GATEWAY_URL ??= `http://127.0.0.1:${gatewayPort}`;
const hasLiveGitHubToken = Boolean(process.env.PROPRIUM_E2E_GITHUB_TOKEN || process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN);
const pluginFixturePrivateKey = process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY
  ? createPrivateKey(process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY)
  : generateKeyPairSync("ed25519").privateKey;
const pluginFixturePublicKey = createPublicKey(pluginFixturePrivateKey);
const pluginFixturePublicKeyBytes = pluginFixturePublicKey.export({ format: "der", type: "spki" }).subarray(-32);
const pluginFixtureOrigin = new URL(baseURL).origin;
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `${pluginFixtureOrigin}/plugin-fixture/registry.json`;
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = pluginFixturePublicKeyBytes.toString("base64");
process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = pluginFixtureOrigin;
// This per-run key signs the test server's fixture data. It has no relationship
// to a production trust root and is never exposed through Vite's VITE_ prefix.
process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY = pluginFixturePrivateKey.export({ format: "pem", type: "pkcs8" }).toString();

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/static-offline.acceptance.spec.ts", "**/authoring-official.acceptance.spec.ts", "**/authoring-mcp.acceptance.spec.ts", "**/plugin-runtime-v2.acceptance.spec.ts"],
  outputDir: "test-results/host",
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
    : [
      {
        command: `pnpm --config.verifyDepsBeforeRun=false dev:browser --host 127.0.0.1 --port ${configuredPort} --strictPort`,
        cwd: process.cwd(),
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
      {
        command: "node tests/browser/start-gateway.mjs",
        cwd: process.cwd(),
        url: `http://127.0.0.1:${gatewayPort}/healthz`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
    ],
});
