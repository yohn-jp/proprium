import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Signs the actual built Narrative artifacts with test-only publisher and registry keys.
export default async function setup(): Promise<() => void> {
  const source = process.env.PROPRIUM_NARRATIVE_FAST;
  const manifestPath = process.env.PROPRIUM_NARRATIVE_MANIFEST;
  if (!source && !manifestPath) {
    const official = await import("./authoring-official.setup.js");
    return official.default();
  }
  const registryKey = process.env.PROPRIUM_E2E_PLUGIN_REGISTRY_PRIVATE_KEY;
  const origin = process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS;
  if (!source || !manifestPath || !registryKey || !origin) throw new Error("Provide PROPRIUM_NARRATIVE_FAST and PROPRIUM_NARRATIVE_MANIFEST for the signed official Narrative build.");
  const directory = mkdtempSync(join(tmpdir(), "proprium-mcp-registry-"));
  const signer = createPrivateKey(registryKey);
  const publisher = generateKeyPairSync("ed25519").privateKey;
  cpSync(join(source, "proprium/narrative"), join(directory, "proprium/narrative"), { recursive:true });
  const manifest = readFileSync(join(directory, manifestPath));
  const registry = Buffer.from(JSON.stringify({
    schema:"proprium.registry/v1", id:"fixture.registry", version:"1.0.0",
    artifactBase:`${origin}/plugin-fixture/`, plugins:[{
      id:"proprium.narrative", version:"0.1.0", manifestPath,
      manifestSha256:createHash("sha256").update(manifest).digest("hex"),
      manifestSignature:sign(null, manifest, publisher).toString("base64"),
      publisherKey:createPublicKey(publisher).export({ format:"der", type:"spki" }).subarray(-32).toString("base64"),
      dependencies:[],
    }],
  }));
  writeFileSync(join(directory, "registry.json"), registry);
  writeFileSync(join(directory, "registry.json.sig"), sign(null, registry, signer));
  process.env.PROPRIUM_OFFICIAL_E2E_DIR = directory;
  return () => rmSync(directory, { recursive:true, force:true });
}
