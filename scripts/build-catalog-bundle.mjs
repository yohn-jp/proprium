#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trustedModuleData } from './hosted-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function parseArgs(argv) {
  let outputDirectory;
  let allowDirty = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out-dir' && argv[index + 1]) outputDirectory = path.resolve(argv[++index]);
    else if (argv[index] === '--allow-dirty') allowDirty = true;
    else if (argv[index] === '--help') {
      console.log('Usage: node scripts/build-catalog-bundle.mjs --out-dir <directory> [--allow-dirty]');
      process.exit(0);
    } else throw new Error('Usage: node scripts/build-catalog-bundle.mjs --out-dir <directory> [--allow-dirty]');
  }
  if (!outputDirectory) throw new Error('An external --out-dir is required for generated resolver artifacts');
  const relative = path.relative(root, outputDirectory);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Resolver artifacts must be emitted outside the producer checkout');
  }
  return { outputDirectory, allowDirty };
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function sourceStatus() {
  const producerRevision = gitOutput(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(producerRevision)) throw new Error('Producer HEAD is not an immutable Git revision');
  const sourceTreeClean = gitOutput(['status', '--porcelain']) === '';
  return { producerRevision, sourceTreeClean };
}

function buildWorkspace() {
  const result = spawnSync('corepack', ['pnpm', 'build'], {
    cwd: root,
    env: { ...process.env, SCRIPTORIUM_PROFILE: 'core' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Producer build exited with status ${String(result.status)}`);
}

async function loadEsbuild() {
  const requireFromApp = createRequire(path.join(root, 'app/package.json'));
  const requireFromVite = createRequire(requireFromApp.resolve('vite/package.json'));
  // Resolve the compiler through the frozen app toolchain, never an orphaned
  // highest-version directory left in a package store by another installation.
  return import(pathToFileURL(requireFromVite.resolve('esbuild')).href);
}

async function createBundle(outputDirectory, producerRevision, sourceTreeClean) {
  const trustedModules = await trustedModuleData();
  const trustedModuleBytes = Buffer.from(canonicalJson(trustedModules), 'utf8');
  const trustedModuleDigest = sha256(trustedModuleBytes);
  const entryPath = path.join(root, 'buildkit/.build-catalog-entry.mjs');
  const resolverPath = path.join(root, 'packages/module-runtime/src/build-catalog.ts');
  const trustedLiteral = JSON.stringify(trustedModuleBytes.toString('utf8'));
  const entry = [
    'import { resolveBuildCatalogSelection as resolveTrustedCatalog } from "../packages/module-runtime/src/build-catalog.ts";',
    'import { persistenceForModules } from "../scripts/composition-persistence.mjs";',
    'import { MODULE_PERSISTENCE_FORMATS } from "../packages/module-runtime/src/persistence-formats.ts";',
    `const trustedModules = JSON.parse(${trustedLiteral});`,
    'export function resolveBuildCatalogSelection(catalog, requestedModuleIds) {',
    '  return resolveTrustedCatalog(catalog, requestedModuleIds, trustedModules);',
    '}',
    'export function resolveCompositionPersistence(selectedModuleIds) {',
    '  return persistenceForModules(selectedModuleIds, MODULE_PERSISTENCE_FORMATS);',
    '}',
    '',
  ].join('\n');

  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, entry);
  try {
    const esbuild = await loadEsbuild();
    const bundlePath = path.join(outputDirectory, 'build-catalog.mjs');
    const declarationPath = path.join(outputDirectory, 'build-catalog.d.mts');
    await mkdir(outputDirectory, { recursive: true });
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      alias: { '@scriptorium/contracts': path.join(root, 'packages/contracts/src/index.ts') },
      treeShaking: true,
      legalComments: 'none',
      charset: 'ascii',
      minify: false,
      logLevel: 'silent',
    });
    const bundleBytes = await readFile(bundlePath);
    const bundleText = bundleBytes.toString('utf8');
    if (/\bnode:/u.test(bundleText) || /\bprocess\./u.test(bundleText) || /\brequire\s*\(/u.test(bundleText)) {
      throw new Error('Generated producer resolver contains a Node-only dependency');
    }

    const declaration = [
      'export type ProducerResourceAmounts = {',
      '  cpuMilli: number;',
      '  memoryMiB: number;',
      '  ephemeralStorageMiB: number;',
      '};',
      'export type ProducerResolvedModule = { id: string; version: string; artifactDigest: string };',
      'export type ProducerBuildCatalogSelection = {',
      '  requestedModules: string[];',
      '  resolvedModules: ProducerResolvedModule[];',
      '  resourceRequirements: ProducerResourceAmounts;',
      '  moduleOrder: string[];',
      '};',
      'export declare function resolveBuildCatalogSelection(',
      '  catalog: unknown,',
      '  requestedModuleIds: readonly string[],',
      '): ProducerBuildCatalogSelection;',
      'export declare function resolveCompositionPersistence(selectedModuleIds: readonly string[]): {',
      '  contractVersion: "scriptorium-persistence/v1";',
      '  readable: { formatId: string; versions: number[] }[];',
      '  writable: { formatId: string; version: number }[];',
      '};',
      '',
    ].join('\n');
    const declarationBytes = Buffer.from(declaration, 'utf8');
    await writeFile(declarationPath, declarationBytes);

    const sourcePaths = [
      'packages/module-runtime/src/build-catalog.ts',
      'packages/module-runtime/src/module-plan.ts',
      'packages/module-runtime/src/runtime-error.ts',
      'packages/contracts/src/index.ts',
      'scripts/hosted-build.mjs',
      'scripts/build-catalog-bundle.mjs',
      'scripts/composition-persistence.mjs',
      'packages/module-runtime/src/persistence-formats.ts',
    ];
    const sourceDigests = await Promise.all(sourcePaths.map(async (sourcePath) => ({
      path: sourcePath,
      digest: sha256(await readFile(path.join(root, sourcePath))),
    })));
    const provenance = {
      schemaVersion: 'scriptorium-build-catalog-resolver-provenance/v1',
      producerRevision,
      sourceTreeClean,
      bundlePath: 'build-catalog.mjs',
      bundleDigest: sha256(bundleBytes),
      declarationPath: 'build-catalog.d.mts',
      declarationDigest: sha256(declarationBytes),
      trustedModuleDigest,
      trustedModules: trustedModules.map(({ manifest, artifactDigest }) => ({
        id: manifest.id,
        version: manifest.version,
        artifactDigest,
      })),
      sourceDigests,
    };
    await writeFile(path.join(outputDirectory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    return provenance;
  } finally {
    await rm(entryPath, { force: true });
  }
}

async function main() {
  const { outputDirectory, allowDirty } = parseArgs(process.argv.slice(2));
  const { producerRevision, sourceTreeClean } = sourceStatus();
  if (!sourceTreeClean && !allowDirty) throw new Error('Resolver provenance requires a clean producer checkout (or explicit development-only --allow-dirty)');
  buildWorkspace();
  const provenance = await createBundle(outputDirectory, producerRevision, sourceTreeClean);
  console.log(`Generated ${provenance.bundlePath}: ${provenance.bundleDigest}`);
  console.log(`Generated ${provenance.declarationPath}: ${provenance.declarationDigest}`);
  console.log(`Bound resolver artifacts to producer ${producerRevision}${sourceTreeClean ? '' : ' (dirty development source)'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Resolver bundle generation failed');
    process.exitCode = 1;
  });
}
