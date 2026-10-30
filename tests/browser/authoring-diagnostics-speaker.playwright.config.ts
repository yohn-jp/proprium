import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const source = resolve(process.env.PROPRIUM_E2E_SOURCE ?? ".");
const port = process.env.PROPRIUM_E2E_PORT ?? "4173";
const { webServer: _unused, ...shared } = base;
const externalSignedFixture = Boolean(process.env.PROPRIUM_OFFICIAL_E2E_DIR && process.env.PROPRIUM_DIAGNOSTICS_PUBLIC_KEY_FILE);
if (externalSignedFixture) {
  const artifactBase = process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE;
  if (!artifactBase) throw new Error("PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE is required with an external signed fixture");
  const baseUrl = new URL(artifactBase);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = new URL("registry.json", baseUrl).href;
  process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = readFileSync(process.env.PROPRIUM_DIAGNOSTICS_PUBLIC_KEY_FILE, "utf8").trim();
  process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = baseUrl.origin;
}

export default defineConfig(shared, {
  testMatch: "authoring-diagnostics-speaker.acceptance.ts",
  testIgnore: [],
  globalSetup: externalSignedFixture ? undefined : "./authoring-official.setup.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: { ...shared.use, actionTimeout: 15_000 },
  webServer: [
    { command: `node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json && node app/node_modules/vite/bin/vite.js app --config app/vite.proprium.config.ts --host 127.0.0.1 --port ${port} --strictPort`, cwd: source, url: `http://127.0.0.1:${port}/`, reuseExistingServer: false, timeout: 120_000 },
  ],
});
