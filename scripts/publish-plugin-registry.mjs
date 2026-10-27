import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchBoundedResponse } from "./fetch-bounded-response.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist/plugin-registry");
const bucket = process.env.PROPRIUM_PLUGIN_R2_BUCKET ?? "";
const artifactBase = process.env.PROPRIUM_PLUGIN_ARTIFACT_BASE ?? "";
const hostOrigin = process.env.PROPRIUM_HOST_ORIGIN ?? "";
const stage = process.argv[2];
const planning = process.argv[3] === "--plan";

if (!["artifacts", "registry-signature", "registry-index"].includes(stage)) {
  throw new Error("Usage: node scripts/publish-plugin-registry.mjs <artifacts|registry-signature|registry-index> [--plan]");
}
if (process.argv.length > (planning ? 4 : 3)) throw new Error("Unexpected plugin publication command-line argument");
if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(bucket)) throw new Error("PROPRIUM_PLUGIN_R2_BUCKET is invalid");
if (!planning && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
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
  if (path.includes("/chunks/")) return "application/octet-stream";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".sig")) return "application/octet-stream";
  return "application/octet-stream";
}
function sourceFileForKey(key) {
  const sourceFile = resolve(output, ...key.split("/"));
  const back = relative(output, sourceFile);
  if (back === ".." || back.startsWith(`..${sep}`) || back.startsWith(sep)) {
    throw new Error(`Local plugin artifact escaped the build output: ${key}`);
  }
  return sourceFile;
}
function wranglerPut(sourceFile, objectPath, mime, cacheControl) {
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
    "exec", "wrangler", "r2", "object", "put", objectPath,
    "--file", sourceFile,
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
  const { response, bytes: actual } = await fetchBoundedResponse(
    new URL(path, base), { headers: { Origin: hostOrigin }, cache: "no-store", credentials: "omit" }, expected.byteLength, `Public artifact ${path}`,
  );
  if (!response.ok) throw new Error(`Public artifact ${path} returned HTTP ${response.status}`);
  if (sha256(actual) !== sha256(expected)) throw new Error(`Public artifact ${path} differs from the signed bytes`);
  if (response.headers.get("access-control-allow-origin") !== hostOrigin) throw new Error(`Public artifact ${path} did not allow the configured Host origin`);
  if (response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff") throw new Error(`Public artifact ${path} is missing X-Content-Type-Options: nosniff`);
  const actualType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (actualType !== contentType(path)) throw new Error(`Public artifact ${path} has Content-Type ${actualType ?? "(missing)"}`);
  const cache = response.headers.get("cache-control") ?? "";
  const age = cacheMaxAge(cache);
  if (immutable && (!/\bimmutable\b/iu.test(cache) || !Number.isFinite(age) || age < 31_536_000)) throw new Error(`Immutable artifact ${path} has unsafe Cache-Control: ${cache}`);
  if (!immutable && (!Number.isFinite(age) || age > 60)) throw new Error(`Mutable registry metadata ${path} must use Cache-Control max-age of 60 seconds or less`);
}

const uploads = [];
if (stage === "artifacts") {
  const immutableFiles = paths.filter(path => path !== registryPath && path !== signaturePath);
  if (immutableFiles.length === 0) throw new Error("No immutable plugin files were produced");
  for (const path of immutableFiles) {
    const key = relativeKey(path);
    if (!key.startsWith("proprium/")) throw new Error(`Unexpected artifact outside the plugin namespace: ${key}`);
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    if (!key.includes(digest)) throw new Error(`Immutable R2 key must contain its exact SHA-256 digest: ${key}`);
    uploads.push({
      key,
      sourceFile: sourceFileForKey(key),
      contentType: contentType(key),
      cacheControl: "public, max-age=31536000, immutable",
      immutable: true,
      sha256: digest,
      bytes: bytes.byteLength,
    });
  }
} else {
  const path = stage === "registry-signature" ? signaturePath : registryPath;
  const key = relativeKey(path);
  const bytes = await readFile(path);
  uploads.push({
    key,
    sourceFile: sourceFileForKey(key),
    contentType: contentType(key),
    cacheControl: "public, max-age=60, must-revalidate",
    immutable: false,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  });
}

if (planning) {
  console.log(JSON.stringify({
    mode: "plan-only",
    stage,
    uploads: uploads.map(upload => ({
      localFile: upload.sourceFile,
      objectKey: `${bucket}/plugins/${upload.key}`,
      contentType: upload.contentType,
      cacheControl: upload.cacheControl,
      sha256: upload.sha256,
      bytes: upload.bytes,
    })),
  }, null, 2));
  process.exit(0);
}

for (const upload of uploads) {
  const bytes = await readFile(upload.sourceFile);
  if (bytes.byteLength !== upload.bytes || sha256(bytes) !== upload.sha256) {
    throw new Error(`Local plugin artifact changed while preparing upload: ${upload.key}`);
  }
  const objectPath = `${bucket}/plugins/${upload.key}`;
  wranglerPut(upload.sourceFile, objectPath, upload.contentType, upload.cacheControl);
  await verifyPublicObject(upload.key, bytes, upload.immutable);
}
if (stage === "artifacts") console.info(`Published and verified ${uploads.length} immutable plugin object(s).`);
else console.info(`Published and verified signed registry metadata ${uploads[0].key}.`);
