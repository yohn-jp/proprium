#!/usr/bin/env node
/** Local verification only. Does not invoke CI, publish images, or deploy. */
import { spawn } from "node:child_process";

const commands = [
  ["pnpm", ["install", "--frozen-lockfile"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["test"]],
  ["pnpm", ["build"]],
  ["pnpm", ["audit:core"]],
  ["pnpm", ["test:e2e"]],
  ["bash", ["scripts/verify-oci.sh"]],
];
for (const [command, args] of commands) {
  console.info(`\nRunning ${command} ${args.join(" ")}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  if (code !== 0) {
    console.error(`Verification stopped: ${command} ${args.join(" ")} exited ${code}`);
    process.exitCode = code;
    break;
  }
}
