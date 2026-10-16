#!/usr/bin/env node

import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const deniedCorePackage = /(?:^|[/.+@_-])(?:onnx(?:runtime(?:-(?:node|web))?)?|transformers?|tokenizers?|gpt-tokenizer|tiktoken|sentencepiece|fastembed|embedding|reranker|nlp|wink-nlp|natural|compromise|speaker(?:-attribution)?|diarization|pyannote|speechbrain|whisper|openai|anthropic|langchain|ollama)(?:$|[/.+@_-])/i;
const deniedBuildPackage = /(?:^|[/.+@_-])(?:typescript|tsx|@types|playwright|vitest|jest|eslint|prettier|turbo|vite|esbuild)(?:$|[/.+@_-])/i;
const packageImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;

function usage() {
  console.error('Usage: node scripts/audit-runtime-deps.mjs --node-modules <dir> [--production] [--dist <dir> ...]');
  process.exit(2);
}

const args = process.argv.slice(2);
let nodeModules;
let production = false;
const distDirs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--node-modules' && args[i + 1]) {
    nodeModules = path.resolve(args[++i]);
  } else if (args[i] === '--production') {
    production = true;
  } else if (args[i] === '--dist' && args[i + 1]) {
    distDirs.push(path.resolve(args[++i]));
  } else {
    usage();
  }
}
if (!nodeModules) usage();

const virtualStore = path.join(nodeModules, '.pnpm');
const storeStat = await lstat(virtualStore).catch(() => undefined);
if (!storeStat?.isDirectory()) {
  throw new Error(`pnpm virtual store not found: ${virtualStore}`);
}

async function packageDirsIn(nodeModulesDir) {
  const result = [];
  const entries = await readdir(nodeModulesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const scoped = await readdir(entryPath, { withFileTypes: true });
      for (const child of scoped) {
        if (child.isDirectory() && !child.isSymbolicLink()) {
          result.push(path.join(entryPath, child.name));
        }
      }
    } else if (entry.isDirectory()) {
      result.push(entryPath);
    }
  }
  return result;
}

const installed = new Map();
for (const entry of await readdir(virtualStore, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const virtualNodeModules = path.join(virtualStore, entry.name, 'node_modules');
  for (const packageDir of await packageDirsIn(virtualNodeModules)) {
    const manifestPath = path.join(packageDir, 'package.json');
    const manifestStat = await lstat(manifestPath).catch(() => undefined);
    if (!manifestStat?.isFile()) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!manifest.name || !manifest.version) continue;
    installed.set(`${manifest.name}@${manifest.version}`, manifest.name);
  }
}
if (installed.size === 0) {
  throw new Error(`no installed packages found in pnpm virtual store: ${virtualStore}`);
}

// A development workspace may contain optional modules without putting them in
// Core's production closure. Walk the actual installed dependency graph from
// the Core application roots; production mode still audits the entire image.
async function resolveDependency(directory, name) {
  let current = directory;
  while (true) {
    const candidate = path.join(current, 'node_modules', name);
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved) return resolved;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`missing runtime dependency ${name} from ${directory}`);
    current = parent;
  }
}
async function productionClosure(roots) {
  const closure = new Map();
  const seen = new Set();
  async function visit(directory) {
    const resolved = await realpath(directory);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const manifest = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8'));
    closure.set(`${manifest.name}@${manifest.version}`, manifest.name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await visit(await resolveDependency(resolved, dependency));
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      const optional = manifest.peerDependenciesMeta?.[dependency]?.optional === true;
      const location = await resolveDependency(resolved, dependency).catch(error => {
        if (!optional) throw error;
        return null;
      });
      if (location) await visit(location);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      const location = await resolveDependency(resolved, dependency).catch(() => null);
      if (location) await visit(location);
    }
  }
  for (const root of roots) await visit(root);
  return closure;
}
const checkedPackages = production ? installed : await productionClosure([
  path.resolve('packages/core'), path.resolve('packages/api'), path.resolve('app'),
]);
const forbidden = name => deniedCorePackage.test(name) || /^@scriptorium\/module-(?!runtime$)/.test(name);
const violations = [];
for (const [id, name] of checkedPackages) {
  if (forbidden(name) || (production && deniedBuildPackage.test(name))) {
    violations.push(`runtime dependency ${id}`);
  }
}

async function scanDist(current) {
  const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
    throw new Error(`cannot scan compiled output ${current}: ${error.message}`);
  });
  for (const entry of entries) {
    const filePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await scanDist(filePath);
    } else if (entry.isFile() && /\.(?:c?js|mjs|jsx)$/.test(entry.name)) {
      const source = await readFile(filePath, 'utf8');
      packageImport.lastIndex = 0;
      for (const match of source.matchAll(packageImport)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (forbidden(name) || (production && deniedBuildPackage.test(name))) {
          violations.push(`compiled import ${specifier} in ${filePath}`);
        }
      }
    }
  }
}

for (const distDir of distDirs) await scanDist(distDir);

if (violations.length > 0) {
  console.error(production ? 'Forbidden Core production dependency found:' : 'Forbidden Core dependency found:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`${production ? 'Production runtime' : 'Core'} dependency audit passed: ${checkedPackages.size} production dependency versions scanned.`);
console.log(`Packages: ${[...checkedPackages.keys()].sort().join(', ')}`);
