import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const port = process.env.PROPRIUM_E2E_STATIC_PORT ?? "4275";
const environment = { ...process.env };
delete environment.VITE_PROPRIUM_E2E;
delete environment.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY;

const build = spawn(command, ["--config.verifyDepsBeforeRun=false", "build:browser"], {
  cwd: process.cwd(), stdio: "inherit", env: environment,
});
build.once("error", error => {
  console.error(`Could not start the static Proprium build: ${error.message}`);
  process.exitCode = 1;
});
const buildCode = await new Promise(resolve => build.once("exit", code => resolve(code ?? 1)));
if (buildCode !== 0) process.exit(Number(buildCode));

const preview = spawn(command, [
  "--config.verifyDepsBeforeRun=false", "--dir", "app", "exec", "vite", "preview",
  "--config", "vite.proprium.config.ts", "--host", "127.0.0.1", "--port", port, "--strictPort",
], { cwd: process.cwd(), stdio: "inherit", env: environment });
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
