import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginId = 'proprium.compute-sum';
const pluginVersion = process.env.PROPRIUM_PLUGIN_VERSION;
const registryId = 'proprium.public';
const output = resolve(root, 'dist/plugin-registry');
const artifactBase = process.env.PROPRIUM_PLUGIN_ARTIFACT_BASE;
const registryPrivatePem = process.env.PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY;
const publisherPrivatePem = process.env.PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY;
const encodedPinnedRegistryKey = process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY;
const previousRegistryDir = resolve(process.env.PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR ?? output);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
if (!pluginVersion || !VERSION.test(pluginVersion) || !artifactBase || !registryPrivatePem || !publisherPrivatePem || !encodedPinnedRegistryKey) {
  throw new Error('Set PROPRIUM_PLUGIN_VERSION, PROPRIUM_PLUGIN_ARTIFACT_BASE, both Ed25519 private keys, and the separately pinned PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY');
}
const baseUrl = new URL(artifactBase);
if (baseUrl.href !== artifactBase || !baseUrl.pathname.endsWith('/') || baseUrl.search || baseUrl.hash ||
    (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)))) {
  throw new Error('PROPRIUM_PLUGIN_ARTIFACT_BASE must be a directory HTTPS URL');
}
const registryPrivateKey = createPrivateKey(registryPrivatePem);
const publisherPrivateKey = createPrivateKey(publisherPrivatePem);
const rawEd25519PublicKey = privateKey => {
  const encoded = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (!encoded.subarray(0, prefix.length).equals(prefix) || encoded.byteLength !== prefix.length + 32) {
    throw new Error('Plugin signing keys must be Ed25519');
  }
  return encoded.subarray(prefix.length);
};
const fromRawPublicKey = raw => createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]),
  format: 'der', type: 'spki',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pinnedRegistryKey = Buffer.from(encodedPinnedRegistryKey, 'base64');
const activeRegistryKey = rawEd25519PublicKey(registryPrivateKey);
if (pinnedRegistryKey.byteLength !== 32 || !pinnedRegistryKey.equals(activeRegistryKey)) {
  throw new Error('Pinned public registry key does not match the registry signing key');
}

const safeRelativePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') &&
  /^[A-Za-z0-9._/-]+$/u.test(path) && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
async function readUnder(directory, path) {
  if (!safeRelativePath(path)) throw new Error(`Unsafe plugin artifact path: ${path}`);
  const resolved = resolve(directory, ...path.split('/'));
  const rel = relative(directory, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Artifact escaped registry directory: ${path}`);
  return new Uint8Array(await readFile(resolved));
}
async function copyVerifiedFile(sourceDirectory, path, expectedBytes) {
  const source = resolve(sourceDirectory, ...path.split('/'));
  const target = resolve(output, ...path.split('/'));
  const rel = relative(output, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Artifact escaped output directory: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  if (source !== target) {
    let previous;
    try { previous = new Uint8Array(await readFile(target)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (previous) {
      if (!Buffer.from(previous).equals(Buffer.from(expectedBytes))) throw new Error(`Refusing to overwrite immutable content at ${path}`);
    } else await copyFile(source, target, fsConstants.COPYFILE_EXCL);
  }
  const outputBytes = new Uint8Array(await readFile(target));
  if (digest(outputBytes) !== digest(expectedBytes)) throw new Error(`Existing content-addressed asset differs at ${path}`);
}
function compareSemver(left, right) {
  const parse = value => {
    const match = VERSION.exec(value);
    return match && { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) throw new Error('Invalid SemVer in signed registry');
  for (const field of ['major', 'minor', 'patch']) if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

async function readPreviousRegistry() {
  let bytes;
  let signature;
  try {
    bytes = await readFile(resolve(previousRegistryDir, 'registry.json'));
    signature = await readFile(resolve(previousRegistryDir, 'registry.json.sig'));
  } catch (error) {
    if (previousRegistryDir === output && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') throw new Error('Previous registry input needs both registry.json and registry.json.sig');
    throw error;
  }
  if (signature.byteLength !== 64 || !verify(null, bytes, fromRawPublicKey(pinnedRegistryKey), signature)) {
    throw new Error('Previous registry signature does not match the Host-pinned registry key');
  }
  const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (document.schema !== 'proprium.registry/v1' || document.id !== registryId || document.artifactBase !== artifactBase || !Array.isArray(document.plugins)) {
    throw new Error('Previous registry identity or artifact origin differs from this release');
  }
  const keys = new Set();
  for (const entry of document.plugins) {
    const key = `${entry.id}@${entry.version}`;
    if (keys.has(key)) throw new Error(`Previous registry repeats ${key}`);
    keys.add(key);
    const manifestBytes = await readUnder(previousRegistryDir, entry.manifestPath);
    if (digest(manifestBytes) !== entry.manifestSha256 || !entry.manifestPath.includes(`/manifest/${entry.manifestSha256}.json`)) {
      throw new Error(`Previous manifest is invalid or not content-addressed for ${key}`);
    }
    const publisherKeyBytes = Buffer.from(entry.publisherKey, 'base64');
    const manifestSignature = Buffer.from(entry.manifestSignature, 'base64');
    if (publisherKeyBytes.byteLength !== 32 || manifestSignature.byteLength !== 64 ||
        !verify(null, manifestBytes, fromRawPublicKey(publisherKeyBytes), manifestSignature)) {
      throw new Error(`Previous manifest publisher proof failed for ${key}`);
    }
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    if (manifest.id !== entry.id || manifest.version !== entry.version || !Array.isArray(manifest.artifacts)) throw new Error(`Previous manifest identity failed for ${key}`);
    for (const artifact of manifest.artifacts) {
      const asset = await readUnder(previousRegistryDir, artifact.path);
      if (asset.byteLength !== artifact.bytes || digest(asset) !== artifact.sha256 || !artifact.path.includes(`/${artifact.sha256}/`)) {
        throw new Error(`Previous content-addressed artifact failed for ${key}: ${artifact.path}`);
      }
      await copyVerifiedFile(previousRegistryDir, artifact.path, asset);
    }
    await copyVerifiedFile(previousRegistryDir, entry.manifestPath, manifestBytes);
  }
  return document;
}

const previousRegistry = await readPreviousRegistry();
if (previousRegistry && compareSemver(pluginVersion, previousRegistry.version) < 0) {
  throw new Error(`Plugin/registry version ${pluginVersion} cannot go below current registry version ${previousRegistry.version}`);
}
if (previousRegistry?.plugins.some(entry => entry.id === pluginId && entry.version === pluginVersion)) {
  throw new Error(`${pluginId}@${pluginVersion} already exists; plugin versions are immutable, publish a new PROPRIUM_PLUGIN_VERSION`);
}

const jco = process.platform === 'win32' ? 'jco.cmd' : resolve(root, 'node_modules/.bin/jco');
const wit = resolve(root, 'app/src/browser/proprium/plugin-runtime/wit');
const pluginSource = resolve(root, 'plugins/examples/compute-sum.ts');
const packagePathForVersion = `proprium/compute-sum/${pluginVersion}`;
const packageDirectory = resolve(output, packagePathForVersion);
const componentPath = resolve(packageDirectory, 'component.build.wasm');
await mkdir(packageDirectory, { recursive: true });
execFileSync(jco, ['componentize', pluginSource, '--wit', wit, '--world-name', 'proprium:plugin/plugin@1.0.0', '--disable', 'all', '--bundle', '-o', componentPath], { cwd: root, stdio: 'inherit' });
const component = new Uint8Array(await readFile(componentPath));
const componentDigest = digest(component);
const entrypoint = `${packagePathForVersion}/${componentDigest}/plugin.component.wasm`;
const immutableComponentPath = resolve(output, entrypoint);
await mkdir(dirname(immutableComponentPath), { recursive: true });
let previousComponent;
try { previousComponent = new Uint8Array(await readFile(immutableComponentPath)); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (previousComponent) {
  if (!Buffer.from(previousComponent).equals(Buffer.from(component))) throw new Error(`Refusing to overwrite immutable content at ${entrypoint}`);
  await unlink(componentPath);
} else await rename(componentPath, immutableComponentPath);
const manifest = {
  schema: 'proprium.plugin/v1',
  id: pluginId,
  version: pluginVersion,
  abi: 'proprium.component/v1',
  entrypoint,
  capabilities: [],
  artifacts: [{ path: entrypoint, bytes: component.byteLength, sha256: componentDigest, mediaType: 'application/wasm' }],
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSignature = sign(null, manifestBytes, publisherPrivateKey);
const manifestDigest = digest(manifestBytes);
const manifestPath = `${packagePathForVersion}/manifest/${manifestDigest}.json`;
await mkdir(dirname(resolve(output, manifestPath)), { recursive: true });
const immutableManifestPath = resolve(output, manifestPath);
let previousManifest;
try { previousManifest = new Uint8Array(await readFile(immutableManifestPath)); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (previousManifest) {
  if (!Buffer.from(previousManifest).equals(manifestBytes)) throw new Error(`Refusing to overwrite immutable content at ${manifestPath}`);
} else await writeFile(immutableManifestPath, manifestBytes, { flag: 'wx' });
const newEntry = {
  id: pluginId,
  version: pluginVersion,
  manifestPath,
  manifestSha256: manifestDigest,
  manifestSignature: manifestSignature.toString('base64'),
  publisherKey: rawEd25519PublicKey(publisherPrivateKey).toString('base64'),
  dependencies: [],
};
const plugins = [...(previousRegistry?.plugins ?? [])];
plugins.push(newEntry);
plugins.sort((a, b) => a.id.localeCompare(b.id) || compareSemver(b.version, a.version));
const registry = {
  schema: 'proprium.registry/v1',
  id: registryId,
  version: pluginVersion,
  artifactBase,
  plugins,
};
const registryBytes = Buffer.from(JSON.stringify(registry));
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'registry.json.sig'), sign(null, registryBytes, registryPrivateKey));
await writeFile(resolve(output, 'registry.json'), registryBytes);
console.log(`Built signed plugin registry in ${output}`);
console.log(`Plugin: ${pluginId}@${pluginVersion}`);
console.log(`Registry URL: ${new URL('registry.json', artifactBase).href}`);
console.log(`Registry public key (base64): ${activeRegistryKey.toString('base64')}`);
console.log(`Immutable artifact: ${entrypoint}`);
console.log(`Immutable manifest: ${manifestPath}`);
console.log(`Preserved ${previousRegistry?.plugins.length ?? 0} prior version(s); registry contains ${plugins.length} immutable entry/entries`);
