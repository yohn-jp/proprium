// Diagnostic lifecycle fixture: retain verified real component bytes while signing
// current declarations and synthetic patch versions with ephemeral test keys.
// Usage: node scripts/test-authoring-version-fixture.mjs <verified-registry-dir> <new-output-dir>
// Set PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY to the independently pinned source key.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.length !== 4 || !process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY) {
  throw new Error('Usage: PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY=<source-key> node scripts/test-authoring-version-fixture.mjs <verified-registry-dir> <new-output-dir>');
}
const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const inside = relative(source, output);
if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..' && !inside.startsWith(sep))) throw new Error('Output must be outside the source registry');
const verify = (directory, publicKey) => {
  const result = spawnSync(process.execPath, ['scripts/verify-plugin-registry.mjs', 'authoring'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PROPRIUM_PLUGIN_OUTPUT_DIR: directory, PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY: publicKey },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Registry verification failed for ${directory}`);
};
verify(source, process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY);
await mkdir(output, { recursive: false });
await cp(join(source, 'proprium'), join(output, 'proprium'), { recursive: true, errorOnExist: true, force: false });
const registryKeys = generateKeyPairSync('ed25519');
const publisherKeys = generateKeyPairSync('ed25519');
const rawKey = key => Buffer.from(key.export({ format: 'der', type: 'spki' })).subarray(-32).toString('base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const publicKey = rawKey(registryKeys.publicKey);
const publisherKey = rawKey(publisherKeys.publicKey);
const baseline = JSON.parse(await readFile(join(source, 'registry.json'), 'utf8'));
const original = [...baseline.plugins];
async function entryFor(entry, version) {
  const slug = entry.id.slice('proprium.'.length);
  if (!/^[a-z0-9-]+$/u.test(slug) || entry.id !== `proprium.${slug}`) throw new Error('Unexpected official plugin ID');
  const metadata = JSON.parse(await readFile(join(root, 'plugins', slug, 'plugin.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(source, entry.manifestPath), 'utf8'));
  if (metadata.id !== entry.id || metadata.version !== entry.version) throw new Error(`Source declaration identity mismatch: ${entry.id}`);
  manifest.version = version;
  manifest.capabilities = metadata.capabilities;
  manifest.actions = metadata.actions;
  manifest.ui = metadata.ui;
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const sha256 = digest(bytes);
  const path = `proprium/${slug}/${version}/manifest/${sha256}.json`;
  await mkdir(dirname(join(output, path)), { recursive: true });
  try { await writeFile(join(output, path), bytes, { flag: 'wx' }); }
  catch (error) { if (error?.code !== 'EEXIST' || !(await readFile(join(output, path))).equals(bytes)) throw error; }
  return { ...entry, version, manifestPath: path, manifestSha256: sha256,
    manifestSignature: sign(null, bytes, publisherKeys.privateKey).toString('base64'), publisherKey, dependencies: metadata.dependencies };
}
async function index(name, registry) {
  const bytes = Buffer.from(`${JSON.stringify(registry)}\n`);
  await writeFile(join(output, `${name}.json`), bytes, { flag: 'wx' });
  await writeFile(join(output, `${name}.json.sig`), sign(null, bytes, registryKeys.privateKey), { flag: 'wx' });
  await writeFile(join(output, 'registry.json'), bytes);
  await writeFile(join(output, 'registry.json.sig'), sign(null, bytes, registryKeys.privateKey));
  verify(output, publicKey);
  return digest(bytes);
}
baseline.plugins = await Promise.all(original.map(entry => entryFor(entry, entry.version)));
const baselineDigest = await index('baseline', baseline);
const next = structuredClone(baseline);
const registryVersion = next.version.split('.');
registryVersion[2] = String(Number(registryVersion[2]) + 1);
next.version = registryVersion.join('.');
for (const entry of original) {
  const parts = entry.version.split('.');
  parts[2] = String(Number(parts[2]) + 1);
  next.plugins.push(await entryFor(entry, parts.join('.')));
}
const nextDigest = await index('next', next);
// Leave the baseline at the standard path for the browser helper.
await writeFile(join(output, 'registry.json'), await readFile(join(output, 'baseline.json')));
await writeFile(join(output, 'registry.json.sig'), await readFile(join(output, 'baseline.json.sig')));
await writeFile(join(output, 'test-root-public-key.txt'), `${publicKey}\n`, { flag: 'wx' });
await writeFile(join(output, 'fixture-provenance.json'), `${JSON.stringify({ kind: 'diagnostic-metadata-only', source_registry_sha256: digest(await readFile(join(source, 'registry.json'))), baseline_sha256: baselineDigest, updated_sha256: nextDigest, component_bytes: 'Copied unchanged from independently verified source registry; no new build.', declarations: 'Current repository plugin.json', keys: 'Ephemeral test keys; private keys not retained.' }, null, 2)}\n`, { flag: 'wx' });
console.log(`Diagnostic fixture verified: baseline ${baselineDigest}, updated ${nextDigest}; public key ${join(output, 'test-root-public-key.txt')}`);
