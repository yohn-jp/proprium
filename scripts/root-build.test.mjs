import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuildCommands } from './profile-package.mjs';
import { createRootBuildCommands } from './root-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

test('default and explicit Core root builds select the existing selective profile graph', () => {
  const profile = { profile: 'core', modules: [] };
  const commands = createRootBuildCommands('core', profile);

  assert.deepEqual(createRootBuildCommands(undefined, profile), commands);
  assert.deepEqual(createRootBuildCommands('', profile), commands);
  assert.deepEqual(commands, createBuildCommands('core', profile));
  assert.deepEqual(commands[0], {
    command: 'pnpm',
    args: ['--filter', '@scriptorium/contracts', 'run', 'build'],
  });
  assert.deepEqual(commands[1], {
    command: 'pnpm',
    args: ['--filter', '@scriptorium/module-runtime', 'run', 'build'],
  });
  assert.equal(commands.some(({ args }) => args.includes('--profile') && args.includes('core')), true);
  assert.deepEqual(commands.find(({ args }) => args.includes('@scriptorium/app'))?.env, {
    SCRIPTORIUM_PROFILE: 'core',
  });
  assert.deepEqual(commands.at(-1), {
    command: 'pnpm',
    args: ['--filter', '@scriptorium/api...', 'run', 'build'],
  });

  const optionalModuleFilters = commands.flatMap(({ args }) => args)
    .filter((argument) => argument.startsWith('@scriptorium/module-') && argument !== '@scriptorium/module-runtime');
  assert.deepEqual(optionalModuleFilters, []);
  assert.equal(commands.some(({ args }) => args.includes('@scriptorium/migration')), false);
});

test('Full root builds keep the existing workspace graph', () => {
  assert.equal(packageManifest.scripts.build, 'node scripts/root-build.mjs');
  assert.match(packageManifest.scripts['build:workspace'], /@scriptorium\/migration build/);
  assert.match(packageManifest.scripts['build:workspace'], /@scriptorium\/module-assistant build/);
  assert.deepEqual(createRootBuildCommands('full'), [{
    command: 'pnpm',
    args: ['run', 'build:workspace'],
  }]);
});
