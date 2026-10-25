import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const port = process.env.PROPRIUM_E2E_STATIC_PORT ?? "4276";
const buildEnvironment = { ...process.env };
delete buildEnvironment.VITE_PROPRIUM_E2E;
delete buildEnvironment.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY;
delete buildEnvironment.PROPRIUM_E2E_STATIC_PLUGIN_REGISTRY_PRIVATE_KEY;
buildEnvironment.VITE_PROPRIUM_GITHUB_AUTH_RELAY = "https://oauth.example.test";

const build = spawn(command, ["--config.verifyDepsBeforeRun=false", "build:browser"], {
  cwd: process.cwd(), stdio: "inherit", env: buildEnvironment,
});
build.once("error", error => {
  console.error(`Could not start the static Proprium build: ${error.message}`);
  process.exitCode = 1;
});
const buildCode = await new Promise(resolve => build.once("exit", code => resolve(code ?? 1)));
if (buildCode !== 0) process.exit(Number(buildCode));

const serverEnvironment = { ...buildEnvironment };
delete serverEnvironment.VITE_PROPRIUM_GITHUB_AUTH_RELAY;
delete serverEnvironment.VITE_PROPRIUM_PLUGIN_REGISTRY_URL;
delete serverEnvironment.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY;
delete serverEnvironment.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS;
const preview = spawn(command, [
  "--config.verifyDepsBeforeRun=false", "exec", "wrangler", "dev", "--local",
  "--ip", "127.0.0.1", "--port", port, "--config", "wrangler.jsonc",
], { cwd: process.cwd(), stdio: "inherit", env: serverEnvironment });
preview.once("error", error => {
  console.error(`Could not start the static Proprium preview: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => preview.kill(signal));
}
preview.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
