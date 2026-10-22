#!/usr/bin/env node
import { persistenceForModules } from './composition-persistence.mjs';
export { persistenceForModules } from './composition-persistence.mjs';

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { productionClosure } from './runtime-package-closure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleIds = ['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp', 'search'];
const modulePrefix = '@scriptorium/module-';
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const zeroResources = Object.freeze({ cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 });
// These are admission allocation tiers used by the owned Praetorium disposable
// cluster configuration, not measured workload minima. Base allocation covers
// the API and modules without worker processes; bounded workers and the local
// semantic model pool are charged once through shared groups.
const baseResources = Object.freeze({ cpuMilli: 250, memoryMiB: 256, ephemeralStorageMiB: 512 });
const workerResourceGroup = Object.freeze({ id: 'worker-runtime', resources: Object.freeze({
  cpuMilli: 1000, memoryMiB: 4096, ephemeralStorageMiB: 512,
}) });
const semanticResourceGroup = Object.freeze({ id: 'semantic-models', resources: Object.freeze({
  cpuMilli: 1000, memoryMiB: 2048, ephemeralStorageMiB: 4096,
}) });
const resourceProfiles = Object.freeze([
  Object.freeze({ id: 'small', cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 1024 }),
  Object.freeze({ id: 'balanced', cpuMilli: 2000, memoryMiB: 4096, ephemeralStorageMiB: 8192 }),
  Object.freeze({ id: 'large', cpuMilli: 4000, memoryMiB: 8192, ephemeralStorageMiB: 16384 }),
]);
// WorkerSupervisor applies these shared runtime-wide limits. The producer ABI
// stores the limits on each worker module descriptor, so the same defaults are
// repeated there as provenance; they are not per-module worker pools.
const workerLimits = Object.freeze({
  maxConcurrentJobs: 8,
  maxQueuedJobs: 8,
  maxWorkerServices: 8,
  maxConcurrentServiceJobs: 1,
  maxQueuedServiceJobs: 4,
});
const sourceRoots = ['app', 'packages', 'modules', 'profiles', 'scripts', 'buildkit'];
const sourceFilesAtRoot = ['LICENSE', 'package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json'];
const recipeFiles = [
  'Dockerfile',
  'package.json',
  'pnpm-workspace.yaml',
  'scripts/profile-build.mjs',
  'scripts/profile-package.mjs',
  'scripts/hosted-build.mjs',
  'scripts/composition-persistence.mjs',
  'scripts/hosted-smoke.mjs',
  'scripts/runtime-package-closure.mjs',
  'app/vite.config.ts',
  'packages/module-runtime/src/module-plan.ts',
  'packages/module-runtime/src/build-catalog.ts',
  'packages/module-runtime/src/persistence-formats.ts',
  'buildkit/frontend/main.go',
  'buildkit/frontend/go.mod',
  'buildkit/frontend/go.sum',
];

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isWithin(rootDirectory, candidate) {
  const relative = path.relative(rootDirectory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function walkFiles(directory, relativeDirectory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    // Performance probes are developer-only tooling, not Hosted Producer inputs.
    // Keep rejecting symlinks in every included source directory.
    if (relative === 'scripts/performance' ||
        entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated' ||
        entry.name === '.git' || entry.name === 'coverage' || entry.name === 'build' || entry.name === '.turbo') continue;
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Source tree contains an untrusted symlink: ${relative}`);
    if (info.isDirectory()) await walkFiles(absolute, relative, output);
    else if (info.isFile() && !entry.name.endsWith('.tsbuildinfo')) output.push({ absolute, relative });
  }
}

async function sourceInventory() {
  const files = [];
  for (const name of sourceFilesAtRoot) {
    const absolute = path.join(root, name);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid source input: ${name}`);
      files.push({ absolute, relative: name });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (name !== '.dockerignore' && name !== 'LICENSE') throw error;
    }
  }
  for (const name of sourceRoots) {
    const absolute = path.join(root, name);
    try {
      if (!(await lstat(absolute)).isDirectory()) throw new Error(`Invalid source directory: ${name}`);
      await walkFiles(absolute, name, files);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  return files;
}

async function inventoryDigest(files) {
  const entries = await Promise.all(files.map(async ({ absolute, relative }) => ({
    path: relative,
    sha256: createHash('sha256').update(await readFile(absolute)).digest('hex'),
  })));
  return sha256(Buffer.from(canonicalJson(entries), 'utf8'));
}

async function fileDigest(relative) {
  return sha256(await readFile(path.join(root, relative)));
}

export async function calculateBuildDigests() {
  const sourceDigest = await inventoryDigest(await sourceInventory());
  const recipeEntries = await Promise.all(recipeFiles.map(async (relative) => {
    const absolute = path.join(root, relative);
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid recipe input: ${relative}`);
      return { path: relative, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') };
    } catch (error) {
      if (relative !== 'Dockerfile' || error?.code !== 'ENOENT') throw error;
      const bakedDockerfileDigest = process.env.SCRIPTORIUM_DOCKERFILE_SHA256;
      if (!/^[a-f0-9]{64}$/u.test(bakedDockerfileDigest ?? '')) throw new Error('Build Kit image is missing its Dockerfile source digest');
      return { path: relative, sha256: bakedDockerfileDigest };
    }
  }));
  recipeEntries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const recipeDigest = sha256(Buffer.from(canonicalJson(recipeEntries), 'utf8'));
  const lockDigest = await fileDigest('pnpm-lock.yaml');
  return { sourceDigest, recipeDigest, lockDigest };
}

async function packageArtifactDigest(packageDirectory) {
  const manifestPath = path.join(packageDirectory, 'package.json');
  const entries = [{ absolute: manifestPath, relative: 'package.json' }];
  await walkPackageDist(path.join(packageDirectory, 'dist'), 'dist', entries);
  entries.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const inventory = await Promise.all(entries.map(async ({ absolute, relative }) => [
    relative,
    createHash('sha256').update(await readFile(absolute)).digest('hex'),
  ]));
  return sha256(Buffer.from(JSON.stringify(inventory), 'utf8'));
}

async function walkPackageDist(directory, relativeDirectory, output) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(relativeDirectory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Module artifact contains a symlink: ${relative}`);
    if (info.isDirectory()) await walkPackageDist(absolute, relative, output);
    else if (info.isFile()) output.push({ absolute, relative });
    else throw new Error(`Module artifact contains a special file: ${relative}`);
  }
}

export function resourceDeclarationFor(manifest) {
  const sharedResourceGroupIds = [];
  if (manifest.workerEntry) sharedResourceGroupIds.push(workerResourceGroup.id);
  if (manifest.id === 'semantic' && manifest.workerEntry) sharedResourceGroupIds.push(semanticResourceGroup.id);
  return {
    // No module-specific memory estimate is present in shipped manifests; the
    // API floor and shared worker/model allocations cover the closure without
    // claiming a measured per-module minimum.
    exclusiveResources: { ...zeroResources },
    sharedResourceGroupIds,
    workerLimits: manifest.workerEntry ? { ...workerLimits } : {},
  };
}

export async function trustedModuleData() {
  const trusted = [];
  for (const id of moduleIds) {
    const packageDirectory = path.join(root, 'modules', id);
    const packageManifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
    const manifest = packageManifest.scriptoriumModule;
    if (packageManifest.name !== `${modulePrefix}${id}` || manifest?.id !== id || typeof manifest.version !== 'string') {
      throw new Error(`Invalid shipped module manifest for ${id}`);
    }
    trusted.push({
      manifest,
      artifactDigest: await packageArtifactDigest(packageDirectory),
      contractRange: '^1',
      conflicts: [],
      ...resourceDeclarationFor(manifest),
    });
  }
  return trusted;
}

async function moduleRuntimeResolver() {
  const modulePath = pathToFileURL(path.join(root, 'packages/module-runtime/dist/index.js')).href;
  try {
    const imported = await import(modulePath);
    if (typeof imported.resolveBuildCatalogSelection !== 'function') throw new Error('catalog resolver export is absent');
    return imported.resolveBuildCatalogSelection;
  } catch (error) {
    throw new Error(`Build @scriptorium/module-runtime before hosted catalog generation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function catalogFor(input, trustedModules) {
  return {
    contractVersion: 'scriptorium-build/v1',
    producerRevision: input.producerRevision,
    runtimeBaseDigest: input.runtimeBaseDigest,
    buildKitDigest: input.buildKitDigest,
    recipeDigest: input.recipeDigest,
    lockDigest: input.lockDigest,
    sourceDigest: input.sourceDigest,
    supportedPlatforms: ['linux/amd64'],
    modules: trustedModules.map(({ manifest, artifactDigest, contractRange, conflicts, exclusiveResources, sharedResourceGroupIds, workerLimits }) => ({
      id: manifest.id,
      version: manifest.version,
      artifactDigest,
      requires: [...manifest.dependencies].sort(),
      conflicts: [...conflicts].sort(),
      contractRange,
      exclusiveResources,
      sharedResourceGroupIds: [...sharedResourceGroupIds].sort(),
      workerLimits,
    })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    baseResources: { ...baseResources },
    sharedResourceGroups: [
      { id: workerResourceGroup.id, resources: { ...workerResourceGroup.resources } },
      { id: semanticResourceGroup.id, resources: { ...semanticResourceGroup.resources } },
    ],
    resourceProfiles: resourceProfiles.map((profile) => ({ ...profile })),
  };
}

function validateBuildInput(value) {
  const keys = ['contractVersion', 'producerRevision', 'runtimeBaseDigest', 'buildKitDigest', 'recipeDigest', 'sourceDigest', 'lockDigest', 'requestedModules', 'resolvedModules', 'platform', 'options'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('BuildInput must match scriptorium-build/v1 exactly');
  }
  if (value.contractVersion !== 'scriptorium-build/v1' || !revisionPattern.test(value.producerRevision) ||
      ['runtimeBaseDigest', 'buildKitDigest', 'recipeDigest', 'sourceDigest', 'lockDigest'].some((key) => !sha256Pattern.test(value[key])) ||
      value.platform !== 'linux/amd64' || !value.options || Object.keys(value.options).length !== 0 ||
      !Array.isArray(value.requestedModules) || !Array.isArray(value.resolvedModules) ||
      value.requestedModules.length > moduleIds.length || value.resolvedModules.length > moduleIds.length ||
      value.requestedModules.some((id) => typeof id !== 'string' || !moduleIds.includes(id)) ||
      new Set(value.requestedModules).size !== value.requestedModules.length) {
    throw new Error('BuildInput values are invalid or unsupported by this producer');
  }
  for (const module of value.resolvedModules) {
    if (!module || typeof module !== 'object' || Array.isArray(module) ||
        Object.keys(module).sort().join(',') !== 'artifactDigest,id,version' ||
        typeof module.id !== 'string' || !moduleIds.includes(module.id) || typeof module.version !== 'string' ||
        !sha256Pattern.test(module.artifactDigest)) throw new Error('BuildInput resolved module identity is invalid');
  }
  if (new Set(value.resolvedModules.map(({ id }) => id)).size !== value.resolvedModules.length) {
    throw new Error('BuildInput resolved module list contains duplicates');
  }
  return value;
}

function canonicalBuildInput(input) {
  return JSON.stringify({
    contractVersion: input.contractVersion,
    producerRevision: input.producerRevision,
    runtimeBaseDigest: input.runtimeBaseDigest,
    buildKitDigest: input.buildKitDigest,
    recipeDigest: input.recipeDigest,
    sourceDigest: input.sourceDigest,
    lockDigest: input.lockDigest,
    requestedModules: [...input.requestedModules].sort(),
    resolvedModules: [...input.resolvedModules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    platform: input.platform,
    options: {},
  });
}


function decodeInput(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('BuildInput encoding is invalid');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('BuildInput encoding is not canonical base64url');
  const input = validateBuildInput(JSON.parse(bytes.toString('utf8')));
  if (Buffer.from(canonicalBuildInput(input), 'utf8').toString('base64url') !== value) {
    throw new Error('BuildInput bytes are not canonical');
  }
  return input;
}

function validateRepositorySource(value, buildKitDigest) {
  const at = value.lastIndexOf('@');
  const repository = at > 0 ? value.slice(0, at) : '';
  const digest = at > 0 ? value.slice(at + 1) : '';
  if (!repository || digest !== buildKitDigest || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(repository)) {
    throw new Error('BuildKit frontend source does not match the immutable BuildInput digest');
  }
  return repository;
}

function parseFlags(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || !args[index + 1] || values[key] !== undefined) throw new Error('Invalid hosted build arguments');
    values[key] = args[++index];
  }
  return values;
}

function buildInputForCatalog(args, digests) {
  const producerRevision = args['--producer-revision'];
  const runtimeBaseDigest = args['--runtime-base-digest'];
  const buildKitDigest = args['--build-kit-digest'];
  if (!revisionPattern.test(producerRevision ?? '') || !sha256Pattern.test(runtimeBaseDigest ?? '') || !sha256Pattern.test(buildKitDigest ?? '')) {
    throw new Error('Catalog requires immutable producer revision and image digests');
  }
  return { contractVersion: 'scriptorium-build/v1', producerRevision, runtimeBaseDigest, buildKitDigest, ...digests };
}

export function assertCleanRevisionSnapshot({ head, status, producerRevision }) {
  if (!revisionPattern.test(producerRevision ?? '') || head !== producerRevision) {
    throw new Error('Catalog producerRevision must equal the checked out Git HEAD');
  }
  if (status !== '') throw new Error('Catalog must be generated from a clean producer checkout');
}

export async function assertCleanRevision(producerRevision) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0 || status.status !== 0) throw new Error('Could not inspect the producer Git checkout');
  assertCleanRevisionSnapshot({ head: head.stdout.trim(), status: status.stdout, producerRevision });
}

async function writeCatalog(args) {
  const digests = await calculateBuildDigests();
  const input = buildInputForCatalog(args, digests);
  await assertCleanRevision(input.producerRevision);
  const trustedModules = await trustedModuleData();
  const catalog = catalogFor(input, trustedModules);
  const resolver = await moduleRuntimeResolver();
  resolver(catalog, [], trustedModules);
  const output = args['--out'] ? path.resolve(args['--out']) : undefined;
  const bytes = Buffer.from(canonicalJson(catalog), 'utf8');
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
  } else {
    process.stdout.write(bytes);
    process.stdout.write('\n');
  }
}

async function scanNativeDependencies(nodeModulesDirectory) {
  const modulesRoot = await realpath(nodeModulesDirectory);
  const visitedDirectories = new Set();
  const seenIds = new Map();
  const nativePattern = /\.(?:node|wasm|so(?:\.[0-9]+)*|dylib|dll)$/iu;
  async function nearestPackage(filename) {
    let directory = path.dirname(filename);
    while (directory.startsWith(modulesRoot)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') return { directory, name: manifest.name, version: manifest.version };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return undefined;
  }
  async function visit(directory) {
    const resolvedDirectory = await realpath(directory).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!resolvedDirectory || (resolvedDirectory !== modulesRoot && !resolvedDirectory.startsWith(`${modulesRoot}${path.sep}`)) || visitedDirectories.has(resolvedDirectory)) return;
    visitedDirectories.add(resolvedDirectory);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename);
      if (info.isDirectory()) await visit(filename);
      else if (info.isSymbolicLink()) {
        const target = await realpath(filename).catch((error) => {
          if (error?.code === 'ENOENT') return undefined;
          throw error;
        });
        if (!target || !(target === modulesRoot || target.startsWith(`${modulesRoot}${path.sep}`))) continue;
        const targetInfo = await lstat(target);
        if (targetInfo.isDirectory()) await visit(filename);
        else if (targetInfo.isFile() && nativePattern.test(entry.name)) await record(filename, target);
      } else if (info.isFile() && nativePattern.test(entry.name)) await record(filename, filename);
    }
  }
  async function record(filename, bytesPath) {
    const owner = await nearestPackage(filename);
    if (!owner) throw new Error(`Native dependency has no owning package manifest: ${filename}`);
    const relative = path.relative(owner.directory, filename).split(path.sep).join('/');
    const id = `${owner.name}/${relative}`;
    if (id.length > 128) throw new Error(`Native dependency identity exceeds the platform contract: ${id}`);
    const dependency = { id, version: owner.version, artifactDigest: sha256(await readFile(bytesPath)) };
    const previous = seenIds.get(id);
    if (previous && canonicalJson(previous) !== canonicalJson(dependency)) throw new Error(`Conflicting native dependency identity: ${id}`);
    seenIds.set(id, dependency);
  }
  await visit(nodeModulesDirectory);
  return [...seenIds.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function moduleRecords(deployedDirectory, selectedIds) {
  const records = [];
  for (const id of selectedIds) {
    const packageDirectory = path.join(deployedDirectory, 'node_modules', '@scriptorium', `module-${id}`);
    const resolved = await realpath(packageDirectory);
    records.push({
      id,
      version: JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8')).version,
      artifactDigest: await packageArtifactDigest(resolved),
      packagePath: `/app/node_modules/@scriptorium/module-${id}`,
    });
  }
  return records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function runtimePackageRecords(deployedDirectory, serverIds) {
  const nodeModules = path.join(deployedDirectory, 'node_modules');
  const roots = [path.join(nodeModules, '@scriptorium/api'),
    ...serverIds.map((id) => path.join(nodeModules, '@scriptorium', `module-${id}`))];
  const closure = await productionClosure(roots);
  const lockBytes = await readFile(path.join(root, 'pnpm-lock.yaml'));
  const yamlUrl = pathToFileURL(path.join(root, 'node_modules/.pnpm/node_modules/yaml/dist/index.js'));
  const yaml = await import(yamlUrl.href);
  const lock = yaml.parseAllDocuments(lockBytes.toString('utf8'))
    .map((document) => document.toJS())
    .find((document) => document && typeof document === 'object' && document.snapshots && document.importers?.['packages/api']);
  if (!lock || typeof lock !== 'object' || !lock.importers || !lock.packages || !lock.snapshots) {
    throw new Error('Source pnpm lockfile does not contain the expected v9 package graph');
  }

  const workspaceByName = new Map();
  for (const importer of Object.keys(lock.importers)) {
    if (importer === '.') continue;
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(root, importer, 'package.json'), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (typeof manifest.name !== 'string') continue;
    const matches = workspaceByName.get(manifest.name) ?? [];
    matches.push(importer);
    workspaceByName.set(manifest.name, matches);
  }

  const pnpmStore = path.join(nodeModules, '.pnpm');
  const records = [];
  for (const item of closure.values()) {
    const matches = workspaceByName.get(item.name) ?? [];
    if (matches.length > 1) throw new Error(`Workspace package name is ambiguous in pnpm lockfile: ${item.name}`);
    let lockIdentity;
    let lockIntegrity = null;
    if (matches.length === 1) {
      lockIdentity = `workspace:${matches[0]}`;
    } else {
      const relative = path.relative(pnpmStore, item.directory);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Runtime package is outside the pnpm store and has no workspace lock identity: ${item.name}@${item.version}`);
      }
      const storeName = relative.split(path.sep)[0];
      const encodedName = item.name.startsWith('@') ? item.name.replace('/', '+') : item.name;
      const base = `${item.name}@${item.version}`;
      const storePrefix = `${encodedName}@${item.version}`;
      if (storeName !== storePrefix && !storeName.startsWith(`${storePrefix}_`)) {
        throw new Error(`Cannot bind installed package to its pnpm lock identity: ${storeName}`);
      }
      const peerSuffix = storeName === storePrefix ? '' : storeName.slice(storePrefix.length + 1)
        .split('_').map((peer) => `(${peer.replaceAll('+', '/')})`).join('');
      lockIdentity = `${base}${peerSuffix}`;
      if (!Object.hasOwn(lock.snapshots, lockIdentity)) {
        throw new Error(`Installed pnpm snapshot is missing from the source lockfile: ${lockIdentity}`);
      }
      const packageCandidates = Object.entries(lock.packages)
        .filter(([key]) => key === base || key.startsWith(`${base}(`));
      if (packageCandidates.length === 0) throw new Error(`Locked package is missing from source lockfile: ${base}`);
      const integrities = new Set(packageCandidates.map(([, value]) => value?.resolution?.integrity ?? null));
      if (integrities.size !== 1) throw new Error(`Locked package integrity is ambiguous: ${base}`);
      lockIntegrity = [...integrities][0];
      if (lockIntegrity !== null && (typeof lockIntegrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockIntegrity))) {
        throw new Error(`Locked package integrity is invalid: ${base}`);
      }
    }
    records.push({
      name: item.name,
      version: item.version,
      packagePath: `/${path.posix.join('app', path.relative(deployedDirectory, item.directory).split(path.sep).join('/'))}`,
      lockIdentity,
      lockIntegrity,
    });
  }
  records.sort((left, right) => left.packagePath < right.packagePath ? -1 : left.packagePath > right.packagePath ? 1 : 0);
  if (new Set(records.map(({ packagePath }) => packagePath)).size !== records.length) {
    throw new Error('Runtime package closure contains duplicate installed paths');
  }
  return { records, lockBytes };
}

export async function browserArtifactRecords(deployedDirectory, browserIds) {
  const records = await Promise.all(['', 'desktop', 'mobile'].map((ui) =>
    browserUiArtifactRecords(path.join(deployedDirectory, 'app/dist', ui), browserIds, ui)));
  return {
    files: records.flatMap(({ files }) => files).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    entryFile: records[0].entryFile,
    manifestPath: '/app/app/dist/.vite/manifest.json',
  };
}

export function browserManifestEntryFiles(manifest) {
  const applicationEntry = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest['index.html'] : undefined;
  const assetPath = (value, extension) => typeof value === 'string' &&
    new RegExp(`^assets/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\\.${extension}$`, 'u').test(value);
  if (!applicationEntry || applicationEntry.isEntry !== true || !assetPath(applicationEntry.file, 'js')) {
    throw new Error('Vite browser manifest has no content-hashed application entry');
  }
  const stylesheetFiles = Array.isArray(applicationEntry.css)
    ? applicationEntry.css
    : [manifest['style.css']?.file];
  if (stylesheetFiles.length === 0 || stylesheetFiles.some((file) => !assetPath(file, 'css'))) {
    throw new Error('Vite browser manifest has no content-hashed application stylesheet');
  }
  return { entryFile: applicationEntry.file, stylesheetFiles };
}

async function browserUiArtifactRecords(distDirectory, browserIds, ui) {
  const directory = await lstat(distDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`Browser build directory is not a real directory: ${distDirectory}`);
  const manifestPath = path.join(distDirectory, '.vite/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Vite browser manifest is invalid');
  }
  const applicationEntry = manifest['index.html'];
  const { entryFile } = browserManifestEntryFiles(manifest);
  const expectedDynamicSources = browserIds.map((id) => `../modules/${id}/dist/browser.js`).sort();
  const appManifest = JSON.parse(await readFile(path.join(root, 'app/package.json'), 'utf8'));
  const ionicPrefix = `../node_modules/.pnpm/@ionic+core@${appManifest.dependencies['@ionic/core']}/node_modules/@ionic/core/components/`;
  const isIonicRuntime = (source) => ui === 'mobile' && source.startsWith(ionicPrefix) && /^p-[A-Za-z0-9_-]+\.js$/u.test(source.slice(ionicPrefix.length));
  const actualDynamicSources = [...new Set(applicationEntry.dynamicImports ?? [])].filter((source) => !isIonicRuntime(source)).sort();
  if (canonicalJson(actualDynamicSources) !== canonicalJson(expectedDynamicSources)) {
    throw new Error('Vite application entry imports a different browser module closure');
  }
  const dynamicEntries = Object.entries(manifest).filter(([, item]) => item?.isDynamicEntry === true);
  const dynamicSources = dynamicEntries.map(([key, item]) => item.src ?? key).filter((source) => !isIonicRuntime(source)).sort();
  if (canonicalJson(dynamicSources) !== canonicalJson(expectedDynamicSources)) {
    throw new Error('Vite manifest contains an unexpected browser module chunk');
  }

  const visited = new Set();
  const reachable = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry || typeof entry.file !== 'string') throw new Error(`Vite manifest entry is missing: ${key}`);
    reachable.add(entry.file);
    for (const dependency of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) visit(dependency);
  }
  visit('index.html');
  const expectedJavascript = [...reachable].filter((file) => file.endsWith('.js')).sort();
  const manifestJavascript = [...new Set(Object.values(manifest).filter((item) => typeof item?.file === 'string' && item.file.endsWith('.js')).map(({ file }) => file))].sort();
  if (canonicalJson(expectedJavascript) !== canonicalJson(manifestJavascript)) {
    throw new Error('Vite manifest has JavaScript chunks outside the application entry closure');
  }

  const manifestFiles = [...new Set(Object.values(manifest).flatMap((item) => [
    ...(typeof item?.file === 'string' ? [item.file] : []),
    ...(Array.isArray(item?.css) ? item.css : []),
  ]).filter((file) => /\.(?:m?js|css)$/u.test(file)))].sort();
  const actualFiles = [];
  async function walk(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (relative === '' && (entry.name === '.vite' || (!ui && ['desktop', 'mobile'].includes(entry.name)))) continue;
      const relativePath = path.posix.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Browser build contains an unexpected symlink: ${relativePath}`);
      if (info.isDirectory()) await walk(absolute, relativePath);
      else if (info.isFile() && /\.(?:m?js|css)$/u.test(entry.name)) actualFiles.push(relativePath);
      else if (!info.isFile()) throw new Error(`Browser build contains a special file: ${relativePath}`);
    }
  }
  await walk(distDirectory);
  actualFiles.sort();
  if (canonicalJson(actualFiles) !== canonicalJson(manifestFiles)) {
    throw new Error('Vite output contains JavaScript or CSS files outside its manifest');
  }
  const files = [];
  for (const relative of manifestFiles) {
    const absolute = path.resolve(distDirectory, relative);
    if (!isWithin(distDirectory, absolute)) throw new Error(`Vite manifest path escapes browser output: ${relative}`);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Vite browser output is not a regular file: ${relative}`);
    files.push({ path: `/app/app/dist/${ui ? `${ui}/` : ""}${relative}`, sha256: sha256(await readFile(absolute)) });
  }
  return { files, entryFile, manifestPath: '/app/app/dist/.vite/manifest.json' };
}

async function writeComposition(input, catalog, selection, runtimeDirectory, trustedModules) {
  const packageRuntimeDirectory = path.join(runtimeDirectory, 'app');
  const selectedIds = selection.resolvedModules.map(({ id }) => id).sort();
  const trustedById = new Map(trustedModules.map((item) => [item.manifest.id, item]));
  const serverIds = selectedIds.filter((id) => trustedById.get(id).manifest.serverEntry !== undefined);
  const browserIds = selectedIds.filter((id) => trustedById.get(id).manifest.browserEntry !== undefined);
  const generatedServer = await import(pathToFileURL(path.join(packageRuntimeDirectory, 'generated/server.mjs')).href);
  const generatedBrowser = await import(pathToFileURL(path.join(packageRuntimeDirectory, 'generated/browser.mjs')).href);
  const sortedServerRegistryIds = Object.keys(generatedServer.moduleLoaders ?? {}).sort();
  const sortedBrowserRegistryIds = Object.keys(generatedBrowser.moduleBrowserLoaders ?? {}).sort();
  if (canonicalJson(sortedServerRegistryIds) !== canonicalJson(serverIds) ||
      canonicalJson(sortedBrowserRegistryIds) !== canonicalJson(browserIds) ||
      generatedServer.profile !== 'hosted' || generatedBrowser.profile !== 'hosted') {
    throw new Error('Generated server/browser registries do not match the selected module composition');
  }
  const { records: runtimePackages, lockBytes } = await runtimePackageRecords(packageRuntimeDirectory, serverIds);
  const { files: browserFiles, entryFile: browserEntryFile, manifestPath: browserManifestPath } = await browserArtifactRecords(packageRuntimeDirectory, browserIds);
  const moduleReports = await moduleRecords(packageRuntimeDirectory, selectedIds);
  if (canonicalJson(moduleReports.map(({ id, version, artifactDigest }) => ({ id, version, artifactDigest }))) !== canonicalJson(selection.resolvedModules)) {
    throw new Error('Deployed module package bytes do not match the immutable catalog identities');
  }
  const nativeDependencies = await scanNativeDependencies(path.join(packageRuntimeDirectory, 'node_modules'));
  const browserEntryPath = path.join(packageRuntimeDirectory, 'app/dist', browserEntryFile);
  const browserBundleDigest = sha256(await readFile(browserEntryPath));
  const journalSource = await readFile(path.join(root, 'app/src/storage/journal.ts'), 'utf8');
  const indexedDbVersion = Number(journalSource.match(/const DATABASE_VERSION = ([1-9][0-9]*);/u)?.[1]);
  if (indexedDbVersion !== 3) throw new Error('Browser recovery persistence version differs from the hosted compatibility declaration');
  const runtimeMetadata = {
    contractVersion: 'scriptorium-platform/v1',
    producerRevision: input.producerRevision,
    listener: { port: 3000 },
    paths: {
      liveness: '/health/live',
      readiness: '/health/ready',
      metadata: '/api/platform/v1/metadata',
      shutdown: '/api/platform/v1/quiesce',
      status: '/api/platform/v1/status',
      quiesce: '/api/platform/v1/quiesce',
      resume: '/api/platform/v1/resume',
    },
    shutdownTimeoutSeconds: 25,
  };
  const moduleRuntime = await import(pathToFileURL(path.join(root, 'packages/module-runtime/dist/index.js')).href);
  if (!Array.isArray(moduleRuntime.MODULE_PERSISTENCE_FORMATS)) throw new Error('Module persistence format descriptors are not exported by module-runtime');
  const persistence = persistenceForModules(selectedIds, moduleRuntime.MODULE_PERSISTENCE_FORMATS);
  const canonicalInput = canonicalBuildInput(input);
  const buildKey = sha256(Buffer.from(canonicalInput, 'utf8'));
  const compositionManifest = {
    schemaVersion: 'scriptorium-composition/v1',
    buildInput: JSON.parse(canonicalInput),
    buildKey,
    producerRevision: input.producerRevision,
    platform: input.platform,
    resolvedModules: selection.resolvedModules,
    server: { entry: 'app/launch.mjs', moduleIds: serverIds },
    browser: { entry: `app/app/dist/${browserEntryFile}`, moduleIds: browserIds },
    nativeDependencies,
    persistence,
    smoke: { id: 'scriptorium-hosted-runtime-v1', healthPath: '/health/ready', timeoutSeconds: 60 },
  };
  const report = {
    schemaVersion: 'scriptorium-build-report/v1',
    producerRevision: input.producerRevision,
    buildKey,
    catalogPath: '/usr/share/scriptorium/build-catalog.json',
    catalogDigest: sha256(Buffer.from(canonicalJson(catalog), 'utf8')),
    lockPath: '/usr/share/scriptorium/pnpm-lock.yaml',
    lockDigest: input.lockDigest,
    runtimeMetadataPath: '/usr/share/scriptorium/runtime-metadata.json',
    runtimeMetadataDigest: sha256(Buffer.from(canonicalJson(runtimeMetadata), 'utf8')),
    compositionManifestPath: '/usr/share/scriptorium/composition-manifest.json',
    persistence,
    browserPersistence: { indexedDbVersion, sourceDigest: sha256(journalSource) },
    modulePackages: moduleReports,
    runtimePackages,
    serverModuleIds: serverIds,
    browserModuleIds: browserIds,
    serverRegistryPath: '/app/generated/server.mjs',
    browserRegistryPath: '/app/generated/browser.mjs',
    browserManifestPath,
    browserEntryPath: `/app/app/dist/${browserEntryFile}`,
    browserBundleDigest,
    browserFiles,
    nativeDependencies,
  };
  const metadataDirectory = path.join(runtimeDirectory, 'usr/share/scriptorium');
  await mkdir(metadataDirectory, { recursive: true });
  await writeFile(path.join(metadataDirectory, 'pnpm-lock.yaml'), lockBytes);
  for (const [name, value] of Object.entries({
    'build-catalog.json': catalog,
    'runtime-metadata.json': runtimeMetadata,
    'composition-manifest.json': compositionManifest,
    'build-artifact-report.json': report,
  })) await writeFile(path.join(metadataDirectory, name), canonicalJson(value));
  return { runtimeMetadata, compositionManifest, report };
}

async function compose(inputBase64url, sourceRef) {
  const input = decodeInput(inputBase64url);
  const repository = validateRepositorySource(sourceRef, input.buildKitDigest);
  const bakedRevision = process.env.SCRIPTORIUM_PRODUCER_REVISION;
  if (!revisionPattern.test(bakedRevision ?? '') || bakedRevision !== input.producerRevision) {
    throw new Error('BuildInput producerRevision differs from the immutable Build Kit image revision');
  }
  const digests = await calculateBuildDigests();
  for (const key of ['sourceDigest', 'recipeDigest', 'lockDigest']) {
    if (input[key] !== digests[key]) throw new Error(`BuildInput ${key} does not match the source bytes in the Build Kit image`);
  }
  const runtimeBaseRef = `${repository}@${input.runtimeBaseDigest}`;
  const trustedModules = await trustedModuleData();
  const catalog = catalogFor({ ...input, ...digests }, trustedModules);
  const resolver = await moduleRuntimeResolver();
  const selection = resolver(catalog, input.requestedModules, trustedModules);
  const expectedResolved = selection.resolvedModules;
  const receivedResolved = [...input.resolvedModules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (canonicalJson(expectedResolved) !== canonicalJson(receivedResolved)) {
    throw new Error('BuildInput resolved modules do not match the producer resolver closure');
  }
  const runtimeDirectory = await makeHostedRuntime(input, selection, trustedModules);
  const { report } = await writeComposition(input, catalog, selection, runtimeDirectory, trustedModules);
  if (!runtimeBaseRef.endsWith(input.runtimeBaseDigest) || report.buildKey !== sha256(Buffer.from(canonicalBuildInput(input), 'utf8'))) {
    throw new Error('Hosted artifact identity binding failed');
  }
}

async function makeHostedRuntime(input, selection) {
  const runtimeDirectory = '/tmp/scriptorium-hosted-artifact';
  const appDirectory = path.join(runtimeDirectory, 'app');
  await rm(runtimeDirectory, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/profile-package.mjs'),
    '--modules-json', JSON.stringify(selection.requestedModules),
    '--out', appDirectory,
    '--prebuilt',
  ], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Hosted profile package exited with status ${String(result.status)}`);
  await mkdir(path.join(runtimeDirectory, 'usr/share/scriptorium'), { recursive: true });
  return runtimeDirectory;
}

export async function generateCatalog(input) {
  const trustedModules = await trustedModuleData();
  const catalog = catalogFor(input, trustedModules);
  const resolver = await moduleRuntimeResolver();
  resolver(catalog, [], trustedModules);
  return catalog;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'catalog') {
    await writeCatalog(parseFlags(rest));
    return;
  }
  if (command === 'compose') {
    const opts = parseFlags(rest);
    if (Object.keys(opts).sort().join(',') !== '--input-base64url,--source') throw new Error('compose requires --input-base64url and --source');
    await compose(opts['--input-base64url'], opts['--source']);
    return;
  }
  throw new Error('Usage: hosted-build.mjs catalog --producer-revision <sha> --runtime-base-digest <digest> --build-kit-digest <digest> [--out <file>] | compose --input-base64url <input> --source <repo@digest>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Hosted build failed');
    process.exitCode = 1;
  });
}
