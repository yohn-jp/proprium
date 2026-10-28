import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import base from "./playwright.config.js";

const port = process.env.PROPRIUM_E2E_PORT ?? "4237";
const origin = `http://127.0.0.1:${port}`;
process.env.VITE_PROPRIUM_E2E = "true";
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `${origin}/plugin-fixture/registry.json`;
const artifactOrigin = new URL(process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE ?? "https://authoring-build.invalid/plugins/").origin;
process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = [...new Set([origin, artifactOrigin])].join(",");
if (process.env.PROPRIUM_KNOWLEDGE_PUBLIC_KEY) process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = readFileSync(process.env.PROPRIUM_KNOWLEDGE_PUBLIC_KEY, "utf8").trim();
const { webServer: _unused, ...shared } = base;
export default defineConfig({ ...shared,
  testMatch: "authoring-knowledge.acceptance.ts", testIgnore: [], timeout: 180_000,
  globalSetup: process.env.PROPRIUM_KNOWLEDGE_REGISTRY ? undefined : "./authoring-official.setup.ts",
  outputDir: process.env.PROPRIUM_E2E_OUTPUT_DIR ?? "test-results/authoring-knowledge",
  projects: shared.projects,
  use: { ...shared.use, baseURL: `${origin}/`, actionTimeout: 15_000 },
  webServer: [{ command: `node app/node_modules/vite/bin/vite.js app --config app/vite.proprium.config.ts --host 127.0.0.1 --port ${port} --strictPort`, cwd: process.env.PROPRIUM_E2E_SOURCE ?? process.cwd(), url: `${origin}/`, reuseExistingServer: false, timeout: 120_000 }],
});
