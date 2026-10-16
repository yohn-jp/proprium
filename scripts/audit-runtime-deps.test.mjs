import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const audit = fileURLToPath(new URL('./audit-runtime-deps.mjs', import.meta.url));
test('Core audit distinguishes installed optional modules from its actual production closure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scriptorium-audit-'));
  const manifest = async (dir, value) => {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(value));
  };
  const run = (...extra) => spawnSync(process.execPath, [audit, '--node-modules', 'node_modules', ...extra], { cwd: root, encoding: 'utf8' });
  try {
    for (const name of ['core', 'api']) await manifest(`packages/${name}`, { name: `@scriptorium/${name}`, version: '1.0.0' });
    await manifest('app', { name: '@scriptorium/app', version: '1.0.0' });
    const optional = 'node_modules/.pnpm/optional/node_modules/@scriptorium/module-story';
    await manifest(optional, { name: '@scriptorium/module-story', version: '1.0.0' });
    assert.equal(run().status, 0, 'development installation alone must not enter Core closure');
    assert.notEqual(run('--production').status, 0, 'an optional package must be absent from Core production image');
    await mkdir(path.join(root, 'packages/core/node_modules/@scriptorium'), { recursive: true });
    await symlink(path.join(root, optional), path.join(root, 'packages/core/node_modules/@scriptorium/module-story'));
    await manifest('packages/core', { name: '@scriptorium/core', version: '1.0.0', dependencies: { '@scriptorium/module-story': '1.0.0' } });
    const dependency = run();
    assert.notEqual(dependency.status, 0);
    assert.match(dependency.stderr, /runtime dependency @scriptorium\/module-story/);
    await manifest('packages/core', { name: '@scriptorium/core', version: '1.0.0' });
    await mkdir(path.join(root, 'compiled'), { recursive: true });
    await writeFile(path.join(root, 'compiled/index.js'), 'import "@scriptorium/module-story";');
    assert.notEqual(run('--dist', 'compiled').status, 0, 'undeclared compiled module imports are forbidden too');
  } finally { await rm(root, { recursive: true, force: true }); }
});
