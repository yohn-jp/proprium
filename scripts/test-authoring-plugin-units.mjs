import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tests = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.test\.(?:ts|mjs)$/u.test(entry.name) && !entry.name.endsWith('.component.test.mjs')) tests.push(path);
  }
}
for (const id of ['narrative', 'knowledge', 'research', 'paired-writing', 'diagnostics', 'speaker', 'semantic', 'publishing', 'shared']) await collect(join(root, 'plugins', id));
tests.sort();
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
