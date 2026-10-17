import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { productionClosure, pruneToProductionClosure } from './runtime-package-closure.mjs';

test('hosted pruning retains only the actual transitive package closure and removes excluded native packages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scriptorium-runtime-closure-'));
  const nodeModules = path.join(root, 'node_modules');
  const store = path.join(nodeModules, '.pnpm');
  const packageRoot = async (storeName, name) => path.join(store, storeName, 'node_modules', ...name.split('/'));
  const makePackage = async (storeName, name, dependencies = {}, files = {}) => {
    const directory = await packageRoot(storeName, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }));
    for (const [relative, value] of Object.entries(files)) {
      const filename = path.join(directory, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, value);
    }
    return directory;
  };
  const linkPackage = async (directory, dependencyName, target) => {
    const link = path.join(directory, 'node_modules', ...dependencyName.split('/'));
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
  };
  const rootLink = async (dependencyName, target) => {
    const link = path.join(nodeModules, ...dependencyName.split('/'));
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
  };

  try {
    const api = await makePackage('@scriptorium+api@1.0.0', '@scriptorium/api', { 'runtime-leaf': '1.0.0' });
    const leaf = await makePackage('runtime-leaf@1.0.0', 'runtime-leaf', { 'runtime-deep': '1.0.0' });
    const deep = await makePackage('runtime-deep@1.0.0', 'runtime-deep');
    const excluded = await makePackage('onnxruntime-node@1.0.0', 'onnxruntime-node', {}, { 'native.node': 'excluded-by-selection' });
    await rootLink('@scriptorium/api', api);
    await rootLink('runtime-leaf', leaf);
    await linkPackage(leaf, 'runtime-deep', deep);
    await rootLink('onnxruntime-node', excluded);
    await mkdir(path.join(store, 'node_modules'), { recursive: true });
    await linkPackage(path.join(store), 'runtime-leaf', leaf);
    await linkPackage(path.join(store), 'runtime-deep', deep);
    await linkPackage(path.join(store), 'onnxruntime-node', excluded);

    const expected = await productionClosure([path.join(nodeModules, '@scriptorium/api')]);
    assert.deepEqual(new Set([...expected.values()].map(({ name }) => name)), new Set([
      '@scriptorium/api', 'runtime-leaf', 'runtime-deep',
    ]));
    await pruneToProductionClosure(nodeModules, expected);

    assert.equal(await lstat(excluded).then(() => true, () => false), false);
    assert.equal(await lstat(path.join(nodeModules, 'onnxruntime-node')).then(() => true, () => false), false);
    assert.equal(await lstat(path.join(store, 'onnxruntime-node@1.0.0')).then(() => true, () => false), false);
    assert.equal(await readFile(path.join(leaf, 'package.json'), 'utf8').then(() => true), true);
    const actual = await productionClosure([path.join(nodeModules, '@scriptorium/api')]);
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
