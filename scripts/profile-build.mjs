#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePackagePrefix = '@scriptorium/module-';
const moduleIds = ['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp'];
const sourceSpecifier = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](@scriptorium\/module-[^"']+)["']/g;

function usage() {
  console.error('Usage: node scripts/profile-build.mjs --profile <core|full> [--out <dir>] [--verify-deploy <dir>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let profileName;
let outputDirectory;
let deployDirectory;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--profile' && args[index + 1]) profileName = args[++index];
  else if (args[index] === '--out' && args[index + 1]) outputDirectory = path.resolve(args[++index]);
  else if (args[index] === '--verify-deploy' && args[index + 1]) deployDirectory = path.resolve(args[++index]);
  else if (args[index] === '--help') usage();
  else usage();
}
if (!profileName || !['core', 'full'].includes(profileName)) usage();

const profilePath = path.join(root, 'profiles', `${profileName}.json`);
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
if (profile.profile !== profileName || !Array.isArray(profile.modules) || profile.modules.some((id) => typeof id !== 'string')) {
  throw new Error(`Invalid profile manifest: ${profilePath}`);
}
if (new Set(profile.modules).size !== profile.modules.length || profile.modules.some((id) => !moduleIds.includes(id))) {
  throw new Error(`Profile ${profileName} has an unknown or duplicate module ID`);
}

const packageManifests = [];
const packageById = new Map();
for (const id of profile.modules) {
  const packagePath = path.join(root, 'modules', id, 'package.json');
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    throw new Error(`Profile ${profileName} selects ${id}, but ${packagePath} is not installed`);
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
  const dependencies = { ...packageManifest.dependencies, ...packageManifest.optionalDependencies };
  for (const dependency of metadata.dependencies ?? []) {
    if (dependencies[`${modulePackagePrefix}${dependency}`] === undefined) {
      throw new Error(`${expectedName} metadata requires ${dependency}, but its package dependencies do not`);
    }
  }
  packageManifests.push(metadata);
  packageById.set(id, { packageName: expectedName, metadata });
}

const runtimePath = pathToFileURL(path.join(root, 'packages', 'module-runtime', 'dist', 'index.js')).href;
let resolveModulePlan;
try {
  ({ resolveModulePlan } = await import(runtimePath));
} catch (error) {
  throw new Error(`Build @scriptorium/module-runtime before generating profiles: ${error instanceof Error ? error.message : String(error)}`);
}
resolveModulePlan(packageManifests, profile.modules);

const profilePackagePath = path.join(root, 'profiles', profileName, 'package.json');
try {
  const profilePackage = JSON.parse(await readFile(profilePackagePath, 'utf8'));
  const directModuleDependencies = Object.keys({ ...profilePackage.dependencies, ...profilePackage.optionalDependencies })
    .filter((name) => name.startsWith(modulePackagePrefix) && moduleIds.includes(name.slice(modulePackagePrefix.length))).sort();
  const expectedDependencies = profile.modules.map((id) => `${modulePackagePrefix}${id}`).sort();
  if (JSON.stringify(directModuleDependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error(`Profile package ${profilePackage.name} module dependencies do not match ${profileName}.json`);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const output = outputDirectory ?? path.join(root, 'profiles', profileName, 'generated');
const metadataJson = JSON.stringify({ profile: profileName, modules: packageManifests }, null, 2) + '\n';
const serverImports = profile.modules.map((id) => {
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
  `export const profile = ${JSON.stringify(profileName)};`,
  `export const moduleManifests = Object.freeze(${JSON.stringify(packageManifests, null, 2)});`,
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

const browserImports = profile.modules.flatMap((id) => {
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
  `export const profile = ${JSON.stringify(profileName)};`,
  'export const moduleBrowserLoaders = Object.freeze({',
  ...browserImports,
  '});',
  '',
].join('\n');

await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(path.join(output, 'module-manifests.json'), metadataJson),
  writeFile(path.join(output, 'server.mjs'), serverSource),
  writeFile(path.join(output, 'browser.mjs'), browserSource),
]);

if (deployDirectory) await verifyDeploy(deployDirectory, profileName, profile.modules);
console.log(`Generated ${profileName} module composition: ${profile.modules.length} module(s) in ${output}`);

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
  const pending = [nodeModules];
  const visited = new Set();
  while (pending.length) {
    const directory = pending.pop();
    if (visited.has(directory)) continue;
    visited.add(directory);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const itemPath = path.join(directory, entry.name);
      if (path.basename(directory) === '@scriptorium' && entry.name.startsWith('module-')) {
        const manifest = await readPackageManifest(itemPath);
        if (manifest?.name?.startsWith(modulePackagePrefix)) installedIds.add(manifest.name.slice(modulePackagePrefix.length));
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(itemPath);
    }
  }
  return installedIds;
}

async function scanImports(directory, selectedNames) {
  const ignored = new Set(['.git', 'coverage', 'test-results']);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) await scanImports(filePath, selectedNames);
      continue;
    }
    if (!entry.isFile() || !/\.(?:c?js|mjs|jsx)$/.test(entry.name)) continue;
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
