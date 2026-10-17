#!/usr/bin/env node
/** Local verification only. Does not invoke CI, publish images, or deploy. */
import { spawn } from "node:child_process";

const commands = [
  ["pnpm", ["install", "--frozen-lockfile"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["test"]],
  ["pnpm", ["build"], { SCRIPTORIUM_PROFILE: "core" }],
  ["pnpm", ["audit:core"], { SCRIPTORIUM_PROFILE: "core" }],
  ["pnpm", ["exec", "playwright", "test", "--config", "tests/e2e/playwright.config.ts"], { SCRIPTORIUM_PROFILE: "core" }],
  ["bash", ["scripts/verify-oci.sh"], { SCRIPTORIUM_PROFILE: "core", SCRIPTORIUM_OCI_IMAGE: process.env.SCRIPTORIUM_OCI_CORE_IMAGE ?? "scriptorium:verification-core" }],
  ["pnpm", ["build"], { SCRIPTORIUM_PROFILE: "full" }],
  ["pnpm", ["exec", "playwright", "test", "--config", "tests/e2e/playwright.config.ts"], { SCRIPTORIUM_PROFILE: "full" }],
  ["node", ["--test", "tests/integration/mcp-acceptance.test.mjs"], { SCRIPTORIUM_MCP_ACCEPTANCE_MODULES: "story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp" }],
  ["node", ["--test", "modules/diagnostics/tests/production.acceptance.mjs"]],
  ["node", ["--test", "tests/integration/migration-acceptance.test.mjs"]],
  ["bash", ["scripts/verify-oci.sh"], { SCRIPTORIUM_PROFILE: "full", SCRIPTORIUM_OCI_IMAGE: process.env.SCRIPTORIUM_OCI_FULL_IMAGE ?? "scriptorium:verification-full" }],
];
for (const [command, args, overrides = {}] of commands) {
  const profile = overrides.SCRIPTORIUM_PROFILE;
  console.info(`\nRunning ${command} ${args.join(" ")}${profile ? ` (profile=${profile})` : ""}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...overrides } });
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  if (code !== 0) {
    console.error(`Verification stopped: ${command} ${args.join(" ")} exited ${code}`);
    process.exitCode = code;
    break;
  }
}
