import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'dist/plugin-registry');
const encodedRootKey = process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY;
if (!encodedRootKey || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedRootKey)) {
  throw new Error('Set PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY to the separately pinned raw Ed25519 public key (base64)');
}
const rawRootKey = Buffer.from(encodedRootKey, 'base64');
if (rawRootKey.byteLength !== 32) throw new Error('The pinned registry key must be 32 bytes');
const rootPublicKey = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawRootKey]),
  format: 'der', type: 'spki',
});
const readRelative = async path => {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
      !/^[A-Za-z0-9._/-]+$/u.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe plugin artifact path: ${path}`);
  }
  const resolved = resolve(output, ...path.split('/'));
  const rel = relative(output, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error('Artifact escaped registry output');
  return new Uint8Array(await readFile(resolved));
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const registryBytes = await readFile(resolve(output, 'registry.json'));
const registrySignature = await readFile(resolve(output, 'registry.json.sig'));
if (registrySignature.byteLength !== 64 || !verify(null, registryBytes, rootPublicKey, registrySignature)) {
  throw new Error('Registry signature does not match the separately pinned public key');
}
const registry = JSON.parse(registryBytes.toString('utf8'));
if (registry.schema !== 'proprium.registry/v1' || !Array.isArray(registry.plugins)) throw new Error('Unsupported registry document');
for (const entry of registry.plugins) {
  const manifestBytes = await readRelative(entry.manifestPath);
  if (sha256(manifestBytes) !== entry.manifestSha256) throw new Error(`Manifest digest mismatch for ${entry.id}@${entry.version}`);
  const publisherRawKey = Buffer.from(entry.publisherKey, 'base64');
  const manifestSignature = Buffer.from(entry.manifestSignature, 'base64');
  if (publisherRawKey.byteLength !== 32 || manifestSignature.byteLength !== 64) throw new Error(`Invalid publisher proof for ${entry.id}@${entry.version}`);
  const publisherKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publisherRawKey]),
    format: 'der', type: 'spki',
  });
  if (!verify(null, manifestBytes, publisherKey, manifestSignature)) throw new Error(`Manifest signature mismatch for ${entry.id}@${entry.version}`);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  if (manifest.id !== entry.id || manifest.version !== entry.version || !Array.isArray(manifest.artifacts)) {
    throw new Error(`Manifest identity mismatch for ${entry.id}@${entry.version}`);
  }
  if (!entry.manifestPath.includes(`/manifest/${entry.manifestSha256}.json`)) throw new Error(`Manifest path is not content-addressed: ${entry.manifestPath}`);
  for (const artifact of manifest.artifacts) {
    const bytes = await readRelative(artifact.path);
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`Artifact digest mismatch: ${artifact.path}`);
    if (!artifact.path.includes(`/${artifact.sha256}/`)) throw new Error(`Artifact path is not content-addressed: ${artifact.path}`);
  }
}
console.log(`Verified ${registry.plugins.length} signed plugin release(s) in ${output}`);
