import { spawnSync } from "node:child_process";

if (process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_TOKEN) {
  const required = [
    "SCRIPTORIUM_GITHUB_LIVE_TEST_OWNER",
    "SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY",
    "SCRIPTORIUM_GITHUB_LIVE_TEST_REPOSITORY_ID",
    "SCRIPTORIUM_GITHUB_LIVE_TEST_BRANCH",
  ];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Live GitHub adapter tests require ${missing.join(", ")}`);
  if (["main", "master"].includes(process.env.SCRIPTORIUM_GITHUB_LIVE_TEST_BRANCH.toLowerCase())) {
    throw new Error("Live GitHub adapter tests require an explicitly configured disposable branch, not main or master.");
  }
}

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const suites = [
  ["browser-git.acceptance.spec.ts", "4275"],
  ["authoring-snapshot.acceptance.spec.ts", "4277"],
  ["browser-git-sync.acceptance.spec.ts", "4273"],
  ["plugin-runtime.acceptance.spec.ts", "4275"],
];

for (const [file, port] of suites) {
  console.info(`\nRunning browser adapter acceptance suite: ${file} (port ${port})`);
  const result = spawnSync(command, ["exec", "playwright", "test", "--config", "tests/e2e/playwright.config.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_PROPRIUM_E2E: "true",
      SCRIPTORIUM_E2E_TEST_FILE: file,
      SCRIPTORIUM_E2E_PORT: port,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
