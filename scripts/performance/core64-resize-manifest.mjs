import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { arch, platform } from 'node:os';

const [outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error('Usage: node scripts/performance/core64-resize-manifest.mjs <new-manifest.json>');

const root = process.cwd();
const output = resolve(outputArg);
try {
  await access(output);
  throw new Error(`Refusing to overwrite existing runtime manifest: ${output}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const artifactRoots = [
  'packages/contracts/dist',
  'packages/module-runtime/dist',
  'packages/core/dist',
  'packages/api/dist',
  'app/dist',
  'profiles/core/generated',
];

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`Unexpected non-file build artifact: ${absolute}`);
  }
  return files;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourceCommit = git('rev-parse', 'HEAD');
const referenceCommit = 'e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47';
const comparedPaths = ['app', 'packages', 'modules', 'profiles', 'Dockerfile', 'package.json', 'pnpm-lock.yaml'];
const changedProductionPaths = git('diff', '--name-only', referenceCommit, sourceCommit, '--', ...comparedPaths);
if (changedProductionPaths) {
  throw new Error(`Pinned runtime differs from the e8aa production tree: ${changedProductionPaths}`);
}
const productionIdentityTrees = Object.fromEntries([
  'app/src',
  'packages/core/src',
  'packages/api/src',
  'profiles/core',
].map(path => [path, git('rev-parse', `${sourceCommit}:${path}`)]));
const productionDirtyPaths = git('status', '--porcelain', '--untracked-files=all', '--',
  'app/src', 'packages/core/src', 'packages/api/src', 'profiles/core', ':(exclude)profiles/core/generated')
  .split('\n').filter(Boolean);
if (productionDirtyPaths.length) {
  throw new Error(`Production source paths are dirty: ${productionDirtyPaths.join(', ')}`);
}
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pnpmVersion = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim();
const artifacts = [];
for (const artifactRoot of artifactRoots) {
  const absoluteRoot = join(root, artifactRoot);
  await access(absoluteRoot);
  const rootFiles = (await filesUnder(absoluteRoot)).sort();
  if (!rootFiles.length) throw new Error(`Core build artifact root is empty: ${artifactRoot}`);
  for (const file of rootFiles) {
    const bytes = await readFile(file);
    artifacts.push({ path: relative(root, file).split('\\').join('/'), bytes: bytes.length, sha256: sha256(bytes) });
  }
}
if (!artifacts.length) throw new Error('Core build artifact inventory is empty');

const manifest = {
  schemaVersion: 1,
  runtimeRoot: root,
  sourceCommit,
  productionIdentity: {
    referenceCommit,
    comparedPaths,
    identical: true,
    trees: productionIdentityTrees,
  },
  dirtyProductionPaths: productionDirtyPaths,
  profile: 'core',
  buildCommand: 'SCRIPTORIUM_PROFILE=core pnpm build',
  toolchain: {
    node: process.version,
    pnpm: pnpmVersion,
    packageManager: packageJson.packageManager ?? null,
    platform: platform(),
    arch: arch(),
  },
  artifactRoots,
  files: artifacts,
  totals: {
    fileCount: artifacts.length,
    bytes: artifacts.reduce((total, file) => total + file.bytes, 0),
  },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
