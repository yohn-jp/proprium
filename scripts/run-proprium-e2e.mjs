import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(command, ["exec", "playwright", "test", "--config", "tests/browser/playwright.config.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, VITE_PROPRIUM_E2E: "true" },
});
child.once("error", error => {
  console.error(`Could not start Playwright: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
