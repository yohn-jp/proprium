import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBoundedResponse } from "./fetch-bounded-response.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist/previous-plugin-registry");
const releaseMode = process.env.PROPRIUM_PLUGIN_RELEASE_MODE;
const artifactBaseText = process.env.PROPRIUM_PLUGIN_ARTIFACT_BASE ?? "";
const hostOrigin = process.env.PROPRIUM_HOST_ORIGIN ?? "";
const publicKeyText = process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY ?? "";
if (!["bootstrap", "update"].includes(releaseMode)) throw new Error("Select registry release mode `bootstrap` or `update`");
const artifactBase = new URL(artifactBaseText);
if (artifactBase.protocol !== "https:" || artifactBase.username || artifactBase.password || artifactBase.search ||
    artifactBase.hash || !artifactBase.pathname.endsWith("/plugins/")) {
  throw new Error("PROPRIUM_PLUGIN_ARTIFACT_BASE must be a public HTTPS directory ending in /plugins/");
}
const host = new URL(hostOrigin);
if (host.protocol !== "https:" || host.origin !== hostOrigin || host.pathname !== "/" || host.username || host.password) {
  throw new Error("PROPRIUM_HOST_ORIGIN must be an exact HTTPS origin");
}
if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(publicKeyText)) throw new Error("A pinned base64 registry verification key is required");
const publicKeyBytes = Buffer.from(publicKeyText, "base64");
if (publicKeyBytes.byteLength !== 32 || publicKeyBytes.toString("base64") !== publicKeyText) {
  throw new Error("The pinned registry key must be canonical base64 for a 32-byte Ed25519 public key");
}
const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKeyBytes]),
  format: "der", type: "spki",
});
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const MAX_ASSET_BYTES = 128 * 1024 * 1024;

function safePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      !/^[A-Za-z0-9._/-]+$/u.test(path) || path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe previous registry artifact path: ${path}`);
  }
  const full = resolve(output, ...path.split("/"));
  const back = relative(output, full);
  if (back === ".." || back.startsWith(`..${sep}`) || back.startsWith(sep)) throw new Error("Previous registry artifact escaped its output directory");
  return full;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function fetchObject(path, expectedType, { missing = false, maxAge = 60 } = {}) {
  safePath(path);
  const { response, bytes } = await fetchBoundedResponse(
    new URL(path, artifactBase),
    { headers: { Origin: hostOrigin }, cache: "no-store", credentials: "omit" },
    MAX_ASSET_BYTES,
    `Previous registry object ${path}`,
  );
  if (response.status === 404 && missing) return null;
  if (!response.ok) throw new Error(`Previous registry object ${path} returned HTTP ${response.status}`);
  if (response.headers.get("access-control-allow-origin") !== hostOrigin) throw new Error(`Previous registry object ${path} did not allow the Host origin`);
  if (response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff") throw new Error(`Previous registry object ${path} is missing nosniff`);
  const actualType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (actualType !== expectedType) throw new Error(`Previous registry object ${path} has unexpected Content-Type ${actualType ?? "(missing)"}`);
  const cache = response.headers.get("cache-control") ?? "";
  const age = Number(/(?:^|,)\s*max-age=(\d+)/iu.exec(cache)?.[1] ?? NaN);
  if (!Number.isFinite(age) || age > maxAge ||
      (maxAge === 60 && /\bimmutable\b/iu.test(cache)) ||
      (maxAge > 60 && (!/\bimmutable\b/iu.test(cache) || age < 31_536_000))) {
    throw new Error(`Previous registry object ${path} has unexpected Cache-Control: ${cache}`);
  }
  return bytes;
}

function store(path, bytes) {
  const file = safePath(path);
  return mkdir(resolve(file, ".."), { recursive: true }).then(() => writeFile(file, bytes));
}

const registryBytes = await fetchObject("registry.json", "application/json", { missing: true });
const signatureBytes = await fetchObject("registry.json.sig", "application/octet-stream", { missing: true });
if (registryBytes === null || signatureBytes === null) {
  if (registryBytes === null && signatureBytes === null && releaseMode === "bootstrap") {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) await writeFile(outputFile, "has_previous=false\n", { flag: "a" });
    console.info("The R2 origin has no previous registry; this is a verified first publication.");
    process.exit(0);
  }
  throw new Error("The current registry and signature sidecar must either both exist or both be absent during bootstrap");
}
if (releaseMode === "bootstrap") throw new Error("A signed registry already exists; select update mode instead of bootstrap");
if (signatureBytes.byteLength !== 64 || !verify(null, registryBytes, publicKey, signatureBytes)) {
  throw new Error("The previous registry signature does not match the pinned trust root");
}
const registry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(registryBytes));
if (registry.schema !== "proprium.registry/v1" || !Array.isArray(registry.plugins)) throw new Error("Unsupported previous registry schema");
if (registry.artifactBase !== artifactBaseText) throw new Error("Previous registry artifactBase differs from the configured R2 origin");

const downloaded = new Map();
for (const entry of registry.plugins) {
  const manifestBytes = await fetchObject(entry.manifestPath, "application/json", { maxAge: 31_536_000 });
  if (sha256(manifestBytes) !== entry.manifestSha256 || !entry.manifestPath.includes(`/manifest/${entry.manifestSha256}.json`)) {
    throw new Error(`Previous manifest digest or path is invalid for ${entry.id}@${entry.version}`);
  }
  const publisherKeyBytes = Buffer.from(entry.publisherKey, "base64");
  const manifestSignature = Buffer.from(entry.manifestSignature, "base64");
  if (publisherKeyBytes.byteLength !== 32 || manifestSignature.byteLength !== 64) throw new Error(`Invalid previous publisher proof for ${entry.id}@${entry.version}`);
  const publisherKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publisherKeyBytes]),
    format: "der", type: "spki",
  });
  if (!verify(null, manifestBytes, publisherKey, manifestSignature)) throw new Error(`Previous manifest signature failed for ${entry.id}@${entry.version}`);
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  if (manifest.id !== entry.id || manifest.version !== entry.version || !Array.isArray(manifest.artifacts)) {
    throw new Error(`Previous manifest identity mismatch for ${entry.id}@${entry.version}`);
  }
  downloaded.set(entry.manifestPath, manifestBytes);
  for (const artifact of manifest.artifacts) {
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > MAX_ASSET_BYTES ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !artifact.path.includes(`/${artifact.sha256}/`)) {
      throw new Error(`Invalid previous content-addressed artifact descriptor: ${artifact.path}`);
    }
    const mime = artifact.mediaType === "application/wasm" ? "application/wasm"
      : artifact.mediaType === "application/json" ? "application/json"
        : artifact.mediaType === "application/octet-stream" ? "application/octet-stream" : "";
    if (!mime) throw new Error(`Unsupported previous artifact MIME type: ${artifact.mediaType}`);
    const bytes = await fetchObject(artifact.path, mime, { maxAge: 31_536_000 });
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`Previous artifact digest failed: ${artifact.path}`);
    downloaded.set(artifact.path, bytes);
  }
}

for (const [path, bytes] of downloaded) await store(path, bytes);
await store("registry.json", registryBytes);
await store("registry.json.sig", signatureBytes);
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) await writeFile(outputFile, "has_previous=true\n", { flag: "a" });
console.info(`Verified and downloaded ${registry.plugins.length} previous signed plugin release(s) into ${output}`);
