import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sizes = { small: 10, medium: 1000, large: 10000, stress: 100000 };
export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }).trim();
}
export async function generate(root, size) {
  const count = sizes[size];
  if (!count) throw new Error(`Unknown dataset: ${size}`);
  // Exclusive directory creation prevents overwriting any existing repository.
  await mkdir(root);
  const seed = join(root, 'seed'), remote = join(root, 'origin.git');
  await mkdir(seed);
  let files = 0, bytes = 0;
  const write = async (path, body) => {
    const full = join(seed, path); await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body); files++; bytes += Buffer.byteLength(body);
  };
  await write('meta/project.yaml', 'id: synthetic\ntitle: Synthetic Wave 0\n');
  const volumes = { small: 1, medium: 1, large: 10, stress: 100 }[size];
  const chapters = { small: 1, medium: 10, large: 100, stress: 1000 }[size];
  for (let v = 1; v <= volumes; v++) await write(`plot/volumes/vol-${v}/volume.yaml`, `id: vol-${v}\ntitle: ${v === 1 ? 'Volume One' : `Volume ${v}`}\norder: ${v}\n`);
  for (let c = 1; c <= chapters; c++) {
    const v = Math.floor((c - 1) / 10) + 1;
    await write(`plot/volumes/vol-${v}/chapters/ch-${c}/chapter.yaml`, `id: ch-${c}\nvolume: vol-${v}\ntitle: ${c === 1 ? 'Chapter One' : `Chapter ${c}`}\norder: ${c}\n`);
  }
  const scenes = Math.floor((count - 2 - volumes - chapters) / 2);
  const lengths = [1024, 100 * 1024, 1024 * 1024];
  for (let i = 1; i <= scenes; i++) {
    const c = Math.floor((i - 1) / Math.ceil(scenes / chapters)) + 1, v = Math.floor((c - 1) / 10) + 1;
    await write(`plot/volumes/vol-${v}/chapters/ch-${c}/scenes/scene-${i}.yaml`,
      `id: scene-${i}\ntitle: Scene ${i}\nvolume: vol-${v}\nchapter: ch-${c}\norder: ${i}\nmanuscript: manuscript/vol-${v}/ch-${c}/scene-${i}.md\n`);
    const prefix = `# Synthetic scene ${i}\n\n`;
    const length = lengths[i - 1] ?? (size === 'medium' ? 4096 : 1024);
    await write(`manuscript/vol-${v}/ch-${c}/scene-${i}.md`, prefix + 'Synthetic prose for a fixed benchmark paragraph.\n'.repeat(Math.ceil(length / 48)).slice(0, length - prefix.length));
  }
  if (size === 'large' || size === 'stress') await write('attachments/synthetic-10MiB.bin', Buffer.alloc(10 * 1024 * 1024, 83));
  while (files < count) await write(`synthetic/filler-${files}.txt`, 'Synthetic fixture only.\n');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(seed, 'init', '--initial-branch=main'); git(seed, 'add', '.'); git(seed, 'commit', '--quiet', '-m', 'Synthetic baseline');
  const historyCommits = size === 'stress' ? 100 : 1;
  for (let i = 1; i < historyCommits; i++) {
    await writeFile(join(seed, 'meta/project.yaml'), `id: synthetic\ntitle: Synthetic Wave 0\nsyntheticRevision: ${i}\n`);
    git(seed, 'add', 'meta/project.yaml'); git(seed, 'commit', '--quiet', '-m', `Synthetic history ${i}`);
  }
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-u', 'origin', 'main');
  const actual = git(seed, 'ls-files').split('\n').length;
  if (actual !== count) throw new Error(`Expected ${count} tracked files; got ${actual}`);
  // Byte count describes final tracked tree, including history's final metadata update.
  bytes = 0;
  for (const file of git(seed, 'ls-files').split('\n')) bytes += (await stat(join(seed, file))).size;
  const manifest = { schemaVersion: 1, size, files: actual, volumes, chapters, scenes, bytes, historyCommits,
    documentBytes: lengths, attachmentBytes: size === 'large' || size === 'stress' ? 10485760 : 0,
    commit: git(seed, 'rev-parse', 'HEAD'), remote, syntheticOnly: true };
  await writeFile(join(root, 'dataset.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await generate(resolve(process.argv[2]), process.argv[3]), null, 2));
}
