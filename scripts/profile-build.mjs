#!/usr/bin/env node

import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePackagePrefix = '@scriptorium/module-';
const moduleIds = ['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp'];
const sourceSpecifier = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](@scriptorium\/module-[^"']+)["']/g;

function usage() {
  console.error('Usage: node scripts/profile-build.mjs (--profile <core|full> | --modules-json <json-array>) [--out <dir>] [--verify-deploy <dir>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let profileName;
let requestedModuleIds;
let outputDirectory;
let deployDirectory;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--profile' && args[index + 1]) profileName = args[++index];
  else if (args[index] === '--modules-json' && args[index + 1]) {
    try { requestedModuleIds = JSON.parse(args[++index]); }
    catch { usage(); }
  }
  else if (args[index] === '--out' && args[index + 1]) outputDirectory = path.resolve(args[++index]);
  else if (args[index] === '--verify-deploy' && args[index + 1]) deployDirectory = path.resolve(args[++index]);
  else if (args[index] === '--help') usage();
  else usage();
}
if ((profileName === undefined) === (requestedModuleIds === undefined) ||
    (profileName !== undefined && !['core', 'full'].includes(profileName)) ||
    (requestedModuleIds !== undefined && (!Array.isArray(requestedModuleIds) ||
      requestedModuleIds.some((id) => typeof id !== 'string' || !moduleIds.includes(id)) ||
      new Set(requestedModuleIds).size !== requestedModuleIds.length))) usage();
const hostedComposition = requestedModuleIds !== undefined;
const selectedProfileName = hostedComposition ? 'hosted' : profileName;

let requestedIds;
if (hostedComposition) {
  requestedIds = requestedModuleIds;
} else {
  const profilePath = path.join(root, 'profiles', `${profileName}.json`);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  if (profile.profile !== profileName || !Array.isArray(profile.modules) || profile.modules.some((id) => typeof id !== 'string')) {
    throw new Error(`Invalid profile manifest: ${profilePath}`);
  }
  requestedIds = profile.modules;
}
if (new Set(requestedIds).size !== requestedIds.length || requestedIds.some((id) => !moduleIds.includes(id))) {
  throw new Error(`Profile ${selectedProfileName} has an unknown or duplicate module ID`);
}

const packageById = new Map();
const pendingIds = [...requestedIds];
while (pendingIds.length > 0) {
  const id = pendingIds.shift();
  if (packageById.has(id)) continue;
  const packagePath = path.join(root, 'modules', id, 'package.json');
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    throw new Error(`Profile ${selectedProfileName} selects ${id}, but ${packagePath} is not installed`);
  }
  const expectedName = `${modulePackagePrefix}${id}`;
  if (packageManifest.name !== expectedName || !packageManifest.scriptoriumModule || packageManifest.scriptoriumModule.id !== id) {
    throw new Error(`${packagePath} must declare name ${expectedName} and scriptoriumModule metadata for ${id}`);
  }
  const metadata = packageManifest.scriptoriumModule;
  if ((metadata.serverEntry !== undefined && !packageManifest.exports?.['.']) ||
      (metadata.browserEntry !== undefined && !packageManifest.exports?.['./browser'])) {
    throw new Error(`${packagePath} must export the declared server and browser entry points`);
  }
  for (const dependency of metadata.dependencies ?? []) {
    if (packageManifest.dependencies?.[`${modulePackagePrefix}${dependency}`] === undefined) {
      throw new Error(`${expectedName} metadata requires ${dependency}, but its package dependencies do not`);
    }
  }
  packageById.set(id, { packageName: expectedName, metadata });
  for (const dependency of metadata.dependencies ?? []) pendingIds.push(dependency);
}

const packageManifests = [...packageById.values()].map(({ metadata }) => metadata);

const runtimePath = pathToFileURL(path.join(root, 'packages', 'module-runtime', 'dist', 'index.js')).href;
let resolveModulePlan;
try {
  ({ resolveModulePlan } = await import(runtimePath));
} catch (error) {
  throw new Error(`Build @scriptorium/module-runtime before generating profiles: ${error instanceof Error ? error.message : String(error)}`);
}
const plan = resolveModulePlan(packageManifests, requestedIds);
const includedIds = [...plan.order];
const includedManifests = includedIds.map((id) => packageById.get(id).metadata);

if (!hostedComposition) {
  const profilePackagePath = path.join(root, 'profiles', profileName, 'package.json');
  try {
    const profilePackage = JSON.parse(await readFile(profilePackagePath, 'utf8'));
    const directModuleDependencies = Object.keys({ ...profilePackage.dependencies, ...profilePackage.optionalDependencies })
      .filter((name) => name.startsWith(modulePackagePrefix) && moduleIds.includes(name.slice(modulePackagePrefix.length))).sort();
    const expectedDependencies = requestedIds.map((id) => `${modulePackagePrefix}${id}`).sort();
    if (JSON.stringify(directModuleDependencies) !== JSON.stringify(expectedDependencies)) {
      throw new Error(`Profile package ${profilePackage.name} module dependencies do not match ${profileName}.json`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (hostedComposition && !outputDirectory && !deployDirectory) throw new Error('Hosted composition generation requires --out');
const output = outputDirectory ?? (hostedComposition ? undefined : path.join(root, 'profiles', profileName, 'generated'));
const metadataJson = JSON.stringify({ profile: selectedProfileName, modules: includedManifests }, null, 2) + '\n';
const serverImports = includedIds.map((id) => {
  const { packageName, metadata } = packageById.get(id);
  const loader = `  ${JSON.stringify(id)}: async (context) => {\n` +
    `    const module = await import(${JSON.stringify(packageName)});\n` +
    `    if (typeof module.createModule !== "function") throw new TypeError(${JSON.stringify(`${packageName} must export createModule(context)`)});\n` +
    `    return module.createModule(context);\n` +
    `  },`;
  const worker = metadata.workerEntry === undefined ? undefined :
    `  ${JSON.stringify(id)}: path.resolve(fileURLToPath(new URL("../", import.meta.resolve(${JSON.stringify(packageName)}))), ${JSON.stringify(metadata.workerEntry)}),`;
  const directory = `  ${JSON.stringify(id)}: fileURLToPath(new URL("../", import.meta.resolve(${JSON.stringify(packageName)}))),`;
  return { loader, worker, directory };
});
const serverSource = [
  'import path from "node:path";',
  'import { fileURLToPath } from "node:url";',
  `export const profile = ${JSON.stringify(selectedProfileName)};`,
  `export const moduleManifests = Object.freeze(${JSON.stringify(includedManifests, null, 2)});`,
  'export const moduleLoaders = Object.freeze({',
  ...serverImports.map((entry) => entry.loader),
  '});',
  'export const moduleDirectories = Object.freeze({',
  ...serverImports.map((entry) => entry.directory),
  '});',
  'export const moduleWorkerEntries = Object.freeze({',
  ...serverImports.filter((entry) => entry.worker).map((entry) => entry.worker),
  '});',
  '',
].join('\n');

const browserImports = includedIds.flatMap((id) => {
  const item = packageById.get(id);
  if (!item.metadata.browserEntry) return [];
  const specifier = `${item.packageName}/browser`;
  return [`  ${JSON.stringify(id)}: async () => {\n` +
    `    const module = await import(${JSON.stringify(specifier)});\n` +
    `    if (!module.browserModule) throw new TypeError(${JSON.stringify(`${specifier} must export browserModule`)});\n` +
    '    return module.browserModule;\n' +
    '  },'];
});
const browserSource = [
  `export const profile = ${JSON.stringify(selectedProfileName)};`,
  'export const moduleBrowserLoaders = Object.freeze({',
  ...browserImports,
  '});',
  '',
].join('\n');

if (output) {
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(path.join(output, 'module-manifests.json'), metadataJson),
    writeFile(path.join(output, 'server.mjs'), serverSource),
    writeFile(path.join(output, 'browser.mjs'), browserSource),
  ]);
}

if (deployDirectory) await verifyDeploy(deployDirectory, selectedProfileName, includedIds);
console.log(output
  ? `Generated ${selectedProfileName} module composition: ${includedIds.length} module(s) in ${output}`
  : `Verified ${selectedProfileName} deployed module composition: ${includedIds.length} module(s)`);

async function verifyDeploy(directory, selectedProfile, selectedIds) {
  const nodeModules = path.join(directory, 'node_modules');
  const installedIds = await findInstalledModulePackages(nodeModules);
  const expectedIds = [...selectedIds].sort();
  const actualIds = [...installedIds].sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error(`Deployed ${selectedProfile} module package closure mismatch: expected [${expectedIds}], found [${actualIds}]`);
  }
  const selectedNames = new Set(expectedIds.map((id) => `${modulePackagePrefix}${id}`));
  await scanImports(directory, selectedNames);
}

async function readPackageManifest(packageDirectory) {
  try { return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')); }
  catch { return undefined; }
}

async function findInstalledModulePackages(nodeModules) {
  const installedIds = new Set();
  const rootDirectory = await realpath(nodeModules).catch(() => undefined);
  if (!rootDirectory) return installedIds;
  const pending = [nodeModules];
  const visited = new Set();
  while (pending.length) {
    const directory = pending.pop();
    const resolvedDirectory = await realpath(directory).catch(() => undefined);
    if (!resolvedDirectory || !isWithin(rootDirectory, resolvedDirectory) || visited.has(resolvedDirectory)) continue;
    visited.add(resolvedDirectory);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const itemPath = path.join(directory, entry.name);
      if (path.basename(directory) === '@scriptorium' && entry.name.startsWith('module-')) {
        const manifest = await readPackageManifest(itemPath);
        if (manifest?.name?.startsWith(modulePackagePrefix)) {
          const id = manifest.name.slice(modulePackagePrefix.length);
          if (id !== 'runtime') installedIds.add(id);
        }
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const target = await realpath(itemPath).catch(() => undefined);
        if (target && isWithin(rootDirectory, target)) pending.push(itemPath);
      }
    }
  }
  return installedIds;
}

async function scanImports(directory, selectedNames) {
  const ignored = new Set(['.git', 'coverage', 'test-results']);
  const rootDirectory = await realpath(directory);
  const visited = new Set();
  await scanDirectory(directory, rootDirectory, selectedNames, ignored, visited);
}

async function scanDirectory(directory, rootDirectory, selectedNames, ignored, visited) {
  const resolvedDirectory = await realpath(directory).catch(() => undefined);
  if (!resolvedDirectory || !isWithin(rootDirectory, resolvedDirectory) || visited.has(resolvedDirectory)) return;
  visited.add(resolvedDirectory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    const target = entry.isSymbolicLink() ? await realpath(filePath).catch(() => undefined) : filePath;
    if (!target || !isWithin(rootDirectory, target)) continue;
    const targetStats = await stat(target).catch(() => undefined);
    if (targetStats?.isDirectory()) {
      if (!ignored.has(entry.name)) await scanDirectory(filePath, rootDirectory, selectedNames, ignored, visited);
      continue;
    }
    if (!targetStats?.isFile() || !/\.(?:c?js|mjs|jsx)$/.test(entry.name)) continue;
    const source = await readFile(filePath, 'utf8');
    sourceSpecifier.lastIndex = 0;
    for (const match of source.matchAll(sourceSpecifier)) {
      const specifier = match[1];
      const packageName = specifier.split('/').slice(0, 2).join('/');
      const moduleId = packageName.slice(modulePackagePrefix.length);
      if (packageName === `${modulePackagePrefix}runtime`) continue;
      if (!moduleIds.includes(moduleId)) throw new Error(`Deployed profile imports unknown module package ${specifier} from ${filePath}`);
      if (!selectedNames.has(packageName)) {
        throw new Error(`Deployed profile imports excluded optional module ${specifier} from ${filePath}`);
      }
    }
  }
}

function isWithin(rootDirectory, candidate) {
  const relative = path.relative(rootDirectory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
