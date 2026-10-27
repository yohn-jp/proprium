import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Build real official sources with a per-run test publisher and the Host's test trust root. */
export default async function setup(): Promise<() => void> {
  const directory = mkdtempSync(join(tmpdir(), "proprium-official-e2e-"));
  try {
    const signer = createPrivateKey(process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY!);
    const publisher = generateKeyPairSync("ed25519").privateKey;
    const publicKey = createPublicKey(signer).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const source = resolve(process.env.PROPRIUM_E2E_SOURCE ?? ".");
    execFileSync(process.execPath, [join(source, "scripts/build-plugin-registry.mjs"), "authoring"], {
      cwd: source, stdio: "inherit", env: { ...process.env,
        PROPRIUM_PLUGIN_REGISTRY_VERSION: "0.1.0",
        PROPRIUM_PLUGIN_ARTIFACT_BASE: `${process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS}/plugin-fixture/`,
        PROPRIUM_PLUGIN_OUTPUT_DIR: directory,
        PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR: directory,
        PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY: signer.export({ format: "pem", type: "pkcs8" }).toString(),
        PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY: publisher.export({ format: "pem", type: "pkcs8" }).toString(),
        PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: publicKey,
      },
    });
    process.env.PROPRIUM_OFFICIAL_E2E_DIR = directory;
    return () => { delete process.env.PROPRIUM_OFFICIAL_E2E_DIR; rmSync(directory, { recursive: true, force: true }); };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
