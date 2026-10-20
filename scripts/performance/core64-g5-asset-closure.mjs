import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node asset-report.mjs <app-dist-root>');
const profiles = ['launcher', 'desktop', 'mobile'];
const typeOf = (file) => /\.css$/iu.test(file) ? 'css' : /\.(?:m?js)$/iu.test(file) ? 'js' : 'other';
const rows = [];
for (const profile of profiles) {
  const base = profile === 'launcher' ? root : resolve(root, profile);
  const manifestPath = resolve(base, '.vite/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = Object.entries(manifest).find(([, chunk]) => chunk.isEntry && chunk.file === 'main.js')?.[0];
  if (!entry) throw new Error('missing main.js entry in ' + manifestPath);
  const staticKeys = new Set();
  const dynamicRoots = new Set();
  const staticFiles = new Set(['index.html']);
  const allDynamicFiles = new Set();
  function visitStatic(key, keys, files, recordDynamicRoots = false) {
    if (keys.has(key)) return;
    keys.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error('missing manifest chunk ' + key + ' in ' + manifestPath);
    if (chunk.file) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) visitStatic(imported, keys, files, recordDynamicRoots);
    if (recordDynamicRoots) for (const imported of chunk.dynamicImports ?? []) dynamicRoots.add(imported);
  }
  visitStatic(entry, staticKeys, staticFiles, true);
  const cssEntryFiles = new Set(Object.values(manifest)
    .filter((chunk) => /\.css$/iu.test(chunk.file ?? '') && chunk.src === 'style.css')
    .map((chunk) => chunk.file));
  for (const file of cssEntryFiles) staticFiles.add(file);
  for (const key of dynamicRoots) visitStatic(key, new Set(), allDynamicFiles, false);
  const dynamicFiles = new Set([...allDynamicFiles].filter((file) => !staticFiles.has(file)));
  function measure(files) {
    return [...files].sort().map((file) => {
      const path = resolve(base, file);
      if (!existsSync(path)) throw new Error('manifest asset missing: ' + path);
      const bytes = readFileSync(path);
      const type = typeOf(file);
      return {
        file,
        type,
        bytes: bytes.length,
        gzip9: gzipSync(bytes, { level: 9 }).length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
  }
  const staticRows = measure(staticFiles);
  const dynamicRows = measure(dynamicFiles);
  function totals(items) {
    return Object.fromEntries(['js', 'css', 'other'].map((type) => [type, Object.fromEntries(['bytes', 'gzip9'].map((field) => [field, items.filter((item) => item.type === type).reduce((sum, item) => sum + item[field], 0)]))]));
  }
  const cssOwners = new Map();
  for (const file of cssEntryFiles) cssOwners.set(file, ['index.html stylesheet']);
  for (const [key, chunk] of Object.entries(manifest)) for (const file of chunk.css ?? []) {
    if (!cssOwners.has(file)) cssOwners.set(file, []);
    cssOwners.get(file).push(key);
  }
  function walk(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(path));
      else if (/\.css$/iu.test(entry.name)) found.push(relative(base, path));
    }
    return found.sort();
  }
  rows.push({
    profile,
    base,
    manifest: relative(base, manifestPath),
    entry,
    staticKeys: [...staticKeys].sort(),
    staticCssEntryFiles: [...cssEntryFiles].sort(),
    dynamicRoots: [...dynamicRoots].sort(),
    static: { totals: totals(staticRows), files: staticRows },
    immediateDynamicImportUnionIncremental: { totals: totals(dynamicRows), files: dynamicRows },
    emittedCssFiles: walk(base),
    cssOwners: Object.fromEntries([...cssOwners.entries()].sort(([a], [b]) => a.localeCompare(b))),
    cssFileNameReferences: Object.fromEntries([...cssOwners.entries()].filter(([file]) => /(?:^|\/)styles(?:-\d+)?\.css$/iu.test(file)).sort(([a], [b]) => a.localeCompare(b))),
  });
}
console.log(JSON.stringify({ root, profiles: rows }, null, 2));
