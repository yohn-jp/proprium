import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const chromium = process.env.SCRIPTORIUM_E2E_CHROMIUM;

export default {
  testDir: resolve(repositoryRoot, "tests/e2e"),
  testMatch: "core64-lifecycle.host.acceptance.spec.ts",
  outputDir: process.env.SCRIPTORIUM_C64_LIFECYCLE_RESULTS ?? "/tmp/scriptorium-core64-lifecycle-host-results",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4189",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{
    name: "chromium",
    use: {
      browserName: "chromium",
      ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
    },
  }],
  webServer: {
    command: "pnpm --dir app exec vite --config ../tests/e2e/core64-lifecycle/vite.config.mjs --host 127.0.0.1 --port 4189 --strictPort",
    cwd: repositoryRoot,
    url: "http://127.0.0.1:4189/tests/e2e/core64-lifecycle/host-fixture.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
};
