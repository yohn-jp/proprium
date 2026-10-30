import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const source = JSON.parse(await readFile(new URL('../model-source.json', import.meta.url), 'utf8'));
const CHUNK_BYTES = 16 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [, , graphPath, dataPath, tokenizerPath] = process.argv;
if (!graphPath || !dataPath || !tokenizerPath) throw new Error('usage: node create-asset-manifest.mjs MODEL.onnx MODEL.onnx_data tokenizer.json');
const fileInputs = [
  { path: 'proprium/semantic/reranker/bge-reranker-v2-m3/onnx/model.onnx', sourcePath: resolve(graphPath) },
  { path: 'proprium/semantic/reranker/bge-reranker-v2-m3/onnx/model.onnx_data', sourcePath: resolve(dataPath) },
  { path: 'proprium/semantic/reranker/bge-reranker-v2-m3/tokenizer.json', sourcePath: resolve(tokenizerPath) },
  { path: 'proprium/semantic/reranker/bge-reranker-v2-m3/provenance.json', sourcePath: resolve(root, 'reranker/provenance.json') },
];
const expected = new Map(source.files.map(file => [file.path, file]));
const files = [];
for (const file of fileInputs) {
  const relative = file.path.replace('proprium/semantic/reranker/bge-reranker-v2-m3/', '');
  const pinned = expected.get(relative);
  if (relative !== 'provenance.json' && !pinned) throw new Error(`Source is not pinned: ${relative}`);
  const hash = createHash('sha256');
  const chunks = [];
  let total = 0;
  let pending = Buffer.allocUnsafe(CHUNK_BYTES);
  let used = 0;
  for await (const input of createReadStream(file.sourcePath, { highWaterMark: 1024 * 1024 })) {
    const bytes = Buffer.from(input);
    hash.update(bytes);
    total += bytes.length;
    let cursor = 0;
    while (cursor < bytes.length) {
      const count = Math.min(bytes.length - cursor, CHUNK_BYTES - used);
      bytes.copy(pending, used, cursor, cursor + count);
      used += count;
      cursor += count;
      if (used === CHUNK_BYTES) {
        const digest = sha(pending);
        chunks.push({ path: `proprium/semantic/chunks/${digest}/chunk.bin`, offset: total - (bytes.length - cursor) - used, bytes: used, sha256: digest });
        pending = Buffer.allocUnsafe(CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used) {
    const digest = sha(pending.subarray(0, used));
    chunks.push({ path: `proprium/semantic/chunks/${digest}/chunk.bin`, offset: total - used, bytes: used, sha256: digest });
  }
  const digest = hash.digest('hex');
  if (pinned && (total !== pinned.bytes || digest !== pinned.sha256)) throw new Error(`Pinned source digest differs: ${relative}`);
  files.push({ path: file.path, bytes: total, sha256: digest, chunks });
}
const manifest = { schema: 'proprium.assets/v1', id: 'proprium.semantic.reranker.bge-v2-m3', version: `0.1.0-${source.revision}`, license: source.license, files };
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const manifestDigest = sha(bytes);
const manifestPath = `assets/manifests/${manifestDigest}/manifest.json`;
const output = resolve(root, manifestPath);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, bytes);
console.log(JSON.stringify({ id: manifest.id, manifest_path: `proprium/semantic/${manifestPath}`, sha256: manifestDigest,
  bytes: bytes.length, role: 'reranker', group_bytes: files.reduce((sum, file) => sum + file.bytes, 0), files: files.length,
  chunks: files.reduce((sum, file) => sum + file.chunks.length, 0) }, null, 2));
