import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import base from "./playwright.config.js";

const port = process.env.PROPRIUM_E2E_PORT ?? "4237";
const origin = `http://127.0.0.1:${port}`;
process.env.VITE_PROPRIUM_E2E = "true";
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `${origin}/plugin-fixture/registry.json`;
process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = `${origin},https://authoring-build.invalid`;
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = readFileSync(process.env.PROPRIUM_KNOWLEDGE_PUBLIC_KEY ?? "/tmp/proprium-2e210ba-public-key.txt", "utf8").trim();
const { webServer: _unused, ...shared } = base;
export default defineConfig({ ...shared,
  testMatch: "authoring-knowledge.acceptance.ts", testIgnore: [], timeout: 180_000,
  outputDir: process.env.PROPRIUM_E2E_OUTPUT_DIR ?? "/tmp/proprium-knowledge-browser-results",
  projects: [shared.projects![0]!],
  use: { ...shared.use, baseURL: `${origin}/`, actionTimeout: 15_000 },
  webServer: [{ command: `node app/node_modules/vite/bin/vite.js app --config app/vite.proprium.config.ts --host 127.0.0.1 --port ${port} --strictPort`, cwd: process.cwd(), url: `${origin}/`, reuseExistingServer: false, timeout: 120_000 }],
});
