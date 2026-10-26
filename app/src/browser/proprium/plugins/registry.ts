import { PluginArtifactError, admitPluginManifest, type PluginManifest } from "../plugin-artifact.js";

export const PLUGIN_REGISTRY_SCHEMA = "proprium.registry/v1";
export const REGISTRY_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
const ASSET_PATH = /^[A-Za-z0-9._/-]+$/u;

export interface PluginDependency {
  readonly id: string;
  readonly range: string;
}

export interface PluginRegistryEntry {
  readonly id: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifestSignature: string;
  readonly publisherKey: string;
  readonly dependencies: readonly PluginDependency[];
}

export interface PluginRegistryDocument {
  readonly schema: typeof PLUGIN_REGISTRY_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly artifactBase: string;
  readonly plugins: readonly PluginRegistryEntry[];
}

export interface PluginRegistryTrust {
  /** Exact URL of the signed registry JSON, separately pinned by the Host. */
  readonly url: string;
  /** Raw, 32-byte Ed25519 key pinned outside the registry. */
  readonly publicKey: Uint8Array;
  /** Origins permitted by the Host for manifest and artifact fetches. */
  readonly artifactOrigins: readonly string[];
}

export interface SignedRegistrySnapshot {
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly digest: string;
  readonly document: PluginRegistryDocument;
}

export class PluginRegistryError extends Error {
  constructor(readonly code: "untrusted_registry" | "invalid_registry" | "invalid_signature" | "network_error" | "dependency_error", message: string) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

function fail(code: PluginRegistryError["code"], message: string): never {
  throw new PluginRegistryError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64(value: unknown, expectedBytes: number, field: string): Uint8Array {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return fail("invalid_registry", `${field} must be base64`);
  }
  let decoded: Uint8Array;
  try { decoded = Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
  catch { return fail("invalid_registry", `${field} must be base64`); }
  if (decoded.byteLength !== expectedBytes) return fail("invalid_registry", `${field} has an invalid byte length`);
  return decoded;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateTrust(trust: PluginRegistryTrust): URL {
  let url: URL;
  try { url = new URL(trust.url); } catch { return fail("untrusted_registry", "Pinned registry URL must be absolute"); }
  if (url.href !== trust.url || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    return fail("untrusted_registry", "Pinned registry URL must be an exact HTTPS URL");
  }
  if (!(trust.publicKey instanceof Uint8Array) || trust.publicKey.byteLength !== 32) {
    return fail("untrusted_registry", "A pinned 32-byte Ed25519 registry key is required");
  }
  if (!Array.isArray(trust.artifactOrigins) || trust.artifactOrigins.length === 0) {
    return fail("untrusted_registry", "At least one Host-approved artifact origin is required");
  }
  return url;
}

export function registryDirectory(registryUrl: string): URL {
  const url = new URL(registryUrl);
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  url.search = "";
  url.hash = "";
  return url;
}

export function assertApprovedOrigin(origin: string, trust: PluginRegistryTrust): void {
  let url: URL;
  try { url = new URL(origin); } catch { return fail("invalid_registry", "Artifact origin is invalid"); }
  if (url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      !trust.artifactOrigins.includes(url.origin)) {
    return fail("untrusted_registry", `Host has not approved artifact origin ${url.origin}`);
  }
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && ASSET_PATH.test(value) &&
    !value.startsWith("/") && value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function validRange(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  if (value === "*") return true;
  const match = /^(\^|~)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  return match !== null && SEMVER.test(`${match[2]}${match[4] ? `-${match[4]}` : ""}`);
}

function parseDocument(raw: Uint8Array, artifactBase: string, trust: PluginRegistryTrust): PluginRegistryDocument {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown; }
  catch { return fail("invalid_registry", "Registry must contain valid UTF-8 JSON"); }
  if (!isRecord(value) || Object.keys(value).length !== 5 || value.schema !== PLUGIN_REGISTRY_SCHEMA ||
      typeof value.id !== "string" || !IDENTIFIER.test(value.id) || typeof value.version !== "string" || !SEMVER.test(value.version) ||
      value.artifactBase !== artifactBase || !Array.isArray(value.plugins) || value.plugins.length > 4096) {
    return fail("invalid_registry", "Registry document is malformed");
  }
  const base = new URL(artifactBase);
  if (base.href !== artifactBase || !base.pathname.endsWith("/") || base.search || base.hash) fail("invalid_registry", "Registry artifactBase must be a directory URL");
  assertApprovedOrigin(base.origin, trust);
  const entries: PluginRegistryEntry[] = [];
  const versions = new Set<string>();
  for (const item of value.plugins) {
    if (!isRecord(item) || Object.keys(item).length !== 7 || typeof item.id !== "string" || !IDENTIFIER.test(item.id) ||
        typeof item.version !== "string" || !SEMVER.test(item.version) || !safeRelativePath(item.manifestPath) ||
        typeof item.manifestSha256 !== "string" || !SHA256.test(item.manifestSha256) ||
        typeof item.manifestSignature !== "string" || typeof item.publisherKey !== "string" || !Array.isArray(item.dependencies) || item.dependencies.length > 128) {
      return fail("invalid_registry", "Registry plugin entry is malformed");
    }
    const key = `${item.id}@${item.version}`;
    if (versions.has(key)) fail("invalid_registry", `Registry repeats plugin version ${key}`);
    versions.add(key);
    if (!item.manifestPath.includes(`/manifest/${item.manifestSha256}.json`)) fail("invalid_registry", `Manifest path is not content-addressed for ${key}`);
    decodeBase64(item.manifestSignature, 64, "manifestSignature");
    decodeBase64(item.publisherKey, 32, "publisherKey");
    const dependencies: PluginDependency[] = [];
    const seenDependencies = new Set<string>();
    for (const dependency of item.dependencies) {
      if (!isRecord(dependency) || Object.keys(dependency).length !== 2 || typeof dependency.id !== "string" || !IDENTIFIER.test(dependency.id) || !validRange(dependency.range)) {
        return fail("invalid_registry", "Registry dependency is malformed");
      }
      if (dependency.id === item.id || seenDependencies.has(dependency.id)) fail("invalid_registry", "A plugin cannot depend on itself or repeat a dependency");
      seenDependencies.add(dependency.id);
      dependencies.push(Object.freeze({ id: dependency.id, range: dependency.range }));
    }
    entries.push(Object.freeze({
      id: item.id, version: item.version, manifestPath: item.manifestPath,
      manifestSha256: item.manifestSha256, manifestSignature: item.manifestSignature,
      publisherKey: item.publisherKey, dependencies: Object.freeze(dependencies),
    }));
  }
  return Object.freeze({ schema: PLUGIN_REGISTRY_SCHEMA, id: value.id, version: value.version, artifactBase, plugins: Object.freeze(entries) });
}

export async function admitRegistry(raw: Uint8Array, signature: Uint8Array, trust: PluginRegistryTrust): Promise<SignedRegistrySnapshot> {
  validateTrust(trust);
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > REGISTRY_MAX_BYTES) fail("invalid_registry", "Registry size is invalid");
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) fail("invalid_signature", "Registry signature must be 64 bytes");
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(trust.publicKey), { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, Uint8Array.from(signature), Uint8Array.from(raw));
  } catch { fail("invalid_signature", "Ed25519 registry signature verification is unavailable or failed"); }
  if (!valid) fail("invalid_signature", "Registry signature does not match the pinned key");
  const digest = await sha256(raw);
  let artifactBase: unknown;
  try { artifactBase = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown>).artifactBase; }
  catch { fail("invalid_registry", "Registry must contain valid UTF-8 JSON"); }
  if (typeof artifactBase !== "string") fail("invalid_registry", "Registry artifactBase is required");
  const document = parseDocument(raw, artifactBase, trust);
  return Object.freeze({ url: trust.url, bytes: Uint8Array.from(raw), signature: Uint8Array.from(signature), digest, document });
}

export function manifestBytesLimit(): number { return MANIFEST_MAX_BYTES; }
export function registrySignatureUrl(registryUrl: string): string { return `${registryUrl}.sig`; }
export function registryArtifactURL(path: string, registry: SignedRegistrySnapshot, trust: PluginRegistryTrust): URL {
  if (!safeRelativePath(path)) fail("invalid_registry", "Registry asset path must be relative and traversal-free");
  const url = new URL(path, registry.document.artifactBase);
  assertApprovedOrigin(url.origin, trust);
  return url;
}
export function registryManifestEntry(registry: SignedRegistrySnapshot, id: string, version: string): PluginRegistryEntry | undefined {
  return registry.document.plugins.find(entry => entry.id === id && entry.version === version);
}

export async function admitRegistryManifest(
  bytes: Uint8Array,
  entry: PluginRegistryEntry,
): Promise<PluginManifest> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MANIFEST_MAX_BYTES || await sha256(bytes) !== entry.manifestSha256) {
    throw new PluginArtifactError("digest_mismatch", "Plugin manifest differs from its signed registry entry");
  }
  const manifest = await admitPluginManifest(bytes, {
    expectedPluginId: entry.id,
    expectedSha256: entry.manifestSha256,
    trustedPublisherKey: decodeBase64(entry.publisherKey, 32, "publisherKey"),
    signature: decodeBase64(entry.manifestSignature, 64, "manifestSignature"),
  });
  if (manifest.version !== entry.version) throw new PluginArtifactError("invalid_manifest", "Manifest version differs from its signed registry entry");
  if (manifest.artifacts.some(artifact => !artifact.path.includes(`/${artifact.sha256}/`))) {
    throw new PluginArtifactError("invalid_manifest", "Every immutable plugin asset path must include its SHA-256 digest");
  }
  return manifest;
}

export function decodeRegistryBytes(value: string, expectedBytes: number, field: string): Uint8Array {
  return decodeBase64(value, expectedBytes, field);
}

interface VersionParts { major: number; minor: number; patch: number; prerelease: string | undefined; }
function parseVersion(version: string): VersionParts | undefined {
  const match = SEMVER.exec(version);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] } : undefined;
}
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  const x = a.prerelease.split("."); const y = b.prerelease.split(".");
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1;
    if (y[index] === undefined) return 1;
    if (x[index] === y[index]) continue;
    const xn = /^(0|[1-9]\d*)$/u.test(x[index]!); const yn = /^(0|[1-9]\d*)$/u.test(y[index]!);
    if (xn && yn) return Number(x[index]) < Number(y[index]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[index]! < y[index]! ? -1 : 1;
  }
  return 0;
}
export function satisfiesVersion(version: string, range: string): boolean {
  if (!parseVersion(version) || !validRange(range)) return false;
  if (range === "*") return true;
  const match = /^(\^|~)?(.+)$/u.exec(range)!;
  const operator = match[1]; const base = match[2]!;
  if (!operator) return version === base;
  const actual = parseVersion(version)!; const expected = parseVersion(base)!;
  if (actual.prerelease !== undefined && (expected.prerelease === undefined ||
      actual.major !== expected.major || actual.minor !== expected.minor || actual.patch !== expected.patch)) return false;
  if (compareVersions(version, base) < 0) return false;
  if (operator === "~") return actual.major === expected.major && actual.minor === expected.minor;
  if (expected.major > 0) return actual.major === expected.major;
  if (expected.minor > 0) return actual.major === 0 && actual.minor === expected.minor;
  return actual.major === 0 && actual.minor === 0 && actual.patch === expected.patch;
}
