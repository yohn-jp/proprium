#!/usr/bin/env node
import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_TYPECHECK_SCOPES, WORKSPACES } from './ci-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectoryNames = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target']);
const scopeWorkspaces = new Map([
  ['app-e2e', ['app']],
  ['packages', WORKSPACES.filter(({ path: workspacePath }) => workspacePath.startsWith('packages/')).map(({ id }) => id)],
  ['modules', WORKSPACES.filter(({ path: workspacePath }) => workspacePath.startsWith('modules/')).map(({ id }) => id)],
]);

function assertScopesAreComplete() {
  const declared = [...scopeWorkspaces.keys()].sort();
  const configured = [...TEST_TYPECHECK_SCOPES].sort();
  if (new Set(configured).size !== configured.length || JSON.stringify(configured) !== JSON.stringify(declared)) {
    throw new Error(`Test typecheck scopes do not match executable scopes: declared [${configured.join(', ')}], available [${declared.join(', ')}]`);
  }
  const assigned = [...scopeWorkspaces.values()].flat();
  const duplicate = assigned.find((id, index) => assigned.indexOf(id) !== index);
  const missing = WORKSPACES.map(({ id }) => id).filter((id) => !assigned.includes(id));
  const unknown = assigned.filter((id) => !WORKSPACES.some((workspace) => workspace.id === id));
  if (duplicate || missing.length || unknown.length) {
    throw new Error(`Test typecheck scope coverage is invalid: duplicate=${duplicate ?? 'none'}, missing=[${missing.join(', ')}], unknown=[${unknown.join(', ')}]`);
  }
}

async function listTypeScriptFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !generatedDirectoryNames.has(entry.name)) await visit(absolute);
      else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) files.push(absolute);
    }
  }
  await visit(directory);
  return files;
}

function isTestFile(filename) {
  return /\.(?:test|spec)\.(?:ts|tsx)$/u.test(filename);
}

function sourceIncludes(scope, directory, parsed) {
  const names = new Set(parsed.fileNames.map((filename) => path.resolve(filename)));
  const missing = scope.testFiles.filter((filename) => !names.has(path.resolve(filename)));
  if (missing.length) throw new Error(`TypeScript input omitted test sources for ${directory}: ${missing.map((filename) => path.relative(root, filename)).join(', ')}`);
  if (parsed.fileNames.length === 0) throw new Error(`Typecheck scope ${scope.id} selected no TypeScript files in ${directory}`);
}

async function checkDirectory(scope, directory, { configDirectory = directory, include, testFiles }) {
  const configPath = path.join(root, configDirectory, 'tsconfig.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Required TypeScript config is missing: ${path.relative(root, configPath)}`);
    throw error;
  }
  config.exclude = [];
  config.include = include;
  const basePath = path.join(root, configDirectory);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, basePath);
  if (parsed.errors.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (filename) => filename,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }));
    throw new Error(`Could not parse TypeScript config for ${path.relative(root, configPath)}`);
  }
  sourceIncludes(scope, directory, { ...parsed, testFiles });
  const options = {
    ...parsed.options,
    jsx: parsed.options.jsx ?? ts.JsxEmit.ReactJSX,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
  };
  delete options.rootDir;
  delete options.outDir;
  delete options.tsBuildInfoFile;
  const program = ts.createProgram(parsed.fileNames, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (filename) => filename,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }));
    return { failed: true, fileCount: parsed.fileNames.length, testCount: testFiles.length };
  }
  return { failed: false, fileCount: parsed.fileNames.length, testCount: testFiles.length };
}

async function checkScope(scopeId) {
  assertScopesAreComplete();
  const workspaceIds = scopeWorkspaces.get(scopeId);
  if (!workspaceIds) throw new Error(`Unknown test typecheck scope ${scopeId}; expected one of ${TEST_TYPECHECK_SCOPES.join(', ')}`);

  const selected = workspaceIds.map((id) => WORKSPACES.find((workspace) => workspace.id === id));
  const results = [];
  if (scopeId === 'app-e2e') {
    const appDirectory = path.join(root, 'app');
    const appTests = (await listTypeScriptFiles(appDirectory)).filter(isTestFile);
    results.push(await checkDirectory(
      { id: scopeId, testFiles: appTests },
      'app',
      { include: ['src/**/*.ts', 'src/**/*.tsx'], testFiles: appTests },
    ));

    const e2eDirectory = path.join(root, 'tests/e2e');
    const e2eFiles = await listTypeScriptFiles(e2eDirectory);
    const e2eTests = e2eFiles.filter(isTestFile);
    results.push(await checkDirectory(
      { id: scopeId, testFiles: e2eTests },
      'tests/e2e',
      {
        configDirectory: 'app',
        include: ['../tests/e2e/**/*.ts', '../tests/e2e/**/*.tsx'],
        testFiles: e2eTests,
      },
    ));
  } else {
    for (const workspace of selected) {
      const testFiles = (await listTypeScriptFiles(path.join(root, workspace.path))).filter(isTestFile);
      results.push(await checkDirectory(
        { id: scopeId, testFiles },
        workspace.path,
        { include: ['src/**/*.ts', 'src/**/*.tsx'], testFiles },
      ));
    }
  }

  const failed = results.some(({ failed: resultFailed }) => resultFailed);
  const fileCount = results.reduce((sum, result) => sum + result.fileCount, 0);
  const testCount = results.reduce((sum, result) => sum + result.testCount, 0);
  if (fileCount === 0 || testCount === 0) throw new Error(`Test typecheck scope ${scopeId} was empty (files=${fileCount}, tests=${testCount})`);
  console.log(`Test typecheck ${scopeId}: ${fileCount} TypeScript files, ${testCount} test/spec files, ${failed ? 'FAIL' : 'PASS'}.`);
  if (failed) process.exitCode = 1;
}

const [scopeId, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Usage: node scripts/typecheck-tests.mjs [app-e2e|packages|modules]');
if (scopeId) await checkScope(scopeId);
else {
  for (const scope of TEST_TYPECHECK_SCOPES) await checkScope(scope);
}
