import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const pluginIds = [
  "proprium.narrative", "proprium.knowledge", "proprium.research", "proprium.paired-writing",
  "proprium.diagnostics", "proprium.speaker", "proprium.semantic", "proprium.publishing",
];
const pluginId = "proprium.diagnostics";
const actionId = "proprium.diagnostics.pages.read";
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * Build one signed synthetic eight-release registry per Playwright run. The
 * diagnostics entry contains the real continuation fixture; seven entries are
 * harmless stubs. This proves transport/admission only, not feature acceptance.
 */
export default async function setup(): Promise<() => void> {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "proprium-runtime-v2-fixture-"));
  const sourceDirectory = mkdtempSync(join(resolve("tests/fixtures/plugin-runtime-v2"), ".registry-source-"));
  try {
    const publisher = generateKeyPairSync("ed25519");
    const registrySigner = generateKeyPairSync("ed25519");
    const rawPublicKey = (key: typeof publisher.publicKey) => new Uint8Array(key.export({ format: "der", type: "spki" }).subarray(-32));
    const pinnedRegistryKey = base64(rawPublicKey(registrySigner.publicKey));
    const artifactBase = "http://127.0.0.1:4173/plugin-runtime-v2/";

    for (const id of pluginIds) {
      const slug = id.slice("proprium.".length);
      const pluginDirectory = join(sourceDirectory, slug);
      mkdirSync(pluginDirectory, { recursive: true });
      const isContinuationGuest = id === pluginId;
      const declaredAction = isContinuationGuest ? actionId : `${id}.runtime.probe`;
      const inputSchema = isContinuationGuest
        ? { type: "object", additionalProperties: false, required: ["prefix"], properties: {
          prefix: { type: "string", maxLength: 256 }, useAsset: { type: "boolean" },
        } }
        : { type: "object", additionalProperties: false };
      const capabilities = isContinuationGuest ? ["workspace.file.read", "workspace.asset.read"] : [];
      const action = {
        plugin_id: id, action_id: declaredAction, schema_version: 1, effect: "read",
        input_schema: inputSchema, output_schema: { type: "object", additionalProperties: false },
        required_capabilities: isContinuationGuest ? ["workspace.file.read"] : [],
        callers: ["ui"], requires_user_gesture: false,
      };
      writeFileSync(join(pluginDirectory, "plugin.json"), JSON.stringify({
        schema: "proprium.plugin/v2", id, version: "1.0.0", abi: "proprium.component/v2",
        capabilities, actions: [action], ui: [], asset_groups: [], dependencies: [],
      }));

      const sdkPath = relative(pluginDirectory, resolve("plugins/shared/guest.js")).split(sep).join("/");
      const sdkImport = sdkPath.startsWith(".") ? sdkPath : `./${sdkPath}`;
      const guestSource = isContinuationGuest
        ? readFileSync(resolve("tests/fixtures/plugin-runtime-v2/guest.ts"), "utf8")
          .replace('"../../../plugins/shared/guest.js"', JSON.stringify(sdkImport))
          .replaceAll("proprium.runtime-proof", pluginId)
        : `import { createGuest } from ${JSON.stringify(sdkImport)};\n` +
          `export const guest = createGuest(${JSON.stringify(id)}, { ${JSON.stringify(declaredAction)}: () => ({ synthetic: true }) });\n`;
      writeFileSync(join(pluginDirectory, "guest.ts"), guestSource);
    }

    const outputDirectory = join(fixtureDirectory, "registry");
    const builder = resolve(process.env.PROPRIUM_AUTHORING_BUILDER_SCRIPT ?? "scripts/build-plugin-registry.mjs");
    const environment = {
      ...process.env,
      PROPRIUM_PLUGIN_VERSION: "1.0.0",
      PROPRIUM_PLUGIN_REGISTRY_VERSION: "1.0.0",
      PROPRIUM_PLUGIN_ARTIFACT_BASE: artifactBase,
      PROPRIUM_PLUGIN_OUTPUT_DIR: outputDirectory,
      PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR: outputDirectory,
      PROPRIUM_AUTHORING_PLUGIN_SOURCE_DIR: sourceDirectory,
      PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY: registrySigner.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY: publisher.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: pinnedRegistryKey,
    };
    execFileSync(process.execPath, [builder, "authoring"], { cwd: resolve("."), env: environment, stdio: "pipe" });

    const registryBytes = readFileSync(join(outputDirectory, "registry.json"));
    const registry = JSON.parse(registryBytes.toString("utf8")) as {
      plugins: Array<{ id: string; version: string; manifestPath: string }>;
    };
    const release = registry.plugins.find(item => item.id === pluginId && item.version === "1.0.0");
    if (!release || registry.plugins.length !== pluginIds.length) throw new Error("Authoring builder did not sign the complete synthetic fixture registry");
    const manifestBytes = readFileSync(join(outputDirectory, release.manifestPath));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { entrypoint: string };
    const component = readFileSync(join(outputDirectory, manifest.entrypoint));
    writeFileSync(join(fixtureDirectory, "component.wasm"), component);
    writeFileSync(join(fixtureDirectory, "fixture.json"), JSON.stringify({
      registryBytes: base64(registryBytes),
      registrySignature: base64(readFileSync(join(outputDirectory, "registry.json.sig"))),
      manifestBytes: base64(manifestBytes),
      componentPath: manifest.entrypoint,
      pinnedRegistryKey,
    }));
    process.env.PROPRIUM_RUNTIME_V2_FIXTURE_DIR = fixtureDirectory;

    return () => {
      delete process.env.PROPRIUM_RUNTIME_V2_FIXTURE_DIR;
      rmSync(fixtureDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    };
  } catch (error) {
    rmSync(fixtureDirectory, { recursive: true, force: true });
    rmSync(sourceDirectory, { recursive: true, force: true });
    throw error;
  }
}
