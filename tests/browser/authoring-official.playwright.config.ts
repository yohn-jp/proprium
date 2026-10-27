import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
import { resolve } from "node:path";

const source = resolve(process.env.PROPRIUM_E2E_SOURCE ?? ".");
const port = process.env.PROPRIUM_E2E_PORT ?? "4173";
const { webServer: _unused, ...shared } = base;
export default defineConfig(shared, {
  testMatch: "authoring-official.acceptance.spec.ts",
  testIgnore: [],
  globalSetup: "./authoring-official.setup.ts",
  timeout: 180_000,
  webServer: [
    { command: `node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json && node app/node_modules/vite/bin/vite.js app --config app/vite.proprium.config.ts --host 127.0.0.1 --port ${port} --strictPort`, cwd: source, url: `http://127.0.0.1:${port}/`, reuseExistingServer: false, timeout: 120_000 },
  ],
});
