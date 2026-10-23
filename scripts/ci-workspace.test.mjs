import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts/ci-workspace.mjs');

function run(args, env = process.env) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: 'utf8' });
}

test('coverage maps every workspace test and typecheck scope to an executable target', () => {
  const result = run(['coverage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /15 workspaces, 16 unit targets, 5 production typecheck groups, 3 test typecheck scopes/u);
  assert.match(result.stdout, /test\/spec files mapped to package scripts/u);
});

test('root unit preparation builds the API dependency closure before invoking root script tests', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'scriptorium-ci-workspace-'));
  const bin = path.join(temporary, 'bin');
  const pnpm = path.join(bin, 'pnpm');
  const record = path.join(temporary, 'pnpm-commands.jsonl');
  await mkdir(bin);
  await writeFile(pnpm, '#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.SCRIPTORIUM_CI_PNPM_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  await chmod(pnpm, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    SCRIPTORIUM_CI_PNPM_RECORD: record,
  };
  try {
    const prepared = run(['prepare', 'unit', 'root'], env);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /built API and its declared workspace dependencies/u);

    const executed = run(['unit', 'root'], env);
    assert.equal(executed.status, 0, executed.stderr);
    assert.match(executed.stdout, /using package\.json script test:scripts/u);

    const commands = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(commands, [
      ['--filter', '@scriptorium/api...', 'build'],
      ['run', 'test:scripts'],
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('speaker unit preparation builds packages whose canonical pnpm test command builds before testing', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'scriptorium-ci-workspace-'));
  const bin = path.join(temporary, 'bin');
  const pnpm = path.join(bin, 'pnpm');
  const record = path.join(temporary, 'pnpm-commands.jsonl');
  await mkdir(bin);
  await writeFile(pnpm, '#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.SCRIPTORIUM_CI_PNPM_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  await chmod(pnpm, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    SCRIPTORIUM_CI_PNPM_RECORD: record,
  };
  try {
    const prepared = run(['prepare', 'unit', 'speaker'], env);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /built its own output because package\.json test builds it before its tests/u);

    const commands = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const builtPackages = commands.map((command) => command[1]);
    assert.ok(builtPackages.includes('@scriptorium/module-nlp'));
    assert.ok(builtPackages.includes('@scriptorium/module-diagnostics'));
    assert.deepEqual(commands.at(-1), ['--filter', '@scriptorium/module-speaker', 'run', 'build']);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('coverage and test typecheck reject TypeScript tests outside workspace src', async () => {
  const fixture = await mkdtemp(path.join(root, 'modules/speaker/.ci-coverage-probe-'));
  const source = path.join(fixture, 'unregistered.test.ts');
  await writeFile(source, 'export const coverageProbe: string = "unregistered";\n');
  try {
    const coverage = run(['coverage']);
    assert.notEqual(coverage.status, 0, coverage.stdout);
    assert.match(`${coverage.stdout}\n${coverage.stderr}`, /Unit target speaker does not execute these test files/u);
    assert.match(`${coverage.stdout}\n${coverage.stderr}`, /unregistered\.test\.ts/u);

    const typecheck = spawnSync(process.execPath, [path.join(root, 'scripts/typecheck-tests.mjs'), 'modules'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(typecheck.status, 0, typecheck.stdout);
    assert.match(`${typecheck.stdout}\n${typecheck.stderr}`, /TypeScript input omitted test sources for modules\/speaker/u);
    assert.match(`${typecheck.stdout}\n${typecheck.stderr}`, /unregistered\.test\.ts/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
