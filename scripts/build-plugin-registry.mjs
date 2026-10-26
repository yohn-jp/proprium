import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildMode = process.argv[2] ?? 'example';
if (!['example', 'authoring'].includes(buildMode)) {
  throw new Error('Usage: node scripts/build-plugin-registry.mjs [example|authoring]');
}
const pluginId = 'proprium.compute-sum';
const pluginVersion = process.env.PROPRIUM_PLUGIN_VERSION;
const registryVersion = buildMode === 'authoring' ? process.env.PROPRIUM_PLUGIN_REGISTRY_VERSION : pluginVersion;
const registryId = 'proprium.public';
const output = resolve(process.env.PROPRIUM_PLUGIN_OUTPUT_DIR ?? resolve(root, 'dist/plugin-registry'));
const artifactBase = process.env.PROPRIUM_PLUGIN_ARTIFACT_BASE;
const registryPrivatePem = process.env.PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY;
const publisherPrivatePem = process.env.PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY;
const encodedPinnedRegistryKey = process.env.PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY;
const previousRegistryDir = resolve(process.env.PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR || output);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
if ((buildMode === 'example' && (!pluginVersion || !VERSION.test(pluginVersion))) ||
    (buildMode === 'authoring' && (!registryVersion || !VERSION.test(registryVersion))) ||
    !artifactBase || !registryPrivatePem || !publisherPrivatePem || !encodedPinnedRegistryKey) {
  const versionRequirement = buildMode === 'authoring' ? 'PROPRIUM_PLUGIN_REGISTRY_VERSION' : 'PROPRIUM_PLUGIN_VERSION';
  throw new Error(`Set ${versionRequirement}, PROPRIUM_PLUGIN_ARTIFACT_BASE, both Ed25519 private keys, and the separately pinned PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY`);
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
const componentizeEnvironment = {
  PATH: process.env.PATH ?? '',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
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
  const [directoryReal, fileReal] = await Promise.all([realpath(directory), realpath(resolved)]);
  const realRel = relative(directoryReal, fileReal);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || realRel.startsWith(sep)) throw new Error(`Artifact symlink escaped registry directory: ${path}`);
  if (!(await lstat(resolved)).isFile()) throw new Error(`Registry artifact is not a regular file: ${path}`);
  return new Uint8Array(await readFile(fileReal));
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
    return match && { core: match.slice(1, 4).map(Number), prerelease: match[4] };
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) throw new Error('Invalid SemVer in signed registry');
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
    if (manifest.schema === 'proprium.plugin/v2') {
      if (!Array.isArray(manifest.asset_groups)) throw new Error(`Previous v2 manifest asset groups are invalid for ${key}`);
      for (const group of manifest.asset_groups) await copyAssetGroup(group, entry.id, path => readUnder(previousRegistryDir, path));
    }
    await copyVerifiedFile(previousRegistryDir, entry.manifestPath, manifestBytes);
  }
  return document;
}

const previousRegistry = await readPreviousRegistry();
if (previousRegistry && compareSemver(registryVersion, previousRegistry.version) <= 0) {
  throw new Error(`Registry version ${registryVersion} must be newer than current registry version ${previousRegistry.version}`);
}

async function persistImmutable(path, bytes) {
  if (!safeRelativePath(path)) throw new Error(`Unsafe immutable artifact path: ${path}`);
  const target = resolve(output, ...path.split('/'));
  const rel = relative(output, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Artifact escaped output directory: ${path}`);
  await mkdir(output, { recursive: true });
  const outputStat = await lstat(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('Plugin output must be a real directory');
  let cursor = output;
  for (const segment of path.split('/').slice(0, -1)) {
    cursor = resolve(cursor, segment);
    await mkdir(cursor).catch(error => { if (error?.code !== 'EEXIST') throw error; });
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Artifact path traverses a non-directory or symlink: ${path}`);
  }
  try {
    const previous = new Uint8Array(await readFile(target));
    if (!Buffer.from(previous).equals(Buffer.from(bytes))) throw new Error(`Refusing to overwrite immutable content at ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(target, bytes, { flag: 'wx' });
  }
}

async function publishRegistry(plugins, version) {
  plugins.sort((left, right) => left.id.localeCompare(right.id) || compareSemver(right.version, left.version));
  const registry = { schema: 'proprium.registry/v1', id: registryId, version, artifactBase, plugins };
  const registryBytes = Buffer.from(JSON.stringify(registry));
  await mkdir(output, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const signatureTmp = resolve(output, `.registry-${nonce}.sig.tmp`);
  const registryTmp = resolve(output, `.registry-${nonce}.json.tmp`);
  try {
    await writeFile(signatureTmp, sign(null, registryBytes, registryPrivateKey), { flag: 'wx' });
    await writeFile(registryTmp, registryBytes, { flag: 'wx' });
    await rename(signatureTmp, resolve(output, 'registry.json.sig'));
    await rename(registryTmp, resolve(output, 'registry.json'));
  } finally {
    await unlink(signatureTmp).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    await unlink(registryTmp).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }
  console.log(`Built signed plugin registry in ${output}`);
  console.log(`Registry URL: ${new URL('registry.json', artifactBase).href}`);
  console.log(`Registry public key (base64): ${activeRegistryKey.toString('base64')}`);
  console.log(`Preserved ${previousRegistry?.plugins.length ?? 0} prior version(s); registry contains ${plugins.length} immutable entry/entries`);
}

async function readPluginAsset(pluginDirectory, path) {
  if (!safeRelativePath(path)) throw new Error(`Unsafe plugin asset source path: ${path}`);
  const resolved = resolve(pluginDirectory, ...path.split('/'));
  const [directoryReal, fileReal] = await Promise.all([realpath(pluginDirectory), realpath(resolved)]);
  const rel = relative(directoryReal, fileReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Plugin asset escaped its source directory: ${path}`);
  let cursor = directoryReal;
  for (const [index, segment] of path.split('/').entries()) {
    cursor = resolve(cursor, segment);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || (index < path.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Plugin asset path contains a symlink or special file: ${path}`);
    }
  }
  return new Uint8Array(await readFile(fileReal));
}

async function copyAssetGroup(group, pluginId, readAsset) {
  const fields = ['id', 'manifest_path', 'sha256', 'bytes', 'role'];
  const prefix = `${pluginId.replace('.', '/')}/`;
  if (!group || typeof group !== 'object' || Array.isArray(group) || Object.keys(group).length !== fields.length ||
      fields.some(field => !Object.hasOwn(group, field)) || typeof group.id !== 'string' || !group.id ||
      !['dictionary', 'embedding', 'reranker'].includes(group.role) || !Number.isSafeInteger(group.bytes) || group.bytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(group.sha256) || typeof group.manifest_path !== 'string' ||
      !group.manifest_path.startsWith(prefix) || !group.manifest_path.includes(`/${group.sha256}/`) || !safeRelativePath(group.manifest_path)) {
    throw new Error(`${pluginId} declares an invalid signed asset group reference`);
  }
  const manifestBytes = await readAsset(group.manifest_path);
  if (manifestBytes.byteLength !== group.bytes || digest(manifestBytes) !== group.sha256) {
    throw new Error(`${pluginId} asset manifest size or digest differs from its signed reference: ${group.id}`);
  }
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { throw new Error(`${pluginId} asset manifest must be UTF-8 JSON: ${group.id}`); }
  const manifestFields = ['schema', 'id', 'version', 'license', 'files'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).length !== manifestFields.length ||
      manifestFields.some(field => !Object.hasOwn(manifest, field)) || manifest.schema !== 'proprium.assets/v1' ||
      manifest.id !== group.id || typeof manifest.version !== 'string' || !VERSION.test(manifest.version) ||
      typeof manifest.license !== 'string' || !manifest.license || !Array.isArray(manifest.files)) {
    throw new Error(`${pluginId} asset manifest schema or identity is invalid: ${group.id}`);
  }
  const filePaths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).length !== 4 ||
        !['path', 'bytes', 'sha256', 'chunks'].every(field => Object.hasOwn(file, field)) || !safeRelativePath(file.path) ||
        filePaths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        !Array.isArray(file.chunks)) throw new Error(`${pluginId} asset manifest has an invalid file entry: ${group.id}`);
    filePaths.add(file.path);
    let nextOffset = 0;
    const wholeFile = createHash('sha256');
    for (const chunk of file.chunks) {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || Object.keys(chunk).length !== 4 ||
          !['path', 'offset', 'bytes', 'sha256'].every(field => Object.hasOwn(chunk, field)) || !safeRelativePath(chunk.path) ||
          !chunk.path.startsWith(prefix) || !chunk.path.includes(`/${chunk.sha256}/`) || chunk.offset !== nextOffset ||
          !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > 16 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/u.test(chunk.sha256)) throw new Error(`${pluginId} asset chunk layout is invalid: ${group.id}`);
      const chunkBytes = await readAsset(chunk.path);
      if (chunkBytes.byteLength !== chunk.bytes || digest(chunkBytes) !== chunk.sha256) {
        throw new Error(`${pluginId} asset chunk size or digest mismatch: ${chunk.path}`);
      }
      wholeFile.update(chunkBytes);
      nextOffset += chunk.bytes;
      await persistImmutable(chunk.path, chunkBytes);
    }
    const emptyDigest = createHash('sha256').update(new Uint8Array()).digest('hex');
    if (nextOffset !== file.bytes || wholeFile.digest('hex') !== file.sha256 || (file.bytes === 0 && file.chunks.length !== 0) ||
        (file.bytes > 0 && file.chunks.length === 0) || (file.bytes === 0 && file.sha256 !== emptyDigest)) {
      throw new Error(`${pluginId} asset file chunks do not reconstruct the declared bytes: ${file.path}`);
    }
  }
  await persistImmutable(group.manifest_path, manifestBytes);
}

function satisfiesVersion(version, range) {
  if (!VERSION.test(version) || !validDependencyRange(range)) return false;
  if (range === '*') return true;
  const match = /^(\^|~)?(.+)$/u.exec(range);
  const operator = match[1]; const base = match[2];
  if (!operator) return version === base;
  const actual = VERSION.exec(version); const expected = VERSION.exec(base);
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
    if (!Array.isArray(release.dependencies)) throw new Error(`Registry dependencies are invalid for ${release.id}@${release.version}`);
    const seen = new Set();
    const targets = [];
    for (const dependency of release.dependencies) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency) || Object.keys(dependency).length !== 2 ||
          typeof dependency.id !== 'string' || !/^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u.test(dependency.id) ||
          !validDependencyRange(dependency.range) || dependency.id === release.id || seen.has(dependency.id)) {
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

async function buildAuthoringSuite() {
  const pluginIds = [
    'proprium.narrative', 'proprium.knowledge', 'proprium.research', 'proprium.paired-writing',
    'proprium.diagnostics', 'proprium.speaker', 'proprium.semantic', 'proprium.publishing',
  ];
  const sourceRoot = resolve(process.env.PROPRIUM_AUTHORING_PLUGIN_SOURCE_DIR ?? resolve(root, 'plugins'));
  const sourceRootReal = await realpath(sourceRoot);
  const wit = resolve(process.env.PROPRIUM_PLUGIN_V2_WIT ?? resolve(root, 'app/src/browser/proprium/plugin-runtime/wit-v2/main.wit'));
  const worldName = 'proprium:plugin/plugin@2.0.0';
  const jco = process.platform === 'win32' ? 'jco.cmd' : resolve(root, 'node_modules/.bin/jco');
  const plugins = [...(previousRegistry?.plugins ?? [])];
  const knownVersions = new Set(plugins.map(entry => `${entry.id}@${entry.version}`));
  const buildBase = resolve(output, '.authoring-build');
  await mkdir(buildBase, { recursive: true });

  for (const pluginId of pluginIds) {
    const slug = pluginId.slice('proprium.'.length);
    const pluginDirectory = resolve(sourceRoot, slug);
    const metadataPath = resolve(pluginDirectory, 'plugin.json');
    const sourcePath = resolve(pluginDirectory, 'guest.ts');
    const pluginDirectoryStat = await lstat(pluginDirectory);
    const metadataStat = await lstat(metadataPath);
    const sourceStat = await lstat(sourcePath);
    if (!pluginDirectoryStat.isDirectory() || pluginDirectoryStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.isSymbolicLink() ||
        !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`${pluginId} requires regular plugin.json and guest.ts files`);
    }
    const pluginDirectoryReal = await realpath(pluginDirectory);
    const metadataReal = await realpath(metadataPath);
    const sourceReal = await realpath(sourcePath);
    for (const candidate of [pluginDirectoryReal, metadataReal, sourceReal]) {
      const rel = relative(sourceRootReal, candidate);
      if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`${pluginId} source escaped the plugin source directory`);
    }
    let metadata;
    try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(metadataReal))); }
    catch { throw new Error(`${pluginId}/plugin.json must be valid UTF-8 JSON`); }
    const required = ['schema', 'id', 'version', 'abi', 'capabilities', 'actions', 'ui', 'asset_groups', 'dependencies'];
    const allowed = new Set(required);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some(key => !allowed.has(key)) ||
        required.some(key => !Object.hasOwn(metadata, key))) {
      throw new Error(`${pluginId}/plugin.json has missing or unknown fields`);
    }
    if (metadata.schema !== 'proprium.plugin/v2' || metadata.id !== pluginId || metadata.abi !== 'proprium.component/v2' ||
        typeof metadata.version !== 'string' || !VERSION.test(metadata.version)) {
      throw new Error(`${pluginId}/plugin.json identity, schema, ABI or SemVer is invalid`);
    }
    for (const field of ['capabilities', 'actions', 'ui', 'asset_groups', 'dependencies']) {
      if (!Array.isArray(metadata[field])) throw new Error(`${pluginId}/plugin.json ${field} must be an array`);
    }
    if (metadata.actions.length === 0) throw new Error(`${pluginId}/plugin.json must declare at least one implemented typed action`);
    if (metadata.capabilities.some(value => typeof value !== 'string' || value.length === 0) || new Set(metadata.capabilities).size !== metadata.capabilities.length) {
      throw new Error(`${pluginId}/plugin.json capabilities must be unique nonempty strings`);
    }
    const actions = new Set();
    for (const action of metadata.actions) {
      const actionFields = ['plugin_id', 'action_id', 'schema_version', 'effect', 'input_schema', 'output_schema',
        'required_capabilities', 'callers', 'requires_user_gesture'];
      const actionAllowed = new Set([...actionFields, 'caller_plugins']);
      if (!action || typeof action !== 'object' || Array.isArray(action) ||
          Object.keys(action).some(key => !actionAllowed.has(key)) || actionFields.some(key => !Object.hasOwn(action, key)) ||
          action.plugin_id !== pluginId || typeof action.action_id !== 'string' || action.action_id.length === 0 ||
          action.schema_version !== 1 || !['read', 'propose'].includes(action.effect) ||
          !action.input_schema || typeof action.input_schema !== 'object' || Array.isArray(action.input_schema) ||
          !action.output_schema || typeof action.output_schema !== 'object' || Array.isArray(action.output_schema) ||
          !Array.isArray(action.required_capabilities) || action.required_capabilities.some(value => typeof value !== 'string' || !metadata.capabilities.includes(value)) ||
          new Set(action.required_capabilities).size !== action.required_capabilities.length ||
          !Array.isArray(action.callers) || action.callers.length === 0 || action.callers.some(value => !['ui', 'mcp', 'plugin'].includes(value)) || new Set(action.callers).size !== action.callers.length ||
          typeof action.requires_user_gesture !== 'boolean' ||
          (action.caller_plugins !== undefined && (!Array.isArray(action.caller_plugins) ||
            action.caller_plugins.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u.test(value)) ||
            new Set(action.caller_plugins).size !== action.caller_plugins.length)) ||
          actions.has(action.action_id)) {
        throw new Error(`${pluginId}/plugin.json contains an invalid or duplicate action descriptor`);
      }
      for (const schema of [action.input_schema, action.output_schema]) {
        if (schema.type !== 'object' || schema.additionalProperties !== false) throw new Error(`${pluginId} action ${action.action_id} schemas must be closed object schemas`);
      }
      actions.add(action.action_id);
    }
    const surfaceIds = new Set();
    for (const surface of metadata.ui) {
      if (!surface || typeof surface !== 'object' || Array.isArray(surface) || Object.keys(surface).length !== 5 ||
          !['id', 'kind', 'title', 'context', 'body'].every(key => Object.hasOwn(surface, key)) ||
          typeof surface.id !== 'string' || surface.id.length === 0 || surfaceIds.has(surface.id) ||
          typeof surface.kind !== 'string' || typeof surface.title !== 'string' ||
          !surface.context || typeof surface.context !== 'object' || Array.isArray(surface.context) ||
          !surface.body || typeof surface.body !== 'object' || Array.isArray(surface.body)) {
        throw new Error(`${pluginId}/plugin.json contains an invalid or duplicate UI surface`);
      }
      surfaceIds.add(surface.id);
    }
    const assetGroupIds = new Set();
    for (const group of metadata.asset_groups) {
      if (assetGroupIds.has(group?.id)) throw new Error(`${pluginId}/plugin.json repeats an asset group id`);
      assetGroupIds.add(group?.id);
      await copyAssetGroup(group, pluginId, path => readPluginAsset(pluginDirectoryReal, path.slice(`proprium/${slug}/`.length)));
    }
    const dependencies = new Set();
    for (const dependency of metadata.dependencies) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency) || Object.keys(dependency).length !== 2 ||
          typeof dependency.id !== 'string' || !/^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u.test(dependency.id) ||
          !validDependencyRange(dependency.range) || dependency.id === pluginId || dependencies.has(dependency.id)) {
        throw new Error(`${pluginId}/plugin.json has an invalid dependency`);
      }
      dependencies.add(dependency.id);
    }
    const releaseKey = `${pluginId}@${metadata.version}`;
    if (knownVersions.has(releaseKey)) throw new Error(`${releaseKey} already exists; plugin versions are immutable`);

    const buildDir = await mkdtemp(join(buildBase, `${slug}-`));
    try {
      const componentPath = resolve(buildDir, 'plugin.component.wasm');
      execFileSync(jco, ['componentize', sourceReal, '--wit', wit, '--world-name', worldName, '--disable', 'all', '--bundle', '-o', componentPath], {
        cwd: pluginDirectoryReal, stdio: 'inherit', env: componentizeEnvironment,
      });
      const component = new Uint8Array(await readFile(componentPath));
      if (component.byteLength < 8 || component[0] !== 0 || component[1] !== 0x61 || component[2] !== 0x73 || component[3] !== 0x6d) {
        throw new Error(`${pluginId} build did not produce a WebAssembly component`);
      }
      const componentDigest = digest(component);
      const releaseDirectory = `proprium/${slug}/${metadata.version}`;
      const entrypoint = `${releaseDirectory}/${componentDigest}/plugin.component.wasm`;
      await persistImmutable(entrypoint, component);
      const manifest = {
        schema: metadata.schema,
        id: metadata.id,
        version: metadata.version,
        abi: metadata.abi,
        entrypoint,
        capabilities: metadata.capabilities,
        artifacts: [{ path: entrypoint, bytes: component.byteLength, sha256: componentDigest, mediaType: 'application/wasm' }],
        actions: metadata.actions,
        ui: metadata.ui,
        asset_groups: metadata.asset_groups,
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      if (manifestBytes.byteLength > 512 * 1024) throw new Error(`${pluginId} manifest exceeds the 512 KiB limit`);
      const manifestSignature = sign(null, manifestBytes, publisherPrivateKey);
      const manifestDigest = digest(manifestBytes);
      const manifestPath = `${releaseDirectory}/manifest/${manifestDigest}.json`;
      await persistImmutable(manifestPath, manifestBytes);
      plugins.push({
        id: pluginId,
        version: metadata.version,
        manifestPath,
        manifestSha256: manifestDigest,
        manifestSignature: manifestSignature.toString('base64'),
        publisherKey: rawEd25519PublicKey(publisherPrivateKey).toString('base64'),
        dependencies: metadata.dependencies,
      });
      knownVersions.add(releaseKey);
      console.log(`Built signed ${pluginId}@${metadata.version}: ${entrypoint}`);
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  }
  validateDependencyGraph(plugins);
  await publishRegistry(plugins, registryVersion);
}

function validDependencyRange(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  if (value === '*') return true;
  const match = /^(\^|~)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  return match !== null && VERSION.test(`${match[2]}${match[4] ? `-${match[4]}` : ''}`);
}

if (buildMode === 'authoring') {
  await buildAuthoringSuite();
} else {
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
  execFileSync(jco, ['componentize', pluginSource, '--wit', wit, '--world-name', 'proprium:plugin/plugin@1.0.0', '--disable', 'all', '--bundle', '-o', componentPath], {
    cwd: root, stdio: 'inherit', env: componentizeEnvironment,
  });
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
  console.log(`Built plugin: ${pluginId}@${pluginVersion}`);
  console.log(`Immutable artifact: ${entrypoint}`);
  console.log(`Immutable manifest: ${manifestPath}`);
  await publishRegistry(plugins, pluginVersion);
}
