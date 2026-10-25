import { createHash, createPrivateKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";

export interface StaticPluginFile {
  readonly body: Buffer;
  readonly contentType: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: "der", type: "spki" }).subarray(-32);
}

/** Signs a real component fixture with the per-run key pinned in this static test build. */
export function signedStaticPluginFixture(origin: string, component: Uint8Array): Map<string, StaticPluginFile> {
  const registryUrl = new URL("/plugin-fixture/registry.json", origin).href;
  const artifactBase = new URL("/plugin-fixture/artifacts/", origin).href;
  const privateKeyPem = process.env.PROPRIUM_E2E_STATIC_PLUGIN_REGISTRY_PRIVATE_KEY;
  if (!privateKeyPem) throw new Error("The static Playwright config did not provide its one-run registry signing key.");

  const pluginId = "fixture.compute-sum";
  const version = "1.0.0";
  const publisher = generateKeyPairSync("ed25519");
  const artifactBytes = Buffer.from(component);
  const artifactSha = sha256(artifactBytes);
  const assetPath = `${pluginId}/${version}/${artifactSha}/plugin.component.wasm`;
  const manifestBytes = Buffer.from(JSON.stringify({
    schema: "proprium.plugin/v1",
    id: pluginId,
    version,
    abi: "proprium.component/v1",
    entrypoint: assetPath,
    capabilities: [],
    artifacts: [{ path: assetPath, bytes: artifactBytes.byteLength, sha256: artifactSha, mediaType: "application/wasm" }],
  }), "utf8");
  const manifestSha = sha256(manifestBytes);
  const manifestPath = `${pluginId}/${version}/manifest/${manifestSha}.json`;
  const registrySigner = createPrivateKey(privateKeyPem);
  const registryBytes = Buffer.from(JSON.stringify({
    schema: "proprium.registry/v1",
    id: "proprium.static-fixture",
    version: "1.0.0",
    artifactBase,
    plugins: [{
      id: pluginId,
      version,
      manifestPath,
      manifestSha256: manifestSha,
      manifestSignature: ed25519Sign(null, manifestBytes, publisher.privateKey).toString("base64"),
      publisherKey: rawPublicKey(publisher.publicKey).toString("base64"),
      dependencies: [],
    }],
  }), "utf8");
  const registrySignature = ed25519Sign(null, registryBytes, registrySigner);
  const files = new Map<string, StaticPluginFile>();
  files.set(new URL(registryUrl).pathname, { body: registryBytes, contentType: "application/json" });
  files.set(`${new URL(registryUrl).pathname}.sig`, { body: registrySignature, contentType: "application/octet-stream" });
  files.set(new URL(manifestPath, artifactBase).pathname, { body: manifestBytes, contentType: "application/json" });
  files.set(new URL(assetPath, artifactBase).pathname, { body: artifactBytes, contentType: "application/wasm" });
  return files;
}

export const staticPluginId = "fixture.compute-sum";
export const staticPluginVersion = "1.0.0";
