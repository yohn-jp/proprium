import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist/plugin-registry");
const bucket = process.env.PROPRIUM_PLUGIN_R2_BUCKET ?? "";
const artifactBase = process.env.PROPRIUM_PLUGIN_ARTIFACT_BASE ?? "";
const hostOrigin = process.env.PROPRIUM_HOST_ORIGIN ?? "";
const stage = process.argv[2];

if (!["artifacts", "registry-signature", "registry-index"].includes(stage)) {
  throw new Error("Usage: node scripts/publish-plugin-registry.mjs <artifacts|registry-signature|registry-index>");
}
if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(bucket)) throw new Error("PROPRIUM_PLUGIN_R2_BUCKET is invalid");
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("Cloudflare API token and account ID are required for R2 publication");
}
const base = new URL(artifactBase);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
    !base.pathname.endsWith("/plugins/")) {
  throw new Error("PROPRIUM_PLUGIN_ARTIFACT_BASE must be a public HTTPS directory ending in /plugins/");
}
const host = new URL(hostOrigin);
if (host.origin !== hostOrigin || host.protocol !== "https:" || host.username || host.password || host.pathname !== "/") {
  throw new Error("PROPRIUM_HOST_ORIGIN must be an exact HTTPS origin");
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Registry output must not contain symlinks: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported registry output entry: ${entry.name}`);
  }
  return files.sort();
}
const paths = await filesUnder(output);
const registryPath = resolve(output, "registry.json");
const signaturePath = resolve(output, "registry.json.sig");
assert.ok(paths.includes(registryPath) && paths.includes(signaturePath), "Signed registry output is incomplete");

function relativeKey(path) {
  const key = relative(output, path).split(sep).join("/");
  if (!/^[A-Za-z0-9._/-]+$/u.test(key) || key.startsWith("/") || key.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe R2 object key: ${key}`);
  }
  return key;
}
function contentType(path) {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".sig")) return "application/octet-stream";
  throw new Error(`Unsupported plugin release media type: ${path}`);
}
function wranglerPut(path, mime, cacheControl) {
  const objectPath = `${bucket}/plugins/${path}`;
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
    "exec", "wrangler", "r2", "object", "put", objectPath,
    "--file", path,
    "--content-type", mime,
    "--cache-control", cacheControl,
    "--remote",
  ], { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler could not publish R2 object ${objectPath}`);
}
function cacheMaxAge(value) {
  return Number(/(?:^|,)\s*max-age=(\d+)/iu.exec(value)?.[1] ?? NaN);
}
async function verifyPublicObject(path, expected, immutable) {
  const response = await fetch(new URL(path, base), { headers: { Origin: hostOrigin }, cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(`Public artifact ${path} returned HTTP ${response.status}`);
  const actual = new Uint8Array(await response.arrayBuffer());
  if (sha256(actual) !== sha256(expected)) throw new Error(`Public artifact ${path} differs from the signed bytes`);
  if (response.headers.get("access-control-allow-origin") !== hostOrigin) throw new Error(`Public artifact ${path} did not allow the configured Host origin`);
  if (response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff") throw new Error(`Public artifact ${path} is missing X-Content-Type-Options: nosniff`);
  const actualType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (actualType !== contentType(path)) throw new Error(`Public artifact ${path} has Content-Type ${actualType ?? "(missing)"}`);
  const cache = response.headers.get("cache-control") ?? "";
  const age = cacheMaxAge(cache);
  if (immutable && (!/\bimmutable\b/iu.test(cache) || age < 31_536_000)) throw new Error(`Immutable artifact ${path} has unsafe Cache-Control: ${cache}`);
  if (!immutable && (!Number.isFinite(age) || age > 60)) throw new Error(`Mutable registry metadata ${path} must use Cache-Control max-age of 60 seconds or less`);
}

if (stage === "artifacts") {
  const immutableFiles = paths.filter(path => path !== registryPath && path !== signaturePath);
  if (immutableFiles.length === 0) throw new Error("No immutable plugin files were produced");
  for (const path of immutableFiles) {
    const key = relativeKey(path);
    if (!key.startsWith("proprium/")) throw new Error(`Unexpected artifact outside the plugin namespace: ${key}`);
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    if (!key.includes(digest)) throw new Error(`Immutable R2 key must contain its exact SHA-256 digest: ${key}`);
    wranglerPut(key, contentType(key), "public, max-age=31536000, immutable");
    await verifyPublicObject(key, bytes, true);
  }
  console.info(`Published and verified ${immutableFiles.length} immutable plugin object(s).`);
} else {
  const path = stage === "registry-signature" ? signaturePath : registryPath;
  const key = relativeKey(path);
  const bytes = await readFile(path);
  wranglerPut(key, contentType(key), "public, max-age=60, must-revalidate");
  await verifyPublicObject(key, bytes, false);
  console.info(`Published and verified signed registry metadata ${key}.`);
}
