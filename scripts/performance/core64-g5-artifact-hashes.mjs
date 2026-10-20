import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node core64-g5-artifact-hashes.mjs <g5-results-root>');
const sources = [
  ['baseline', '9f801061d1cc40c4719988b5e1aef17d3ff60e74'],
  ['c59', '85504858418463354f9f54e4a3cd132aed80d0fd'],
  ['c60', '7bb2fb8a2df5bc1aacd5983feee3a4a13088da53'],
];
const outputs = [];
function hash(file) { return createHash('sha256').update(file).digest('hex'); }
function asset(base, name) {
  const bytes = readFileSync(resolve(base, name));
  return { file: name, bytes: bytes.length, gzip9: gzipSync(bytes, { level: 9 }).length, sha256: hash(bytes) };
}
for (const [source, sha] of sources) for (const profile of ['core', 'full']) {
  const dist = resolve(root, source, profile, 'dist');
  for (const ui of ['launcher', 'desktop', 'mobile']) {
    const base = ui === 'launcher' ? dist : join(dist, ui);
    const manifestPath = resolve(base, '.vite/manifest.json');
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const entry = Object.entries(manifest).find(([, chunk]) => chunk.isEntry && chunk.file === 'main.js')?.[0];
    const dynamicApp = manifest['src/App.tsx'];
    const cssFiles = [...new Set(Object.values(manifest).flatMap((chunk) => [
      ...(chunk.css ?? []),
      ...(/\.css$/iu.test(chunk.file ?? '') ? [chunk.file] : []),
    ]))].sort();
    outputs.push({
      source,
      sourceSha: sha,
      profile,
      ui,
      manifestSha256: hash(manifestBytes),
      entry,
      main: asset(base, manifest[entry].file),
      css: cssFiles.map((name) => asset(base, name)),
      dynamicApp: dynamicApp ? {
        file: asset(base, dynamicApp.file),
        css: (dynamicApp.css ?? []).map((name) => asset(base, name)),
      } : null,
    });
  }
}
console.log(JSON.stringify(outputs, null, 2));
