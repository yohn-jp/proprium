import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_MODULE_IDS } from '@scriptorium/contracts';
import {
  PROFILES,
  TYPECHECK_TARGETS,
  UNIT_TARGETS,
  WORKSPACES,
} from './ci-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePackagePrefix = '@scriptorium/module-';
const builtinSet = new Set(BUILTIN_MODULE_IDS);
const expectedIds = [...BUILTIN_MODULE_IDS].sort();

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function moduleIdsFromPaths(entries, label) {
  return entries
    .filter(({ path: entryPath }) => entryPath.startsWith('modules/'))
    .map(({ path: entryPath }) => {
      const match = /^modules\/([^/]+)$/.exec(entryPath);
      assert.ok(match, `${label} contains a malformed module workspace path: ${entryPath}`);
      return match[1];
    });
}

function assertExactIds(actual, label) {
  assert.equal(actual.length, new Set(actual).size, `${label} contains duplicate module IDs`);
  assert.deepEqual([...actual].sort(), expectedIds, `${label} must register every built-in module exactly once`);
}

function assertSameIds(actual, expected, label) {
  assert.equal(actual.length, new Set(actual).size, `${label} contains duplicate module IDs`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} do not match their declared module IDs`);
}

test('module manifests exactly register the canonical built-ins', async () => {
  const moduleRoot = path.join(root, 'modules');
  const directories = (await readdir(moduleRoot, { withFileTypes: true })).filter(entry => entry.isDirectory());
  const ids = [];

  for (const directory of directories) {
    const manifest = await readJson(path.join(moduleRoot, directory.name, 'package.json'));
    const expectedId = directory.name;
    assert.equal(manifest.name, `${modulePackagePrefix}${expectedId}`);
    assert.equal(manifest.scriptoriumModule?.id, expectedId);
    ids.push(expectedId);
  }

  assertExactIds(ids, 'module manifests');
});

test('supported profiles and profile packages register their declared modules exactly', async () => {
  const profilesRoot = path.join(root, 'profiles');
  const profileFiles = (await readdir(profilesRoot)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  assert.equal(new Set(PROFILES).size, PROFILES.length, 'CI profile inventory contains duplicate profile names');
  assert.deepEqual([...profileFiles].sort(), [...PROFILES].sort(), 'profile manifests and CI profile inventory differ');

  for (const profileName of PROFILES) {
    const profile = await readJson(path.join(profilesRoot, `${profileName}.json`));
    const packageManifest = await readJson(path.join(profilesRoot, profileName, 'package.json'));
    assert.equal(profile.profile, profileName);
    assert.ok(Array.isArray(profile.modules), `${profileName} profile must enumerate module IDs`);
    assert.equal(profile.modules.length, new Set(profile.modules).size, `${profileName} profile contains duplicate module IDs`);
    assert.ok(profile.modules.every(id => builtinSet.has(id)), `${profileName} profile contains an unknown module ID`);

    const expectedProfileIds = profileName === 'core' ? [] : BUILTIN_MODULE_IDS;
    assertSameIds(profile.modules, expectedProfileIds, `${profileName} profile`);

    const dependencies = { ...packageManifest.dependencies, ...packageManifest.optionalDependencies };
    const dependencyIds = Object.keys(dependencies)
      .filter(name => name.startsWith(modulePackagePrefix))
      .map(name => name.slice(modulePackagePrefix.length));
    assertSameIds(dependencyIds, profile.modules, `${profileName} profile package dependencies`);
  }
});

test('pnpm and CI workspaces register every built-in exactly once', async () => {
  const workspaceConfig = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspaceConfig, /(?:^|\n)\s*-\s*modules\/\*\s*(?:\r?\n|$)/, 'pnpm workspace must include modules/*');

  assertExactIds(moduleIdsFromPaths(WORKSPACES, 'CI WORKSPACES'), 'CI WORKSPACES');
  assertExactIds(moduleIdsFromPaths(UNIT_TARGETS, 'CI UNIT_TARGETS'), 'CI UNIT_TARGETS');

  const workspaceById = new Map(WORKSPACES.map(workspace => [workspace.id, workspace]));
  const typecheckedModuleIds = TYPECHECK_TARGETS.flatMap(target => target.workspaces).flatMap(id => {
    const workspace = workspaceById.get(id);
    assert.ok(workspace, `CI typecheck target references unregistered workspace ${id}`);
    return workspace.path.startsWith('modules/') ? [id] : [];
  });
  assertExactIds(typecheckedModuleIds, 'CI TYPECHECK_TARGETS');
});
