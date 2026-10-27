import { verifyEd25519 } from "./ed25519.js";
import { assertDescriptor, assertSurface } from "./authoring/schema.js";
import type { ActionDescriptor, SurfaceDeclaration } from "./authoring/types.js";

/** Host-side admission of signed WASM plugin manifests and immutable assets.
 * Pure browser code: no network requests, runtime installs or guest execution.
 */
export interface ArtifactDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mediaType: "application/wasm" | "application/octet-stream" | "application/json";
}
export interface PluginManifestV1 {
  readonly schema: "proprium.plugin/v1";
  readonly id: string;
  readonly version: string;
  readonly abi: "proprium.component/v1";
  readonly entrypoint: string;
  readonly capabilities: readonly string[];
  readonly artifacts: readonly ArtifactDescriptor[];
}
export interface AssetGroupRef {
  readonly id: string;
  readonly manifest_path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly role: "dictionary" | "embedding" | "reranker";
}
export interface PluginManifestV2 extends Omit<PluginManifestV1, "schema" | "abi"> {
  readonly schema: "proprium.plugin/v2";
  readonly abi: "proprium.component/v2";
  readonly actions: readonly ActionDescriptor[];
  readonly ui: readonly SurfaceDeclaration[];
  readonly asset_groups: readonly AssetGroupRef[];
}
export type PluginManifest = PluginManifestV1 | PluginManifestV2;
const verified = new WeakSet<object>();
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const CAPABILITY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const PATH = /^[a-zA-Z0-9._/-]+$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export class PluginArtifactError extends Error {
  readonly code: "invalid_manifest" | "untrusted_publisher" | "invalid_signature" | "digest_mismatch" | "invalid_artifact";
  constructor(code: PluginArtifactError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PluginArtifactError";
  }
}
function fail(code: PluginArtifactError["code"], detail: string): never {
  throw new PluginArtifactError(code, detail);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_manifest", "Manifest entry must be an object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function safeAssetPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 256 && PATH.test(path) &&
    !path.startsWith("/") && path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
function parseManifest(raw: Uint8Array): PluginManifest {
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown);
  } catch {
    return fail("invalid_manifest", "Manifest must contain valid UTF-8 JSON");
  }
  if (value.schema === "proprium.plugin/v2") {
    if (!exactKeys(value, ["schema", "id", "version", "abi", "entrypoint", "capabilities", "artifacts", "actions", "ui", "asset_groups"]) ||
        value.abi !== "proprium.component/v2" || !Array.isArray(value.actions) || value.actions.length > 256 ||
        !Array.isArray(value.ui) || value.ui.length > 128 || !Array.isArray(value.asset_groups) || value.asset_groups.length > 32) {
      return fail("invalid_manifest", "Malformed v2 authoring manifest");
    }
    const base = parseManifest(new TextEncoder().encode(JSON.stringify({
      schema: "proprium.plugin/v1", id: value.id, version: value.version, abi: "proprium.component/v1",
      entrypoint: value.entrypoint, capabilities: value.capabilities, artifacts: value.artifacts,
    })));
    const actions = new Set<string>();
    const surfaces = new Set<string>();
    try {
      for (const action of value.actions) {
        assertDescriptor(action);
        if (action.plugin_id !== base.id || actions.has(action.action_id) ||
            action.required_capabilities.some(capability => !base.capabilities.includes(capability))) {
          return fail("invalid_manifest", "Action identity/capabilities differ from signed manifest");
        }
        actions.add(action.action_id);
      }
      for (const surface of value.ui) {
        assertSurface(surface);
        const id = (surface as SurfaceDeclaration).id;
        if (surfaces.has(id)) return fail("invalid_manifest", "Duplicate surface ID");
        surfaces.add(id);
        const validateBindings = (node: unknown): void => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) { node.forEach(validateBindings); return; }
          const item = node as Record<string, unknown>;
          if (typeof item.action_id === "string" && !actions.has(item.action_id)) {
            fail("invalid_manifest", "UI binds an undeclared action");
          }
          Object.values(item).forEach(validateBindings);
        };
        validateBindings(surface);
      }
    } catch (error) {
      if (error instanceof PluginArtifactError) throw error;
      return fail("invalid_manifest", "Authoring action or surface does not match the adopted schema");
    }
    const groups: AssetGroupRef[] = [];
    for (const rawGroup of value.asset_groups) {
      const group = record(rawGroup);
      if (!exactKeys(group, ["id", "manifest_path", "sha256", "bytes", "role"]) ||
          typeof group.id !== "string" || !group.id.length || group.id.length > 128 || groups.some(other => other.id === group.id) ||
          !safeAssetPath(group.manifest_path) || typeof group.sha256 !== "string" || !SHA256.test(group.sha256) ||
          !Number.isSafeInteger(group.bytes) || (group.bytes as number) < 1 || (group.bytes as number) > 512 * 1024 ||
          !["dictionary", "embedding", "reranker"].includes(group.role as string)) {
        return fail("invalid_manifest", "Invalid signed asset group reference");
      }
      groups.push(group as unknown as AssetGroupRef);
    }
    return freezeTree({ ...base, schema: "proprium.plugin/v2", abi: "proprium.component/v2",
      actions: value.actions as ActionDescriptor[], ui: value.ui as SurfaceDeclaration[], asset_groups: groups });
  }
  if (raw.length > MAX_MANIFEST_BYTES) return fail("invalid_manifest", "V1 manifest exceeds its byte ceiling");
  if (!exactKeys(value, ["schema", "id", "version", "abi", "entrypoint", "capabilities", "artifacts"]) ||
      value.schema !== "proprium.plugin/v1" || typeof value.id !== "string" || !IDENTIFIER.test(value.id) ||
      typeof value.version !== "string" || !VERSION.test(value.version) || value.abi !== "proprium.component/v1" ||
      !safeAssetPath(value.entrypoint) || !Array.isArray(value.capabilities) || !Array.isArray(value.artifacts)) {
    return fail("invalid_manifest", "Unsupported or malformed plugin manifest");
  }
  const capabilities: string[] = [];
  for (const capability of value.capabilities) {
    if (typeof capability !== "string" || !CAPABILITY.test(capability) || capabilities.includes(capability)) {
      return fail("invalid_manifest", "Invalid or duplicate capability");
    }
    capabilities.push(capability);
  }
  if (value.artifacts.length === 0 || value.artifacts.length > 256) fail("invalid_manifest", "Invalid artifact count");
  const artifacts: ArtifactDescriptor[] = [];
  let total = 0;
  for (const rawArtifact of value.artifacts) {
    const artifact = record(rawArtifact);
    if (!exactKeys(artifact, ["path", "bytes", "sha256", "mediaType"]) || !safeAssetPath(artifact.path) ||
        !Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) < 1 || (artifact.bytes as number) > MAX_ASSET_BYTES ||
        typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256) ||
        !["application/wasm", "application/json", "application/octet-stream"].includes(artifact.mediaType as string) ||
        artifacts.some(item => item.path === artifact.path)) {
      return fail("invalid_manifest", "Invalid, duplicate or excessive artifact");
    }
    total += artifact.bytes as number;
    if (total > MAX_BUNDLE_BYTES) fail("invalid_manifest", "Artifact aggregate exceeds admission cap");
    artifacts.push(Object.freeze({ path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256, mediaType: artifact.mediaType }) as ArtifactDescriptor);
  }
  if (!artifacts.some(artifact => artifact.path === value.entrypoint && artifact.mediaType === "application/wasm")) {
    fail("invalid_manifest", "Entrypoint must refer to an admitted WASM artifact");
  }
  return Object.freeze({
    schema: "proprium.plugin/v1", id: value.id, version: value.version, abi: "proprium.component/v1",
    entrypoint: value.entrypoint, capabilities: Object.freeze(capabilities), artifacts: Object.freeze(artifacts),
  });
}
function bytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(input);
}
async function digest(input: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(input)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}
export interface ManifestAdmission {
  readonly expectedPluginId: string;
  readonly expectedSha256: string;
  /** Host-pinned Ed25519 raw public key, never taken from an untrusted manifest. */
  readonly trustedPublisherKey: Uint8Array;
  /** Detached Ed25519 signature over the exact UTF-8 manifest bytes. */
  readonly signature: Uint8Array;
}
/** Verify pinned publisher identity, byte digest, signature and schema. */
export async function admitPluginManifest(raw: Uint8Array, policy: ManifestAdmission): Promise<PluginManifest> {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 512 * 1024 ||
      typeof policy.expectedSha256 !== "string" || !SHA256.test(policy.expectedSha256)) {
    return fail("invalid_manifest", "Manifest bytes or expected digest are invalid");
  }
  if (typeof policy.expectedPluginId !== "string" || !IDENTIFIER.test(policy.expectedPluginId) ||
      !(policy.trustedPublisherKey instanceof Uint8Array) || policy.trustedPublisherKey.byteLength !== 32) {
    return fail("untrusted_publisher", "A pinned publisher identity and Ed25519 key are required");
  }
  if (!(policy.signature instanceof Uint8Array) || policy.signature.byteLength !== 64) {
    return fail("invalid_signature", "Detached Ed25519 signature is missing or malformed");
  }
  if (await digest(raw) !== policy.expectedSha256) fail("digest_mismatch", "Manifest digest differs from pinned value");
  let valid = false;
  try {
    valid = verifyEd25519(raw, policy.signature, policy.trustedPublisherKey);
  } catch {
    return fail("invalid_signature", "Ed25519 verification is unavailable or failed");
  }
  if (!valid) fail("invalid_signature", "Manifest is not signed by the trusted publisher key");
  const manifest = parseManifest(raw);
  if (manifest.id !== policy.expectedPluginId) fail("untrusted_publisher", "Manifest identity differs from pinned publisher");
  verified.add(manifest);
  return manifest;
}
/** Check one downloaded artifact before caching or instantiation. */
export async function verifyPluginArtifact(manifest: PluginManifest, path: string, content: Uint8Array): Promise<void> {
  if (!verified.has(manifest)) fail("untrusted_publisher", "Manifest has not completed publisher admission");
  const descriptor = manifest.artifacts.find(item => item.path === path);
  if (!descriptor || !(content instanceof Uint8Array) || content.byteLength !== descriptor.bytes) {
    fail("invalid_artifact", "Artifact missing or unexpected byte length");
  }
  if (await digest(content) !== descriptor.sha256) fail("digest_mismatch", "Artifact content does not match verified manifest");
}
