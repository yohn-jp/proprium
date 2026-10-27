import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const jco = join(root, 'node_modules/.bin/jco');
const helper = fileURLToPath(new URL('./unicode.ts', import.meta.url));

test('Unicode normalization executes in a StarlingMonkey component', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proprium-unicode-'));
  try {
    await writeFile(join(directory, 'world.wit'), 'package proprium:test; world test { export normalize: func(value: string, form: string) -> string; }');
    await writeFile(join(directory, 'guest.ts'), `import { normalizeUnicode } from ${JSON.stringify(helper)}; export function normalize(value: string, form: string) { return normalizeUnicode(value, form as "NFC" | "NFD" | "NFKC" | "NFKD"); }`);
    execFileSync(jco, ['componentize', 'guest.ts', '--cwd', directory, '--wit', join(directory, 'world.wit'), '--world-name', 'test', '--disable', 'all', '--bundle', '-o', join(directory, 'component.wasm')], { cwd: directory, stdio: 'pipe' });
    execFileSync(jco, ['transpile', join(directory, 'component.wasm'), '-o', join(directory, 'out')], { cwd: directory, stdio: 'pipe' });
    const { normalize } = await import(pathToFileURL(join(directory, 'out/component.js')).href);
    assert.equal(normalize('ｶﾞＡ', 'NFKC'), 'ガA');
    assert.equal(normalize('が', 'NFD'), 'か\u3099');
    assert.equal(normalize('\u1100\u1161', 'NFC'), '가');
    assert.equal(normalize('🌸\u212b', 'NFKD'), '🌸A\u030a');
    const corpusPath = process.env.PROPRIUM_UNICODE_NORMALIZATION_TEST;
    if (corpusPath) {
      const bytes = await readFile(corpusPath);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), '5019ffd530751a741900c849c0e010332f142a3612234639bd200b82138a87db');
      const forms = ['NFC', 'NFD', 'NFKC', 'NFKD'];
      const text = source => String.fromCodePoint(...source.trim().split(/\s+/u).map(cp => parseInt(cp, 16)));
      let rows = 0;
      for (const line of bytes.toString('utf8').split('\n')) {
        const head = line.split('#')[0].trim(); if (!head || head.startsWith('@')) continue;
        const c = head.split(';').slice(0, 5).map(text);
        for (let f = 0; f < forms.length; f++) for (let i = 0; i < 5; i++) {
          const expected = f === 0 ? (i < 3 ? c[1] : c[3]) : f === 1 ? (i < 3 ? c[2] : c[4]) : f === 2 ? c[3] : c[4];
          assert.equal(normalize(c[i], forms[f]), expected, `${forms[f]} column ${i}: ${head}`);
        }
        rows++;
      }
      assert.equal(rows, 20034);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
