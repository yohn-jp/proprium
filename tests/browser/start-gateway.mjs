import { spawn } from "node:child_process";

const command = process.env.GO_BINARY ?? "go";
const hostPort = process.env.PROPRIUM_E2E_PORT ?? "4173";
const gatewayPort = process.env.PROPRIUM_E2E_GATEWAY_PORT ?? "4174";
const gatewayOrigin = process.env.VITE_PROPRIUM_GATEWAY_URL ?? `http://127.0.0.1:${gatewayPort}`;
const gateway = spawn(command, ["run", ".", "serve", "--listen", `127.0.0.1:${gatewayPort}`], {
  cwd: "gateway",
  env: {
    ...process.env,
    PROPRIUM_HOST_ORIGIN: `http://127.0.0.1:${hostPort}`,
    PROPRIUM_PUBLIC_URL: gatewayOrigin,
    PROPRIUM_OWNER_KEY: "proprium-gateway-browser-e2e-owner-key-32-bytes",
    GITHUB_CLIENT_ID: "proprium-e2e-client-id",
  },
  stdio: "inherit",
});

gateway.once("error", error => {
  console.error(`Could not start the Go Gateway: ${error.message}`);
  process.exitCode = 1;
});
gateway.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => gateway.kill(signal));
}
