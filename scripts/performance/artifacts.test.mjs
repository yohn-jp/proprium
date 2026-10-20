import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pack, verify } from './artifacts.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
test('artifact round trip reproduces archives and rejects corrupt archive, gzip and raw evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-artifacts-'));
  try {
    const source = join(root, 'source'), index = join(root, 'INDEX.json'); await mkdir(source);
    const data = Buffer.from('{"synthetic":true}\n'), gzip = gzipSync(data, { level: 6 }); gzip[9] = 255;
    await writeFile(join(source, 'result.json'), data);
    const manifest = { schemaVersion: 1, artifacts: [{ file: 'raw/result.json.gz', sourceFile: 'result.json',
      sourceBytes: data.length, gzipBytes: gzip.length, sha256: hash(data), gzipSha256: hash(gzip), diagnostic: false }] };
    await writeFile(index, JSON.stringify(manifest));
    const url = 'https://github.com/yohn-jp/scriptorium/releases/download/test/evidence.tar';
    const a = await pack(index, source, join(root, 'a'), url);
    const b = await pack(join(root, 'a/INDEX.json'), source, join(root, 'b'), url);
    assert.deepEqual(a, b);
    assert.equal(await verify(join(root, 'a/INDEX.json'), join(root, 'a')), 1);
    await assert.rejects(pack(index, source, join(root, 'a'), url), { code: 'EEXIST' });
    await writeFile(join(root, 'a/evidence.tar'), 'corrupt');
    await assert.rejects(verify(join(root, 'a/INDEX.json'), join(root, 'a')), /mismatch: evidence.tar/);
    await writeFile(join(root, 'a/evidence.tar'), await readFile(join(root, 'b/evidence.tar')));
    await writeFile(join(root, 'a/raw/result.json.gz'), 'corrupt');
    await assert.rejects(verify(join(root, 'a/INDEX.json'), join(root, 'a')), /mismatch: raw/);
    await writeFile(join(root, 'a/raw/result.json.gz'), gzip);
    a.artifacts[0].sha256 = '0'.repeat(64); await writeFile(join(root, 'a/INDEX.json'), JSON.stringify(a));
    await assert.rejects(verify(join(root, 'a/INDEX.json'), join(root, 'a')), /mismatch: result.json/);
    await writeFile(join(source, 'result.json'), 'changed');
    await assert.rejects(pack(index, source, join(root, 'changed'), url), /mismatch: result.json/);
    manifest.artifacts[0].sourceFile = '../outside'; await writeFile(index, JSON.stringify(manifest));
    await assert.rejects(pack(index, source, join(root, 'unsafe'), url), /Unsafe source/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
