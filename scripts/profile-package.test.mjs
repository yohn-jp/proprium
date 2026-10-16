import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuildCommands, validateProfilePackage } from './profile-package.mjs';

test('Core package depends on the API and builds no optional module package', () => {
  const profile = { profile: 'core', modules: [] };
  const packageManifest = {
    name: '@scriptorium/profile-core',
    dependencies: { '@scriptorium/api': 'workspace:*' },
  };
  assert.deepEqual(validateProfilePackage('core', profile, packageManifest, new Set()), {
    profileName: 'core',
    moduleIds: [],
  });

  const commands = createBuildCommands('core', profile);
  assert.equal(
    commands.some(({ args }) => args.some((argument) =>
      argument.startsWith('@scriptorium/module-') && argument !== '@scriptorium/module-runtime')),
    false,
  );
  assert.deepEqual(commands.find(({ args }) => args.includes('@scriptorium/app'))?.env, { SCRIPTORIUM_PROFILE: 'core' });
});

test('Full package waits for selected module producers and exact package dependencies', () => {
  const profile = { profile: 'full', modules: ['story', 'semantic'] };
  const packageManifest = {
    name: '@scriptorium/profile-full',
    dependencies: {
      '@scriptorium/api': 'workspace:*',
      '@scriptorium/module-story': 'workspace:*',
      '@scriptorium/module-semantic': 'workspace:*',
    },
  };
  assert.deepEqual(validateProfilePackage('full', profile, packageManifest, new Set(['story', 'semantic'])), {
    profileName: 'full',
    moduleIds: ['story', 'semantic'],
  });
  assert.throws(
    () => validateProfilePackage('full', profile, packageManifest, new Set(['story'])),
    /not been produced: semantic/u,
  );
  assert.throws(
    () => validateProfilePackage('full', profile, { ...packageManifest, dependencies: { '@scriptorium/api': 'workspace:*', '@scriptorium/module-story': 'workspace:*' } }, new Set(['story', 'semantic'])),
    /dependencies do not match/u,
  );

  const commands = createBuildCommands('full', profile);
  const moduleBuild = commands.find(({ args }) => args.includes('build') && args.some((argument) => argument.includes('@scriptorium/module-story')));
  assert.ok(moduleBuild);
  assert.ok(moduleBuild.args.includes('@scriptorium/module-semantic...'));
});
