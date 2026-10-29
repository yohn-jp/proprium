import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePinnedAssets } from './asset-build.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('generates content-addressed chunks and rejects altered source bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-assets-test-'));
  try {
    const bytes = Buffer.from('pinned test model');
    const chunks = [bytes.subarray(0, 6), bytes.subarray(6)];
    const file = { path: 'proprium/semantic/embedding/e5-small/model.onnx', bytes: bytes.length, sha256: sha(bytes), chunks: chunks.map((chunk, i) => ({ path: `proprium/semantic/chunks/${sha(chunk)}/model.${i}.bin`, offset: i ? 6 : 0, bytes: chunk.length, sha256: sha(chunk) })) };
    const manifest = { schema: 'proprium.assets/v1', id: 'proprium.semantic.embedding.e5-small', version: '1', license: 'MIT', files: [file] };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const group = { id: 'proprium.semantic.embedding.e5-small', manifest_path: `proprium/semantic/assets/manifests/${sha(manifestBytes)}/manifest.json`, bytes: manifestBytes.length, sha256: sha(manifestBytes), role: 'embedding' };
    await generatePinnedAssets({ manifestBytes, group, outputDirectory: dir, openFile: async () => [bytes] });
    assert.deepEqual(await readFile(join(dir, file.chunks[0].path.slice('proprium/semantic/'.length))), chunks[0]);
    assert.deepEqual(await readFile(join(dir, group.manifest_path.slice('proprium/semantic/'.length))), manifestBytes);
    await assert.rejects(generatePinnedAssets({ manifestBytes, group, outputDirectory: dir, openFile: async () => [Buffer.from('tampered source!')] }), /digest|size/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generates signed-content-addressed BGE chunks while keeping asset-group identities separate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-bge-assets-test-'));
  try {
    const bytes = Buffer.from('pinned fp32 reranker');
    const path = 'proprium/semantic/reranker/bge-reranker-v2-m3/onnx/model.onnx';
    const digest = sha(bytes);
    const manifest = { schema: 'proprium.assets/v1', id: 'proprium.semantic.reranker.bge-v2-m3', version: 'r1', license: 'Apache-2.0',
      files: [{ path, bytes: bytes.length, sha256: digest, chunks: [{ path: `proprium/semantic/chunks/${digest}/chunk.bin`, offset: 0, bytes: bytes.length, sha256: digest }] }] };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const group = { id: manifest.id, manifest_path: `proprium/semantic/assets/manifests/${sha(manifestBytes)}/manifest.json`,
      bytes: manifestBytes.length, sha256: sha(manifestBytes), role: 'reranker' };
    await generatePinnedAssets({ manifestBytes, group, outputDirectory: dir, openFile: async () => [bytes] });
    assert.deepEqual(await readFile(join(dir, 'chunks', digest, 'chunk.bin')), bytes);
    await assert.rejects(generatePinnedAssets({ manifestBytes, group: { ...group, role: 'embedding' }, outputDirectory: dir,
      openFile: async () => [bytes] }), /Unsupported Semantic asset group/u);
    const crossed = { ...manifest, files: [{ ...manifest.files[0], path: manifest.files[0].path.replace('/reranker/', '/embedding/') }] };
    const crossedBytes = Buffer.from(JSON.stringify(crossed));
    await assert.rejects(generatePinnedAssets({ manifestBytes: crossedBytes, group: { ...group,
      manifest_path: `proprium/semantic/assets/manifests/${sha(crossedBytes)}/manifest.json`, bytes: crossedBytes.length, sha256: sha(crossedBytes) },
      outputDirectory: dir, openFile: async () => [bytes] }), /Invalid Semantic file metadata/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
