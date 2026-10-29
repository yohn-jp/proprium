import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('signed BGE manifest pins provenance, complete source files and bounded contiguous tensor chunks', async () => {
  const source = JSON.parse(await readFile(new URL('./model-source.json', import.meta.url), 'utf8'));
  const plugin = JSON.parse(await readFile(resolve(root, 'plugin.json'), 'utf8'));
  const ref = plugin.asset_groups.find(group => group.id === 'proprium.semantic.reranker.bge-v2-m3');
  assert.ok(ref);
  assert.equal(ref.role, 'reranker');
  const bytes = await readFile(resolve(root, ref.manifest_path.replace('proprium/semantic/', '')));
  assert.equal(bytes.byteLength, ref.bytes);
  assert.equal(sha(bytes), ref.sha256);
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.schema, 'proprium.assets/v1');
  assert.equal(manifest.id, ref.id);
  assert.equal(manifest.version, source.revision);
  assert.equal(manifest.license, source.license);

  const expected = new Map(source.files.map(file => [file.path, file]));
  const dataFiles = manifest.files.filter(file => file.path.endsWith('/onnx/model.onnx_data'));
  let total = 0;
  let chunks = 0;
  for (const file of manifest.files) {
    const relative = file.path.replace('proprium/semantic/reranker/bge-reranker-v2-m3/', '');
    const pinned = expected.get(relative);
    if (relative === 'provenance.json') {
      const provenanceBytes = await readFile(resolve(root, 'reranker/provenance.json'));
      assert.equal(file.bytes, provenanceBytes.byteLength);
      assert.equal(file.sha256, sha(provenanceBytes));
    } else {
      assert.ok(pinned, `no source pin for ${relative}`);
      assert.equal(file.bytes, pinned.bytes);
      assert.equal(file.sha256, pinned.sha256);
    }
    let offset = 0;
    for (const chunk of file.chunks) {
      assert.equal(chunk.offset, offset);
      assert.ok(chunk.bytes > 0 && chunk.bytes <= 16 * 1024 * 1024);
      assert.equal(chunk.path, `proprium/semantic/chunks/${chunk.sha256}/chunk.bin`);
      offset += chunk.bytes;
      chunks += 1;
    }
    assert.equal(offset, file.bytes);
    total += file.bytes;
  }
  assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
  assert.equal(dataFiles.length, 1);
  assert.equal(dataFiles[0].bytes, 2_271_088_656);
  assert.equal(total, 2_288_661_281);
  assert.equal(chunks, 140);
  assert.ok(dataFiles[0].chunks.length > 100, 'large fp32 external data is split into bounded verified chunks');
});
