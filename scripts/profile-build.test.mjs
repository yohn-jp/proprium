import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(root, 'scripts', 'profile-build.mjs');

test('Core profile generation and deployed-closure verification exclude optional module packages', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'scriptorium-profile-core-'));
  const output = path.join(temporary, 'generated');
  const deploy = path.join(temporary, 'deploy');
  await mkdir(path.join(deploy, 'node_modules'), { recursive: true });
  try {
    const result = spawnSync(process.execPath, [generator, '--profile', 'core', '--out', output, '--verify-deploy', deploy], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(await readFile(path.join(output, 'module-manifests.json'), 'utf8'));
    assert.deepEqual(metadata.modules, []);
    const server = await readFile(path.join(output, 'server.mjs'), 'utf8');
    const browser = await readFile(path.join(output, 'browser.mjs'), 'utf8');
    assert.match(server, /moduleLoaders = Object\.freeze\(\{\s*\}\)/);
    assert.match(browser, /moduleBrowserLoaders = Object\.freeze\(\{\s*\}\)/);
    assert.doesNotMatch(`${server}\n${browser}`, /@scriptorium\/module-(?:story|diagnostics|nlp|semantic|speaker|assistant|publishing|mcp)/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('deployed-closure verification follows pnpm package symlinks and checks their built imports', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'scriptorium-profile-symlink-'));
  const output = path.join(temporary, 'generated');
  const deploy = path.join(temporary, 'deploy');
  const nodeModules = path.join(deploy, 'node_modules');
  const storePackage = path.join(deploy, 'store', 'module-runtime');
  try {
    await mkdir(path.join(nodeModules, '@scriptorium'), { recursive: true });
    await mkdir(storePackage, { recursive: true });
    await writeFile(path.join(storePackage, 'package.json'), JSON.stringify({ name: '@scriptorium/module-runtime' }));
    await writeFile(path.join(storePackage, 'index.mjs'), 'import "@scriptorium/module-story";\n');
    await symlink(storePackage, path.join(nodeModules, '@scriptorium', 'module-runtime'), 'dir');

    const result = spawnSync(process.execPath, [generator, '--profile', 'core', '--out', output, '--verify-deploy', deploy], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /imports excluded optional module @scriptorium\/module-story/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('deployed-closure verification counts an installed module package reached through a symlink', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'scriptorium-profile-package-link-'));
  const output = path.join(temporary, 'generated');
  const deploy = path.join(temporary, 'deploy');
  const linkedPackage = path.join(deploy, 'store', 'module-story');
  try {
    await mkdir(path.join(deploy, 'node_modules', '@scriptorium'), { recursive: true });
    await mkdir(linkedPackage, { recursive: true });
    await writeFile(path.join(linkedPackage, 'package.json'), JSON.stringify({ name: '@scriptorium/module-story' }));
    await symlink(linkedPackage, path.join(deploy, 'node_modules', '@scriptorium', 'module-story'), 'dir');

    const result = spawnSync(process.execPath, [generator, '--profile', 'core', '--out', output, '--verify-deploy', deploy], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Deployed core module package closure mismatch: expected \[\], found \[story\]/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
