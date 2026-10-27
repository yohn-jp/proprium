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
    const manifest = { schema: 'proprium.assets/v1', id: 'test', version: '1', license: 'MIT', files: [file] };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const group = { id: 'test', manifest_path: `proprium/semantic/assets/manifests/${sha(manifestBytes)}/manifest.json`, bytes: manifestBytes.length, sha256: sha(manifestBytes), role: 'embedding' };
    await generatePinnedAssets({ manifestBytes, group, outputDirectory: dir, openFile: async () => [bytes] });
    assert.deepEqual(await readFile(join(dir, file.chunks[0].path.slice('proprium/semantic/'.length))), chunks[0]);
    assert.deepEqual(await readFile(join(dir, group.manifest_path.slice('proprium/semantic/'.length))), manifestBytes);
    await assert.rejects(generatePinnedAssets({ manifestBytes, group, outputDirectory: dir, openFile: async () => [Buffer.from('tampered source!')] }), /digest|size/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
