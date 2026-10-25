import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginId = 'proprium.compute-sum';
const pluginVersion = '1.0.0';
const registryId = 'proprium.public';
const packagePath = 'proprium/compute-sum/1.0.0';
const output = resolve(root, 'dist/plugin-registry');
const artifactBase = process.env.PROPRIUM_PLUGIN_ARTIFACT_BASE;
const registryPrivatePem = process.env.PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY;
const publisherPrivatePem = process.env.PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY;
if (!artifactBase || !registryPrivatePem || !publisherPrivatePem) {
  throw new Error('Set PROPRIUM_PLUGIN_ARTIFACT_BASE, PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY, and PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY');
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
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const jco = process.platform === 'win32' ? 'jco.cmd' : resolve(root, 'node_modules/.bin/jco');
const wit = resolve(root, 'app/src/browser/proprium/plugin-runtime/wit');
const pluginSource = resolve(root, 'plugins/examples/compute-sum.ts');
const packageDirectory = resolve(output, packagePath);
const componentPath = resolve(packageDirectory, 'component.build.wasm');
await mkdir(packageDirectory, { recursive: true });
execFileSync(jco, ['componentize', pluginSource, '--wit', wit, '--world-name', 'proprium:plugin/plugin@1.0.0', '--disable', 'all', '--bundle', '-o', componentPath], { cwd: root, stdio: 'inherit' });
const component = new Uint8Array(await readFile(componentPath));
const componentDigest = await digest(component);
const entrypoint = `${packagePath}/${componentDigest}/plugin.component.wasm`;
const immutableComponentPath = resolve(output, entrypoint);
await mkdir(dirname(immutableComponentPath), { recursive: true });
await rename(componentPath, immutableComponentPath);
const manifest = {
  schema: 'proprium.plugin/v1',
  id: pluginId,
  version: pluginVersion,
  abi: 'proprium.component/v1',
  entrypoint,
  capabilities: [],
  artifacts: [{ path: entrypoint, bytes: component.byteLength, sha256: await digest(component), mediaType: 'application/wasm' }],
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSignature = sign(null, manifestBytes, publisherPrivateKey);
const manifestDigest = await digest(manifestBytes);
const manifestPath = `${packagePath}/manifest/${manifestDigest}.json`;
await mkdir(dirname(resolve(output, manifestPath)), { recursive: true });
await writeFile(resolve(output, manifestPath), manifestBytes);
const registry = {
  schema: 'proprium.registry/v1',
  id: registryId,
  version: '1.0.0',
  artifactBase,
  plugins: [{
    id: pluginId,
    version: pluginVersion,
    manifestPath,
    manifestSha256: manifestDigest,
    manifestSignature: manifestSignature.toString('base64'),
    publisherKey: rawEd25519PublicKey(publisherPrivateKey).toString('base64'),
    dependencies: [],
  }],
};
const registryBytes = Buffer.from(JSON.stringify(registry));
await writeFile(resolve(output, 'registry.json'), registryBytes);
await writeFile(resolve(output, 'registry.json.sig'), sign(null, registryBytes, registryPrivateKey));
console.log(`Built signed plugin registry in ${output}`);
console.log(`Plugin: ${pluginId}@${pluginVersion}`);
console.log(`Registry URL: ${new URL('registry.json', artifactBase).href}`);
console.log(`Registry public key (base64): ${rawEd25519PublicKey(registryPrivateKey).toString('base64')}`);
console.log(`Immutable artifact: ${entrypoint}`);
console.log(`Immutable manifest: ${manifestPath}`);
