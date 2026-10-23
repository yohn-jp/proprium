#!/usr/bin/env node
import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['app', 'tests/e2e'];
for (const area of ['packages', 'modules']) {
  for (const item of await readdir(path.join(root, area), { withFileTypes: true })) {
    if (item.isDirectory()) directories.push(`${area}/${item.name}`);
  }
}
let failed = false;
let checked = 0;
const format = { getCanonicalFileName: filename => filename, getCurrentDirectory: () => root, getNewLine: () => '\n' };
for (const directory of directories) {
  const configPath = path.join(root, directory, directory === 'tests/e2e' ? '../../app/tsconfig.json' : 'tsconfig.json');
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const basePath = directory === 'tests/e2e' ? path.join(root, 'app') : path.join(root, directory);
  config.exclude = [];
  config.include = directory === 'tests/e2e' ? ['../tests/e2e/**/*.ts', '../tests/e2e/**/*.tsx'] : ['src/**/*.ts', 'src/**/*.tsx'];
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, basePath);
  const options = { ...parsed.options, jsx: parsed.options.jsx ?? ts.JsxEmit.ReactJSX, noEmit: true, composite: false, incremental: false, declaration: false, declarationMap: false };
  delete options.rootDir;
  delete options.outDir;
  delete options.tsBuildInfoFile;
  const program = ts.createProgram(parsed.fileNames, options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  checked += parsed.fileNames.filter(filename => /\.(test|spec)\.(ts|tsx)$/.test(filename)).length;
  if (diagnostics.length) {
    failed = true;
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, format));
  }
}
console.log(`Checked production and test source together; ${checked} test files included.`);
if (failed) process.exitCode = 1;
