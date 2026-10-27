import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hostPort = process.env.PROPRIUM_E2E_PORT ?? "4173";
const gatewayPort = process.env.PROPRIUM_E2E_GATEWAY_PORT ?? "4174";
const { webServer: _unused, ...shared } = base;
const retained = process.env.PROPRIUM_SIGNED_AUTHORING_RELEASE_DIR;
if (retained) {
  const registry = JSON.parse(readFileSync(join(retained, "registry.json"), "utf8")) as { artifactBase:string };
  const origin = new URL(registry.artifactBase).origin;
  process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = [...new Set([new URL(base.use!.baseURL!).origin, origin])].join(",");
}
export default defineConfig({
  ...shared,
  testMatch: "authoring-mcp*.acceptance.spec.ts",
  testIgnore: [],
  globalSetup: "./authoring-mcp.setup.ts",
  timeout: 240_000,
  outputDir: process.env.PROPRIUM_E2E_OUTPUT_DIR ?? "test-results/authoring-mcp",
  projects: shared.projects,
  webServer: [
    { command: `node app/node_modules/vite/bin/vite.js app --config app/vite.proprium.config.ts --host 127.0.0.1 --port ${hostPort} --strictPort`, cwd: process.env.PROPRIUM_E2E_SOURCE ?? process.cwd(), url: `http://127.0.0.1:${hostPort}/`, reuseExistingServer: false, timeout: 120_000 },
    { command: "node tests/browser/start-gateway.mjs", cwd: process.env.PROPRIUM_E2E_SOURCE ?? process.cwd(), url: `http://127.0.0.1:${gatewayPort}/healthz`, reuseExistingServer: false, timeout: 120_000 },
  ],
});
