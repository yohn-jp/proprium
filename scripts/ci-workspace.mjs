#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_TYPECHECK_SCOPES, TYPECHECK_TARGETS, UNIT_TARGETS, WORKSPACES } from './ci-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectoryNames = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target']);
const workspaceById = new Map(WORKSPACES.map((workspace) => [workspace.id, workspace]));
const workspaceByName = new Map();
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packageManifests = new Map();

for (const workspace of WORKSPACES) {
  const manifestPath = path.join(root, workspace.path, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.name || workspaceByName.has(manifest.name)) throw new Error(`Workspace package name is missing or duplicated at ${workspace.path}`);
  workspaceByName.set(manifest.name, workspace.id);
  packageManifests.set(workspace.id, manifest);
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd = root) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.signal) throw new Error(`${command} was terminated by ${result.signal}`);
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function dependenciesOf(id) {
  const manifest = packageManifests.get(id);
  const dependencies = new Set();
  for (const section of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const dependencyId = workspaceByName.get(name);
      if (dependencyId) dependencies.add(dependencyId);
    }
  }
  return [...dependencies];
}

function buildDependencies(ids) {
  const required = new Set();
  const scanned = new Set();
  const activeScan = new Set();
  function collect(id) {
    if (activeScan.has(id)) throw new Error(`Workspace build dependency cycle includes ${id}`);
    if (scanned.has(id)) return;
    activeScan.add(id);
    for (const dependencyId of dependenciesOf(id)) {
      required.add(dependencyId);
      collect(dependencyId);
    }
    activeScan.delete(id);
    scanned.add(id);
  }
  for (const id of ids) collect(id);

  const ordered = [];
  const built = new Set();
  const activeBuild = new Set();
  function order(id) {
    if (built.has(id)) return;
    if (activeBuild.has(id)) throw new Error(`Workspace build dependency cycle includes ${id}`);
    activeBuild.add(id);
    for (const dependencyId of dependenciesOf(id)) {
      if (required.has(dependencyId)) order(dependencyId);
    }
    activeBuild.delete(id);
    built.add(id);
    ordered.push(id);
  }
  for (const id of required) order(id);
  return ordered;
}

function buildTargets(ids) {
  const targets = buildDependencies(ids);
  buildWorkspaceTargets(targets);
  return targets;
}

function buildWorkspaceTargets(targets) {
  for (const id of targets) {
    const manifest = packageManifests.get(id);
    if (!manifest.scripts?.build) fail(`Workspace dependency ${manifest.name} has no build script`);
    run('pnpm', ['--filter', manifest.name, 'run', 'build']);
  }
}

function getUnitTarget(targetId) {
  const target = UNIT_TARGETS.find(({ id }) => id === targetId);
  if (!target) fail(`Unknown unit target ${targetId}; expected one of ${UNIT_TARGETS.map(({ id }) => id).join(', ')}`);
  return target;
}

function getTypecheckTarget(targetId) {
  const target = TYPECHECK_TARGETS.find(({ id }) => id === targetId);
  if (!target) fail(`Unknown production typecheck target ${targetId}; expected one of ${TYPECHECK_TARGETS.map(({ id }) => id).join(', ')}`);
  return target;
}

async function prepareUnit(targetId) {
  const target = getUnitTarget(targetId);
  if (target.path === '.') {
    if (target.id !== 'root' || !rootManifest.scripts?.['test:scripts']) fail('Root unit target requires package.json scripts.test:scripts');
    if (!rootManifest.scripts.test?.includes('pnpm run test:scripts')) fail('Root pnpm test must include the scripts test target');
    if (rootManifest.devDependencies?.['@scriptorium/api'] !== 'workspace:*') fail('Root scripts tests require the API workspace dependency');
    run('pnpm', ['--filter', '@scriptorium/api...', 'build']);
    console.log('Unit target root: built API and its declared workspace dependencies.');
    return;
  }
  const workspace = WORKSPACES.find(({ id, path: workspacePath }) => id === target.id && workspacePath === target.path);
  if (!workspace) fail(`Unit target ${targetId} does not match a canonical workspace path`);
  const manifest = packageManifests.get(workspace.id);
  if (!manifest.scripts?.test) fail(`Workspace unit target ${targetId} has no package.json test script`);
  const dependencies = buildTargets([workspace.id]);
  console.log(`Unit target ${targetId}: built dependency workspaces [${dependencies.join(', ')}]`);
}

async function runUnit(targetId) {
  const target = getUnitTarget(targetId);
  if (target.path === '.') {
    if (target.id !== 'root' || !rootManifest.scripts?.['test:scripts']) fail('Root unit target requires package.json scripts.test:scripts');
    if (!rootManifest.scripts.test?.includes('pnpm run test:scripts')) fail('Root pnpm test must include the scripts test target');
    console.log('Unit target root: using package.json script test:scripts');
    run('pnpm', ['run', 'test:scripts']);
    return;
  }
  const workspace = WORKSPACES.find(({ id, path: workspacePath }) => id === target.id && workspacePath === target.path);
  if (!workspace) fail(`Unit target ${targetId} does not match a canonical workspace path`);
  const manifest = packageManifests.get(workspace.id);
  if (!manifest.scripts?.test) fail(`Workspace unit target ${targetId} has no package.json test script`);
  run('pnpm', ['--filter', manifest.name, 'run', 'test']);
}

async function prepareUnitGroup(targets) {
  const ids = targets.split(',');
  ids.forEach(getUnitTarget);
  const workspaceIds = ids.filter(id => id !== 'root');
  if (ids.includes('root')) workspaceIds.push('api');
  const dependencies = buildDependencies(workspaceIds);
  if (ids.includes('root') && !dependencies.includes('api')) dependencies.push('api');
  buildWorkspaceTargets(dependencies);
}

function typecheckWorkspaceIds(targetId) {
  const target = getTypecheckTarget(targetId);
  const ids = target.workspaces;
  const invalid = ids.filter((id) => !workspaceById.has(id));
  if (invalid.length) fail(`Production typecheck target ${targetId} has unknown workspaces: ${invalid.join(', ')}`);
  return ids;
}

async function prepareTypecheck(targetId) {
  const ids = typecheckWorkspaceIds(targetId);
  const dependencies = buildTargets(ids);
  console.log(`Production typecheck ${targetId}: built dependency workspaces [${dependencies.join(', ')}]`);
}

async function runTypecheck(targetId) {
  const ids = typecheckWorkspaceIds(targetId);
  for (const id of ids) {
    const manifest = packageManifests.get(id);
    if (manifest.scripts?.typecheck) run('pnpm', ['--filter', manifest.name, 'run', 'typecheck']);
    else if (manifest.scripts?.build) run('pnpm', ['--filter', manifest.name, 'run', 'build']);
    else fail(`Workspace ${manifest.name} has neither typecheck nor build script`);
  }
}

function testTypecheckWorkspaceIds(scope) {
  if (!TEST_TYPECHECK_SCOPES.includes(scope)) fail(`Unknown test typecheck scope ${scope}; expected one of ${TEST_TYPECHECK_SCOPES.join(', ')}`);
  return scope === 'app-e2e'
    ? ['app', 'api']
    : WORKSPACES.filter(({ path: workspacePath }) => scope === 'packages'
      ? workspacePath.startsWith('packages/')
      : workspacePath.startsWith('modules/')).map(({ id }) => id);
}

async function prepareTestTypecheck(scope) {
  if (scope === 'app-e2e') {
    if (rootManifest.devDependencies?.['@scriptorium/api'] !== 'workspace:*') fail('App/E2E typecheck requires the API workspace dependency');
    run('pnpm', ['--filter', '@scriptorium/api...', 'build']);
    console.log('Test typecheck app-e2e: built API and its declared workspace dependencies.');
    return;
  }
  const roots = testTypecheckWorkspaceIds(scope);
  const dependencies = buildTargets(roots);
  console.log(`Test typecheck ${scope}: built dependency workspaces [${dependencies.join(', ')}]`);
}

async function runTestTypecheck(scope) {
  testTypecheckWorkspaceIds(scope);
  run(process.execPath, ['scripts/typecheck-tests.mjs', scope]);
}

async function listFiles(directory, { excludeGenerated = true } = {}) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && (!excludeGenerated || !generatedDirectoryNames.has(entry.name))) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(directory);
  return files;
}

function normalizePath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//u, '');
}

function testFilePattern(pattern, relativePath) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u').test(relativePath);
}

function sourcePatternFromRunnerPattern(pattern) {
  const normalized = normalizePath(pattern);
  if (!normalized.startsWith('dist/')) return normalized;
  return normalized.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts');
}

function runnerPatterns(script, label) {
  const segment = script.split(/\s*&&\s*/u).find((part) => part.includes('--test'));
  if (!segment) fail(`${label} has no Node test runner command`);
  const tokens = segment.slice(segment.indexOf('--test') + '--test'.length).trim().split(/\s+/u).filter(Boolean);
  const patterns = tokens.map((token) => token.replace(/^['"]|['"]$/gu, '')).filter((token) => !token.startsWith('--'));
  if (patterns.length === 0) fail(`${label} has no explicit test file pattern`);
  return patterns.map(sourcePatternFromRunnerPattern);
}

function isUnitTestFile(filename) {
  return /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/u.test(filename);
}

async function assertTestPatterns({ label, script, files, relativeTo }) {
  const patterns = runnerPatterns(script, label);
  const relativeFiles = files.map((filename) => normalizePath(path.relative(relativeTo, filename)));
  const missing = relativeFiles.filter((filename) => !patterns.some((pattern) => testFilePattern(pattern, filename)));
  if (missing.length) fail(`${label} does not execute these test files: ${missing.join(', ')}`);
  if (relativeFiles.length === 0) fail(`${label} has no test files`);
  return relativeFiles.length;
}

function assertUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate) fail(`${label} contains duplicate ${duplicate}`);
}

async function checkCoverage() {
  const actualWorkspacePaths = ['app'];
  for (const area of ['packages', 'modules']) {
    const entries = await readdir(path.join(root, area), { withFileTypes: true });
    actualWorkspacePaths.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => `${area}/${entry.name}`));
  }
  const declaredPaths = WORKSPACES.map(({ path: workspacePath }) => workspacePath);
  const missingTargets = actualWorkspacePaths.filter((workspacePath) => !declaredPaths.includes(workspacePath));
  const unknownTargets = declaredPaths.filter((workspacePath) => !actualWorkspacePaths.includes(workspacePath));
  assertUnique(declaredPaths, 'WORKSPACES');
  if (missingTargets.length || unknownTargets.length) {
    fail(`Workspace manifest coverage mismatch: unregistered=[${missingTargets.join(', ')}], missing=[${unknownTargets.join(', ')}]`);
  }

  const unitIds = UNIT_TARGETS.map(({ id }) => id);
  const unitPaths = UNIT_TARGETS.map(({ path: workspacePath }) => workspacePath);
  assertUnique(unitIds, 'UNIT_TARGETS ids');
  assertUnique(unitPaths, 'UNIT_TARGETS paths');
  if (unitPaths.length !== declaredPaths.length + 1 || !unitPaths.includes('.')) fail('UNIT_TARGETS must cover every workspace exactly once and include the root scripts target');
  for (const workspace of WORKSPACES) {
    const target = UNIT_TARGETS.find(({ id, path: workspacePath }) => id === workspace.id && workspacePath === workspace.path);
    if (!target) fail(`UNIT_TARGETS has no path-matched target for ${workspace.id} (${workspace.path})`);
    const manifest = packageManifests.get(workspace.id);
    if (!manifest.scripts?.test) fail(`Workspace ${workspace.id} lacks package.json scripts.test`);
  }
  const rootTarget = UNIT_TARGETS.find(({ id, path: workspacePath }) => id === 'root' && workspacePath === '.');
  if (!rootTarget || !rootManifest.scripts?.['test:scripts'] || !rootManifest.scripts.test?.includes('pnpm run test:scripts')) {
    fail('The root unit target must use package.json scripts.test:scripts and remain part of pnpm test');
  }

  const typecheckedIds = TYPECHECK_TARGETS.flatMap(({ workspaces }) => workspaces);
  assertUnique(TYPECHECK_TARGETS.map(({ id }) => id), 'TYPECHECK_TARGETS ids');
  assertUnique(typecheckedIds, 'TYPECHECK_TARGETS workspace membership');
  const missingTypechecks = WORKSPACES.map(({ id }) => id).filter((id) => !typecheckedIds.includes(id));
  const unknownTypechecks = typecheckedIds.filter((id) => !workspaceById.has(id));
  if (missingTypechecks.length || unknownTypechecks.length) {
    fail(`Production typecheck coverage mismatch: missing=[${missingTypechecks.join(', ')}], unknown=[${unknownTypechecks.join(', ')}]`);
  }
  assertUnique(TEST_TYPECHECK_SCOPES, 'TEST_TYPECHECK_SCOPES');
  if (JSON.stringify([...TEST_TYPECHECK_SCOPES].sort()) !== JSON.stringify(['app-e2e', 'modules', 'packages'])) {
    fail(`Unexpected test typecheck scopes: ${TEST_TYPECHECK_SCOPES.join(', ')}`);
  }

  let testFiles = 0;
  for (const target of UNIT_TARGETS) {
    const packageRoot = path.join(root, target.path);
    const manifest = target.path === '.' ? rootManifest : packageManifests.get(target.id);
    const testScript = target.path === '.' ? manifest.scripts?.['test:scripts'] : manifest.scripts?.test;
    if (!testScript) fail(`Unit target ${target.id} has no package.json test script`);
    const testDirectory = path.join(packageRoot, target.path === '.' ? 'scripts' : '.');
    const selectedFiles = (await listFiles(testDirectory)).filter(isUnitTestFile);
    testFiles += await assertTestPatterns({
      label: `Unit target ${target.id}`,
      script: testScript,
      files: selectedFiles,
      relativeTo: packageRoot,
    });
  }

  console.log(`Coverage PASS: ${WORKSPACES.length} workspaces, ${UNIT_TARGETS.length} unit targets, ${TYPECHECK_TARGETS.length} production typecheck groups, ${TEST_TYPECHECK_SCOPES.length} test typecheck scopes, ${testFiles} test/spec files mapped to package scripts.`);
}

const [command, targetId, scopeOrTarget, ...extra] = process.argv.slice(2);
if (extra.length || !command) {
  fail('Usage: node scripts/ci-workspace.mjs <prepare|unit|typecheck|test-types|coverage> [kind] [target]');
}
if (command === 'prepare' && targetId === 'unit' && scopeOrTarget) await prepareUnit(scopeOrTarget);
else if (command === 'prepare' && targetId === 'unit-group' && scopeOrTarget) await prepareUnitGroup(scopeOrTarget);
else if (command === 'prepare' && targetId === 'typecheck' && scopeOrTarget) await prepareTypecheck(scopeOrTarget);
else if (command === 'prepare' && targetId === 'test-types' && scopeOrTarget) await prepareTestTypecheck(scopeOrTarget);
else if (command === 'unit' && targetId && !scopeOrTarget) await runUnit(targetId);
else if (command === 'typecheck' && targetId && !scopeOrTarget) await runTypecheck(targetId);
else if (command === 'test-types' && targetId && !scopeOrTarget) await runTestTypecheck(targetId);
else if (command === 'coverage' && !targetId && !scopeOrTarget) await checkCoverage();
else fail('Usage: node scripts/ci-workspace.mjs <prepare|unit|typecheck|test-types|coverage> [kind] [target]');
