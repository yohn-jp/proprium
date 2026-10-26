import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, "../..");
const jco = process.platform === "win32"
  ? resolve(repositoryRoot, "node_modules/.bin/jco.cmd")
  : resolve(repositoryRoot, "node_modules/.bin/jco");
const output = resolve(packageDirectory, "dist/plugin.component.wasm");

await mkdir(dirname(output), { recursive: true });
execFileSync(jco, [
  "componentize",
  resolve(packageDirectory, "guest.ts"),
  "--wit", resolve(repositoryRoot, "app/src/browser/proprium/plugin-runtime/wit-v2"),
  "--world-name", "proprium:plugin/plugin@2.0.0",
  "--disable", "all",
  "--bundle",
  "-o", output,
], { cwd: packageDirectory, stdio: "inherit" });
console.log(`Built Semantic Component at ${output}`);
