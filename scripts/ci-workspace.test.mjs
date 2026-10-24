import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WORKSPACES } from './ci-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts/ci-workspace.mjs');

function run(args, env = process.env) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: 'utf8' });
}

function runProject(projectRoot, args, env = process.env) {
  return spawnSync(process.execPath, [path.join(projectRoot, 'scripts/ci-workspace.mjs'), ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

async function makeWorkspaceFixture(rootTestScript) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'scriptorium-ci-workspace-fixture-'));
  await mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
  await copyFile(runner, path.join(projectRoot, 'scripts/ci-workspace.mjs'));
  await copyFile(path.join(root, 'scripts/ci-contract.mjs'), path.join(projectRoot, 'scripts/ci-contract.mjs'));

  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  rootManifest.scripts.test = rootTestScript;
  await writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`);
  for (const workspace of WORKSPACES) {
    const manifestPath = path.join(workspace.path, 'package.json');
    const fixturePath = path.join(projectRoot, manifestPath);
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await copyFile(path.join(root, manifestPath), fixturePath);
  }

  const bin = path.join(projectRoot, 'bin');
  const pnpm = path.join(bin, 'pnpm');
  const record = path.join(projectRoot, 'pnpm-commands.jsonl');
  await mkdir(bin);
  await writeFile(pnpm, '#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.SCRIPTORIUM_CI_PNPM_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  await chmod(pnpm, 0o755);

  return {
    projectRoot,
    record,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      SCRIPTORIUM_CI_PNPM_RECORD: record,
    },
  };
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

test('grouped unit preparation builds shared dependencies once and retains root API preparation', async () => {
  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  try {
    const prepared = runProject(fixture.projectRoot, ['prepare', 'unit-group', 'contracts,module-runtime,migration,core,api,root'], fixture.env);
    assert.equal(prepared.status, 0, prepared.stderr);
    const commands = (await readFile(fixture.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const packages = commands.map(command => command[1]);
    assert.equal(new Set(packages).size, packages.length);
    assert.ok(packages.includes('@scriptorium/contracts'));
    assert.ok(packages.includes('@scriptorium/core'));
    assert.equal(packages.at(-1), '@scriptorium/api');
    assert.ok(commands.every(command => command.slice(2).join(' ') === 'run build'));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('speaker unit tests own their worker build while preparation follows workspace dependencies', async () => {
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
    assert.match(prepared.stdout, /built dependency workspaces/u);

    const executed = run(['unit', 'speaker'], env);
    assert.equal(executed.status, 0, executed.stderr);

    const commands = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const builtPackages = commands.filter((command) => command.includes('build')).map((command) => command[1]);
    assert.ok(builtPackages.includes('@scriptorium/module-nlp'));
    assert.ok(builtPackages.includes('@scriptorium/module-diagnostics'));
    assert.equal(builtPackages.includes('@scriptorium/module-speaker'), false);
    assert.deepEqual(commands.at(-1), ['--filter', '@scriptorium/module-speaker', 'run', 'test']);
    const speakerManifest = JSON.parse(await readFile(path.join(root, 'modules/speaker/package.json'), 'utf8'));
    assert.match(speakerManifest.scripts.test, /^pnpm run build && /u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('unit preparation is unchanged when root test orchestration order changes', async () => {
  const rootTestScripts = [
    'pnpm --filter @scriptorium/module-speaker build && pnpm --filter @scriptorium/module-speaker test && pnpm --filter @scriptorium/module-runtime test',
    'pnpm --filter @scriptorium/module-speaker build && pnpm --filter @scriptorium/module-runtime test && pnpm --filter @scriptorium/module-speaker test',
  ];
  const observed = [];
  const fixtures = [];
  try {
    for (const rootTestScript of rootTestScripts) {
      const fixture = await makeWorkspaceFixture(rootTestScript);
      fixtures.push(fixture.projectRoot);
      const prepared = runProject(fixture.projectRoot, ['prepare', 'unit', 'speaker'], fixture.env);
      assert.equal(prepared.status, 0, prepared.stderr);
      const executed = runProject(fixture.projectRoot, ['unit', 'speaker'], fixture.env);
      assert.equal(executed.status, 0, executed.stderr);
      observed.push((await readFile(fixture.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)));
    }
    assert.deepEqual(observed[0], observed[1]);
    assert.deepEqual(observed[0].at(-1), ['--filter', '@scriptorium/module-speaker', 'run', 'test']);
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
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
