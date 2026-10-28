import { spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registryDirectory = process.env.PROPRIUM_AUTHORING_REGISTRY_DIR ?? process.env.PROPRIUM_SIGNED_AUTHORING_RELEASE_DIR;
// An explicit diagnostic-version trust root takes priority over the original
// signed-build public key. Both are independently signature-verified.
const registryPublicKey = process.env.PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY ??
  (process.env.PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY_FILE
    ? (await readFile(process.env.PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY_FILE, "utf8")).trim()
    : undefined) ??
  process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY ??
  (process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_KEY_FILE
    ? createPublicKey(await readFile(process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_KEY_FILE, "utf8")).export({ format: "der", type: "spki" }).subarray(-32).toString("base64") : undefined);
if (!registryDirectory) throw new Error("Set PROPRIUM_AUTHORING_REGISTRY_DIR to the actual independently built signed authoring registry directory.");
if (!registryPublicKey) throw new Error("Set PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY to the separately pinned Ed25519 public key; no test key will be generated.");

const environment = { ...process.env };
environment.PROPRIUM_PLUGIN_OUTPUT_DIR = resolve(registryDirectory);
environment.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY = registryPublicKey;
delete environment.PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY;
delete environment.PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY;
delete environment.PROPRIUM_E2E_TEST_FILE;
delete environment.SCRIPTORIUM_E2E_TEST_FILE;

const verified = spawnSync(process.execPath, [resolve(root, "scripts/verify-plugin-registry.mjs"), "authoring"], {
  cwd: root, env: environment, stdio: "inherit",
});
if (verified.error) throw verified.error;
if (verified.status !== 0) process.exit(verified.status ?? 1);

const registryBytes = await readFile(resolve(registryDirectory, "registry.json"));
const registry = JSON.parse(registryBytes.toString("utf8"));
const artifactBase = new URL(registry.artifactBase);
const port = environment.PROPRIUM_E2E_PORT ?? "4173";
const hostOrigin = `http://127.0.0.1:${port}`;
environment.PROPRIUM_E2E_PORT = port;
environment.VITE_PROPRIUM_E2E = "true";
environment.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `${hostOrigin}/plugin-fixture/registry.json`;
environment.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = registryPublicKey;
environment.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = artifactBase.origin;
environment.PROPRIUM_AUTHORING_REGISTRY_DIR = resolve(registryDirectory);
environment.PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY = registryPublicKey;

console.log(`Authoring E2E uses signed registry SHA-256 ${createHash("sha256").update(registryBytes).digest("hex")}.`);
console.log(`Pinned plugin artifact origin: ${artifactBase.origin}`);
console.log("No private registry or publisher signing key is passed to the browser process.");

const playwright = spawnSync("pnpm", ["exec", "playwright", "test", "--config", "tests/e2e/authoring-suite.playwright.config.ts",
  "--project=chromium", "--project=webkit-mobile", ...process.argv.slice(2)], {
  cwd: root, env: environment, stdio: "inherit",
});
if (playwright.error) throw playwright.error;
process.exit(playwright.status ?? 1);
