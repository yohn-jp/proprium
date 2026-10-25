import { defineConfig } from "@playwright/test";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

const port = process.env.PROPRIUM_E2E_STATIC_PORT ?? "4276";
const baseURL = process.env.PROPRIUM_E2E_STATIC_BASE_URL ?? `http://127.0.0.1:${port}/`;
const hasLiveGitHubToken = Boolean(process.env.PROPRIUM_E2E_GITHUB_TOKEN || process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN);
const origin = new URL(baseURL).origin;
const fixturePrivateKey = process.env.PROPRIUM_E2E_STATIC_PLUGIN_REGISTRY_PRIVATE_KEY
  ? createPrivateKey(process.env.PROPRIUM_E2E_STATIC_PLUGIN_REGISTRY_PRIVATE_KEY)
  : generateKeyPairSync("ed25519").privateKey;
const fixturePublicKey = createPublicKey(fixturePrivateKey).export({ format: "der", type: "spki" }).subarray(-32);
process.env.PROPRIUM_E2E_STATIC_PLUGIN_REGISTRY_PRIVATE_KEY = fixturePrivateKey.export({ format: "pem", type: "pkcs8" }).toString();
process.env.VITE_PROPRIUM_GITHUB_AUTH_RELAY = "https://oauth.example.test";
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `${origin}/plugin-fixture/registry.json`;
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = fixturePublicKey.toString("base64");
process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = origin;

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
