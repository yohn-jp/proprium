import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAuthoringDeclarations } from './authoring-manifest-schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.PROPRIUM_PLUGIN_OUTPUT_DIR ?? resolve(root, 'dist/plugin-registry'));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
const CAPABILITY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const ASSET_GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u;
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
function validDependencyRange(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  if (value === '*') return true;
  const match = /^(\^|~)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  return match !== null && SEMVER.test(`${match[2]}${match[4] ? `-${match[4]}` : ''}`);
}
function satisfiesVersion(version, range) {
  if (!SEMVER.test(version) || !validDependencyRange(range)) return false;
  if (range === '*') return true;
  const match = /^(\^|~)?(.+)$/u.exec(range);
  const operator = match[1]; const base = match[2];
  if (!operator) return version === base;
  const actual = SEMVER.exec(version); const expected = SEMVER.exec(base);
  if (!actual || !expected) return false;
  if (actual[4] !== undefined && (expected[4] === undefined || actual[1] !== expected[1] || actual[2] !== expected[2] || actual[3] !== expected[3])) return false;
  if (compareSemver(version, base) < 0) return false;
  if (operator === '~') return actual[1] === expected[1] && actual[2] === expected[2];
  if (Number(expected[1]) > 0) return actual[1] === expected[1];
  if (Number(expected[2]) > 0) return actual[1] === '0' && actual[2] === expected[2];
  return actual[1] === '0' && actual[2] === '0' && actual[3] === expected[3];
}
function validateDependencyGraph(releases) {
  const byId = new Map();
  for (const release of releases) {
    const versions = byId.get(release.id) ?? [];
    versions.push(release);
    byId.set(release.id, versions);
  }
  const edges = new Map();
  for (const release of releases) {
    if (!Array.isArray(release.dependencies) || release.dependencies.length > 128) {
      throw new Error(`Registry dependencies are invalid for ${release.id}@${release.version}`);
    }
    const seen = new Set();
    const targets = [];
    for (const dependency of release.dependencies) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency) || Object.keys(dependency).length !== 2 ||
          typeof dependency.id !== 'string' || !PLUGIN_ID.test(dependency.id) || !validDependencyRange(dependency.range) ||
          dependency.id === release.id || seen.has(dependency.id)) {
        throw new Error(`Registry dependency is invalid for ${release.id}@${release.version}`);
      }
      seen.add(dependency.id);
      const target = [...(byId.get(dependency.id) ?? [])]
        .filter(candidate => satisfiesVersion(candidate.version, dependency.range))
        .sort((left, right) => compareSemver(right.version, left.version))[0];
      if (!target) throw new Error(`No signed ${dependency.id} release satisfies ${dependency.range} required by ${release.id}@${release.version}`);
      targets.push(target);
    }
    edges.set(`${release.id}@${release.version}`, targets.map(target => `${target.id}@${target.version}`));
  }
  const visiting = new Set(); const visited = new Set();
  const visit = release => {
    if (visited.has(release)) return;
    if (visiting.has(release)) throw new Error(`Signed plugin dependency cycle includes ${release}`);
    visiting.add(release);
    for (const dependency of edges.get(release) ?? []) visit(dependency);
    visiting.delete(release); visited.add(release);
  };
  for (const release of edges.keys()) visit(release);
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
  if (typeof path !== 'string' || path.length === 0 || path.length > 256 || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
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
  return typeof path === 'string' && path.length > 0 && path.length <= 256 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    /^[A-Za-z0-9._/-]+$/u.test(path) && path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}
async function verifyAssetGroups(groups, pluginId) {
  const ids = new Set();
  for (const group of groups) {
    const groupFields = ['id', 'manifest_path', 'sha256', 'bytes', 'role'];
    const prefix = `proprium/${pluginId.slice('proprium.'.length)}/`;
    if (!group || typeof group !== 'object' || Array.isArray(group) || Object.keys(group).length !== groupFields.length ||
        groupFields.some(field => !Object.hasOwn(group, field)) || typeof group.id !== 'string' || !ASSET_GROUP_ID.test(group.id) || ids.has(group.id) ||
        !['dictionary', 'embedding', 'reranker'].includes(group.role) || !Number.isSafeInteger(group.bytes) || group.bytes <= 0 || group.bytes > 512 * 1024 ||
        !/^[a-f0-9]{64}$/u.test(group.sha256) || !safePath(group.manifest_path) || !group.manifest_path.startsWith(prefix) ||
        !group.manifest_path.includes(`/${group.sha256}/`)) throw new Error(`Invalid signed asset group reference for ${pluginId}`);
    ids.add(group.id);
    const assetBytes = await readRelative(group.manifest_path);
    if (assetBytes.byteLength !== group.bytes || sha256(assetBytes) !== group.sha256) throw new Error(`Asset manifest digest mismatch for ${pluginId}/${group.id}`);
    const assetManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(assetBytes));
    const assetFields = ['schema', 'id', 'version', 'license', 'files'];
    if (!assetManifest || typeof assetManifest !== 'object' || Array.isArray(assetManifest) || Object.keys(assetManifest).length !== assetFields.length ||
        assetFields.some(field => !Object.hasOwn(assetManifest, field)) || assetManifest.schema !== 'proprium.assets/v1' ||
        assetManifest.id !== group.id || typeof assetManifest.version !== 'string' || assetManifest.version.length > 128 || !SEMVER.test(assetManifest.version) ||
        typeof assetManifest.license !== 'string' || !assetManifest.license.trim() || assetManifest.license.length > 4096 ||
        !Array.isArray(assetManifest.files) || assetManifest.files.length === 0) {
      throw new Error(`Invalid asset manifest schema for ${pluginId}/${group.id}`);
    }
    const paths = new Set();
    let groupPayloadBytes = 0;
    for (const file of assetManifest.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).length !== 4 ||
          !['path', 'bytes', 'sha256', 'chunks'].every(field => Object.hasOwn(file, field)) || !safePath(file.path) || paths.has(file.path) ||
          !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Array.isArray(file.chunks)) {
        throw new Error(`Invalid asset file entry for ${pluginId}/${group.id}`);
      }
      paths.add(file.path);
      groupPayloadBytes += file.bytes;
      if (!Number.isSafeInteger(groupPayloadBytes)) throw new Error(`Asset group byte total exceeds safe accounting for ${pluginId}/${group.id}`);
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
    if (groupPayloadBytes === 0) throw new Error(`Asset group contains no payload bytes for ${pluginId}/${group.id}`);
  }
}
const registryBytes = await readFile(resolve(output, 'registry.json'));
if (registryBytes.byteLength === 0 || registryBytes.byteLength > 1024 * 1024) throw new Error('Registry document exceeds the Host admission ceiling');
const registrySignature = await readFile(resolve(output, 'registry.json.sig'));
if (registrySignature.byteLength !== 64 || !verify(null, registryBytes, rootPublicKey, registrySignature)) {
  throw new Error('Registry signature does not match the separately pinned public key');
}
const registry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(registryBytes));
if (!registry || typeof registry !== 'object' || Array.isArray(registry) || Object.keys(registry).length !== 5 ||
    !['schema', 'id', 'version', 'artifactBase', 'plugins'].every(field => Object.hasOwn(registry, field)) ||
    registry.schema !== 'proprium.registry/v1' || typeof registry.id !== 'string' || !PLUGIN_ID.test(registry.id) ||
    typeof registry.version !== 'string' || !SEMVER.test(registry.version) || typeof registry.artifactBase !== 'string' ||
    !Array.isArray(registry.plugins) || registry.plugins.length > 4096) {
  throw new Error('Unsupported registry document');
}
let artifactBase;
try { artifactBase = new URL(registry.artifactBase); } catch { throw new Error('Registry artifactBase is not an absolute URL'); }
if (artifactBase.href !== registry.artifactBase || !artifactBase.pathname.endsWith('/') || artifactBase.search || artifactBase.hash ||
    (artifactBase.protocol !== 'https:' && !(artifactBase.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(artifactBase.hostname)))) {
  throw new Error('Registry artifactBase is not an approved directory URL');
}
const seenVersions = new Set();
for (const entry of registry.plugins) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 7 ||
      !['id', 'version', 'manifestPath', 'manifestSha256', 'manifestSignature', 'publisherKey', 'dependencies'].every(field => Object.hasOwn(entry, field)) ||
      typeof entry.id !== 'string' || !PLUGIN_ID.test(entry.id) || typeof entry.version !== 'string' || !SEMVER.test(entry.version) ||
      typeof entry.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.manifestSha256) ||
      typeof entry.manifestSignature !== 'string' || entry.manifestSignature.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.manifestSignature) ||
      typeof entry.publisherKey !== 'string' || entry.publisherKey.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.publisherKey) ||
      !Array.isArray(entry.dependencies) || entry.dependencies.length > 128) {
    throw new Error('Registry plugin entry is malformed');
  }
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
  if (manifest.id !== entry.id || manifest.version !== entry.version || !Array.isArray(manifest.artifacts) ||
      manifest.artifacts.length === 0 || manifest.artifacts.length > 256) {
    throw new Error(`Manifest identity mismatch for ${entry.id}@${entry.version}`);
  }
  if (manifest.schema === 'proprium.plugin/v2') {
    const fields = ['schema', 'id', 'version', 'abi', 'entrypoint', 'capabilities', 'artifacts', 'actions', 'ui', 'asset_groups'];
    if (Object.keys(manifest).length !== fields.length || fields.some(field => !Object.hasOwn(manifest, field)) ||
        manifest.abi !== 'proprium.component/v2' || typeof manifest.entrypoint !== 'string' ||
        !Array.isArray(manifest.capabilities) || !Array.isArray(manifest.actions) || !Array.isArray(manifest.ui) || !Array.isArray(manifest.asset_groups) ||
        manifestBytes.byteLength > 512 * 1024 || manifest.actions.length > 256 || manifest.ui.length > 128 || manifest.asset_groups.length > 32) {
      throw new Error(`V2 manifest schema is invalid for ${releaseKey}`);
    }
    if (manifest.capabilities.some(value => typeof value !== 'string' || value.length > 128 || !CAPABILITY.test(value)) || new Set(manifest.capabilities).size !== manifest.capabilities.length ||
        manifest.actions.length === 0) {
      throw new Error(`V2 manifest capabilities are invalid for ${releaseKey}`);
    }
    try { await assertAuthoringDeclarations(entry.id, manifest.capabilities, manifest.actions, manifest.ui); }
    catch (error) { throw new Error(`V2 authoring declarations fail the adopted Host schema for ${releaseKey}: ${error instanceof Error ? error.message : String(error)}`); }
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
  let totalArtifactBytes = 0;
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || Object.keys(artifact).length !== 4 ||
        !['path', 'bytes', 'sha256', 'mediaType'].every(field => Object.hasOwn(artifact, field)) ||
        !safePath(artifact.path) || artifactPaths.has(artifact.path) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > 128 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !['application/wasm', 'application/json', 'application/octet-stream'].includes(artifact.mediaType)) {
      throw new Error(`Manifest artifact descriptor is invalid for ${releaseKey}`);
    }
    totalArtifactBytes += artifact.bytes;
    if (totalArtifactBytes > 512 * 1024 * 1024) throw new Error(`Manifest artifact aggregate exceeds the Host cap for ${releaseKey}`);
    artifactPaths.add(artifact.path);
    const bytes = await readRelative(artifact.path);
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`Artifact digest mismatch: ${artifact.path}`);
    if (!artifact.path.includes(`/${artifact.sha256}/`)) throw new Error(`Artifact path is not content-addressed: ${artifact.path}`);
    if (artifact.mediaType === 'application/wasm' && (bytes.byteLength < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)) {
      throw new Error(`WASM artifact has an invalid binary header: ${artifact.path}`);
    }
  }
  if (manifest.schema === 'proprium.plugin/v1' && manifestBytes.byteLength > 128 * 1024) {
    throw new Error(`V1 manifest exceeds its Host admission ceiling for ${releaseKey}`);
  }
}
validateDependencyGraph(registry.plugins);
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
