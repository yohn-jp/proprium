import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.PROPRIUM_PLUGIN_OUTPUT_DIR ?? resolve(root, 'dist/plugin-registry'));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
function compareSemver(left, right) {
  const parse = value => {
    const match = SEMVER.exec(value);
    return match && { core: match.slice(1, 4).map(Number), prerelease: match[4] };
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) throw new Error('Registry contains an invalid SemVer');
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  const x = a.prerelease.split('.'); const y = b.prerelease.split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1;
    if (y[index] === undefined) return 1;
    if (x[index] === y[index]) continue;
    const xn = /^(0|[1-9]\d*)$/u.test(x[index]); const yn = /^(0|[1-9]\d*)$/u.test(y[index]);
    if (xn && yn) return Number(x[index]) < Number(y[index]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[index] < y[index] ? -1 : 1;
  }
  return 0;
}
const verificationMode = process.argv[2] ?? 'all';
if (!['all', 'authoring'].includes(verificationMode)) throw new Error('Usage: node scripts/verify-plugin-registry.mjs [all|authoring]');
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
  const [outputReal, fileReal] = await Promise.all([realpath(output), realpath(resolved)]);
  const realRel = relative(outputReal, fileReal);
  const stat = await lstat(resolved);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || realRel.startsWith(sep) || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Artifact is a symlink, special file or escaped registry output: ${path}`);
  }
  return new Uint8Array(await readFile(fileReal));
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    /^[A-Za-z0-9._/-]+$/u.test(path) && path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}
async function verifyAssetGroups(groups, pluginId) {
  const ids = new Set();
  for (const group of groups) {
    const groupFields = ['id', 'manifest_path', 'sha256', 'bytes', 'role'];
    const prefix = `proprium/${pluginId.slice('proprium.'.length)}/`;
    if (!group || typeof group !== 'object' || Array.isArray(group) || Object.keys(group).length !== groupFields.length ||
        groupFields.some(field => !Object.hasOwn(group, field)) || typeof group.id !== 'string' || !group.id || ids.has(group.id) ||
        !['dictionary', 'embedding', 'reranker'].includes(group.role) || !Number.isSafeInteger(group.bytes) || group.bytes <= 0 ||
        !/^[a-f0-9]{64}$/u.test(group.sha256) || !safePath(group.manifest_path) || !group.manifest_path.startsWith(prefix) ||
        !group.manifest_path.includes(`/${group.sha256}/`)) throw new Error(`Invalid signed asset group reference for ${pluginId}`);
    ids.add(group.id);
    const assetBytes = await readRelative(group.manifest_path);
    if (assetBytes.byteLength !== group.bytes || sha256(assetBytes) !== group.sha256) throw new Error(`Asset manifest digest mismatch for ${pluginId}/${group.id}`);
    const assetManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(assetBytes));
    const assetFields = ['schema', 'id', 'version', 'license', 'files'];
    if (!assetManifest || typeof assetManifest !== 'object' || Array.isArray(assetManifest) || Object.keys(assetManifest).length !== assetFields.length ||
        assetFields.some(field => !Object.hasOwn(assetManifest, field)) || assetManifest.schema !== 'proprium.assets/v1' ||
        assetManifest.id !== group.id || typeof assetManifest.version !== 'string' || !SEMVER.test(assetManifest.version) ||
        typeof assetManifest.license !== 'string' || !assetManifest.license || !Array.isArray(assetManifest.files)) {
      throw new Error(`Invalid asset manifest schema for ${pluginId}/${group.id}`);
    }
    const paths = new Set();
    for (const file of assetManifest.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).length !== 4 ||
          !['path', 'bytes', 'sha256', 'chunks'].every(field => Object.hasOwn(file, field)) || !safePath(file.path) || paths.has(file.path) ||
          !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Array.isArray(file.chunks)) {
        throw new Error(`Invalid asset file entry for ${pluginId}/${group.id}`);
      }
      paths.add(file.path);
      const hash = createHash('sha256');
      let offset = 0;
      for (const chunk of file.chunks) {
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || Object.keys(chunk).length !== 4 ||
            !['path', 'offset', 'bytes', 'sha256'].every(field => Object.hasOwn(chunk, field)) || !safePath(chunk.path) ||
            !chunk.path.startsWith(prefix) || !chunk.path.includes(`/${chunk.sha256}/`) || chunk.offset !== offset ||
            !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(chunk.sha256)) {
          throw new Error(`Invalid asset chunk layout for ${pluginId}/${file.path}`);
        }
        const chunkBytes = await readRelative(chunk.path);
        if (chunkBytes.byteLength !== chunk.bytes || sha256(chunkBytes) !== chunk.sha256) throw new Error(`Asset chunk digest mismatch: ${chunk.path}`);
        hash.update(chunkBytes);
        offset += chunk.bytes;
      }
      const emptyDigest = createHash('sha256').update(new Uint8Array()).digest('hex');
      if (offset !== file.bytes || hash.digest('hex') !== file.sha256 || (file.bytes === 0 && file.chunks.length !== 0) ||
          (file.bytes > 0 && file.chunks.length === 0) || (file.bytes === 0 && file.sha256 !== emptyDigest)) {
        throw new Error(`Asset chunks do not reconstruct ${pluginId}/${file.path}`);
      }
    }
  }
}
const registryBytes = await readFile(resolve(output, 'registry.json'));
const registrySignature = await readFile(resolve(output, 'registry.json.sig'));
if (registrySignature.byteLength !== 64 || !verify(null, registryBytes, rootPublicKey, registrySignature)) {
  throw new Error('Registry signature does not match the separately pinned public key');
}
const registry = JSON.parse(registryBytes.toString('utf8'));
if (registry.schema !== 'proprium.registry/v1' || !Array.isArray(registry.plugins) || typeof registry.version !== 'string' || !SEMVER.test(registry.version)) {
  throw new Error('Unsupported registry document');
}
const seenVersions = new Set();
for (const entry of registry.plugins) {
  const releaseKey = `${entry.id}@${entry.version}`;
  if (seenVersions.has(releaseKey)) throw new Error(`Registry repeats ${releaseKey}`);
  seenVersions.add(releaseKey);
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
  if (manifest.schema === 'proprium.plugin/v2') {
    const fields = ['schema', 'id', 'version', 'abi', 'entrypoint', 'capabilities', 'artifacts', 'actions', 'ui', 'asset_groups'];
    if (Object.keys(manifest).length !== fields.length || fields.some(field => !Object.hasOwn(manifest, field)) ||
        manifest.abi !== 'proprium.component/v2' || typeof manifest.entrypoint !== 'string' ||
        !Array.isArray(manifest.capabilities) || !Array.isArray(manifest.actions) || !Array.isArray(manifest.ui) || !Array.isArray(manifest.asset_groups)) {
      throw new Error(`V2 manifest schema is invalid for ${releaseKey}`);
    }
    if (manifest.capabilities.some(value => typeof value !== 'string' || !value) || new Set(manifest.capabilities).size !== manifest.capabilities.length ||
        manifest.actions.length === 0) {
      throw new Error(`V2 manifest capabilities are invalid for ${releaseKey}`);
    }
    const actions = new Set();
    for (const action of manifest.actions) {
      const actionKeys = ['plugin_id', 'action_id', 'schema_version', 'effect', 'input_schema', 'output_schema',
        'required_capabilities', 'callers', 'requires_user_gesture'];
      if (!action || typeof action !== 'object' || Array.isArray(action) || action.plugin_id !== entry.id ||
          Object.keys(action).some(key => ![...actionKeys, 'caller_plugins'].includes(key)) || actionKeys.some(key => !Object.hasOwn(action, key)) ||
          typeof action.action_id !== 'string' || action.action_id.length === 0 || actions.has(action.action_id) ||
          action.schema_version !== 1 || !['read', 'propose'].includes(action.effect) ||
          !action.input_schema || typeof action.input_schema !== 'object' || action.input_schema.type !== 'object' || action.input_schema.additionalProperties !== false ||
          !action.output_schema || typeof action.output_schema !== 'object' || action.output_schema.type !== 'object' || action.output_schema.additionalProperties !== false ||
          !Array.isArray(action.required_capabilities) || action.required_capabilities.some(value => typeof value !== 'string' || !manifest.capabilities.includes(value)) ||
          new Set(action.required_capabilities).size !== action.required_capabilities.length ||
          !Array.isArray(action.callers) || action.callers.length === 0 || action.callers.some(value => !['ui', 'mcp', 'plugin'].includes(value)) ||
          new Set(action.callers).size !== action.callers.length || typeof action.requires_user_gesture !== 'boolean' ||
          (action.caller_plugins !== undefined && (!Array.isArray(action.caller_plugins) || action.caller_plugins.some(value =>
            typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u.test(value)) || new Set(action.caller_plugins).size !== action.caller_plugins.length))) {
        throw new Error(`V2 manifest action descriptor is invalid for ${releaseKey}`);
      }
      actions.add(action.action_id);
    }
    for (const surface of manifest.ui) if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
      throw new Error(`V2 manifest UI descriptor is invalid for ${releaseKey}`);
    }
    for (const group of manifest.asset_groups) if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error(`V2 manifest asset group is invalid for ${releaseKey}`);
    }
    await verifyAssetGroups(manifest.asset_groups, entry.id);
    if (!manifest.artifacts.some(artifact => artifact.path === manifest.entrypoint && artifact.mediaType === 'application/wasm')) {
      throw new Error(`V2 entrypoint is not a declared WASM artifact for ${releaseKey}`);
    }
  } else if (manifest.schema !== 'proprium.plugin/v1' || manifest.abi !== 'proprium.component/v1') {
    throw new Error(`Unsupported manifest schema or ABI for ${releaseKey}`);
  }
  if (!entry.manifestPath.includes(`/manifest/${entry.manifestSha256}.json`)) throw new Error(`Manifest path is not content-addressed: ${entry.manifestPath}`);
  const artifactPaths = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || Object.keys(artifact).length !== 4 ||
        !['path', 'bytes', 'sha256', 'mediaType'].every(field => Object.hasOwn(artifact, field)) ||
        !safePath(artifact.path) || artifactPaths.has(artifact.path) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !['application/wasm', 'application/json', 'application/octet-stream'].includes(artifact.mediaType)) {
      throw new Error(`Manifest artifact descriptor is invalid for ${releaseKey}`);
    }
    artifactPaths.add(artifact.path);
    const bytes = await readRelative(artifact.path);
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`Artifact digest mismatch: ${artifact.path}`);
    if (!artifact.path.includes(`/${artifact.sha256}/`)) throw new Error(`Artifact path is not content-addressed: ${artifact.path}`);
    if (artifact.mediaType === 'application/wasm' && (bytes.byteLength < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)) {
      throw new Error(`WASM artifact has an invalid binary header: ${artifact.path}`);
    }
  }
}
if (verificationMode === 'authoring') {
  const officialIds = [
    'proprium.narrative', 'proprium.knowledge', 'proprium.research', 'proprium.paired-writing',
    'proprium.diagnostics', 'proprium.speaker', 'proprium.semantic', 'proprium.publishing',
  ];
  for (const id of officialIds) {
    const releases = registry.plugins.filter(entry => entry.id === id).sort((left, right) => compareSemver(left.version, right.version));
    const latest = releases.at(-1);
    if (!latest) throw new Error(`Official authoring plugin is missing from the signed registry: ${id}`);
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRelative(latest.manifestPath)));
    if (manifest.schema !== 'proprium.plugin/v2' || manifest.abi !== 'proprium.component/v2' || manifest.actions.length === 0) {
      throw new Error(`Official authoring plugin is not signed as WIT v2: ${id}@${latest.version}`);
    }
  }
}
console.log(`Verified ${registry.plugins.length} signed plugin release(s) in ${output}`);
