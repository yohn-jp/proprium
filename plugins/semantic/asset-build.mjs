import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const PREFIX = 'proprium/semantic/';
const MAX_CHUNK = 16 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function outputPath(directory, path) {
  if (typeof path !== 'string' || !path.startsWith(PREFIX) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid Semantic asset path');
  const root = resolve(directory);
  const target = resolve(root, path.slice(PREFIX.length));
  if (!target.startsWith(root + sep)) throw new Error('Semantic asset path escaped output');
  return target;
}

async function writePinned(directory, path, bytes) {
  const target = outputPath(directory, path);
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (!(await readFile(target)).equals(bytes)) throw new Error(`Conflicting Semantic asset bytes: ${path}`);
  }
}

/** Verify the pinned source and every content-addressed chunk before publication. */
export async function generatePinnedAssets({ manifestBytes, group, outputDirectory, openFile }) {
  const encoded = Buffer.from(manifestBytes);
  if (encoded.length !== group.bytes || digest(encoded) !== group.sha256 || !group.manifest_path.includes(`/${group.sha256}/`)) throw new Error('Semantic asset manifest size or digest mismatch');
  const manifest = JSON.parse(encoded.toString('utf8'));
  if (manifest.schema !== 'proprium.assets/v1' || manifest.id !== group.id || !Array.isArray(manifest.files)) throw new Error('Semantic asset manifest identity mismatch');
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path.startsWith(`${PREFIX}embedding/e5-small/`) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Array.isArray(file.chunks)) throw new Error('Invalid Semantic file metadata');
    let expectedOffset = 0;
    for (const chunk of file.chunks) {
      outputPath(outputDirectory, chunk.path);
      if (!chunk.path.startsWith(`${PREFIX}chunks/`) || !/^[a-f0-9]{64}$/u.test(chunk.sha256) || !chunk.path.includes(`/${chunk.sha256}/`) || chunk.offset !== expectedOffset || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > MAX_CHUNK) throw new Error('Invalid Semantic chunk metadata');
      expectedOffset += chunk.bytes;
    }
    if (expectedOffset !== file.bytes) throw new Error('Semantic chunk size mismatch');
    const hash = createHash('sha256'); let total = 0; let index = 0; let used = 0;
    let buffer = file.chunks.length ? Buffer.alloc(file.chunks[0].bytes) : Buffer.alloc(0);
    for await (const data of await openFile(file.path)) {
      const input = Buffer.from(data); hash.update(input); total += input.length;
      if (total > file.bytes) throw new Error(`Semantic source size mismatch: ${file.path}`);
      let offset = 0;
      while (offset < input.length) {
        const chunk = file.chunks[index];
        if (!chunk) throw new Error(`Semantic source size mismatch: ${file.path}`);
        const count = Math.min(input.length - offset, chunk.bytes - used);
        input.copy(buffer, used, offset, offset + count); used += count; offset += count;
        if (used === chunk.bytes) {
          if (digest(buffer) !== chunk.sha256) throw new Error(`Semantic chunk digest mismatch: ${chunk.path}`);
          await writePinned(outputDirectory, chunk.path, buffer);
          index++; used = 0; buffer = index < file.chunks.length ? Buffer.alloc(file.chunks[index].bytes) : Buffer.alloc(0);
        }
      }
    }
    if (total !== file.bytes || index !== file.chunks.length || used !== 0 || hash.digest('hex') !== file.sha256) throw new Error(`Semantic source size or digest mismatch: ${file.path}`);
  }
  await writePinned(outputDirectory, group.manifest_path, encoded);
}
