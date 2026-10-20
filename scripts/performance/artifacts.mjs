import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const sha256 = data => createHash('sha256').update(data).digest('hex');
function check(condition, message) { if (!condition) throw new Error(message); }
function inventory(manifest) {
  check([1, 2].includes(manifest.schemaVersion), 'Unsupported manifest schema');
  check(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'Empty artifact inventory');
  const seen = new Set();
  for (const row of manifest.artifacts) {
    check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.sourceFile), 'Unsafe source filename');
    check(row.file === `raw/${row.sourceFile}.gz`, 'Unsafe archive member');
    check(!seen.has(row.file), 'Duplicate archive member'); seen.add(row.file);
    for (const field of ['sha256', 'gzipSha256']) check(/^[a-f0-9]{64}$/.test(row[field]), `Invalid ${field}`);
  }
}
function equalBytes(data, bytes, hash, name) {
  check(data.length === bytes && sha256(data) === hash, `Size/SHA-256 mismatch: ${name}`);
}

// OUTPUT must be new. INDEX is also the inventory/recipe, including diagnostics.
export async function pack(indexPath, sourceDirectory, outputDirectory, assetUrl) {
  const input = JSON.parse(await readFile(indexPath, 'utf8')); inventory(input);
  const url = new URL(assetUrl);
  check(url.protocol === 'https:' && !url.search && !url.hash, 'Use a permanent HTTPS asset URL');
  const archiveFile = basename(url.pathname);
  check(/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/.test(archiveFile), 'Asset must have a .tar filename');
  await mkdir(outputDirectory); await mkdir(join(outputDirectory, 'raw'));
  for (const row of input.artifacts) {
    const source = await readFile(join(sourceDirectory, row.sourceFile));
    equalBytes(source, row.sourceBytes, row.sha256, row.sourceFile);
    const compressed = gzipSync(source, { level: 6, mtime: 0 });
    // RFC 1952 OS=unknown: independent of the host OS, matching the original evidence.
    compressed[9] = 255;
    equalBytes(compressed, row.gzipBytes, row.gzipSha256, row.file);
    await writeFile(join(outputDirectory, row.file), compressed);
  }
  // GNU tar's fixed metadata makes repeated packaging byte-identical.
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--mode=u=rwX,go=rX', '--format=ustar', '-cf', resolve(outputDirectory, archiveFile),
    '-C', resolve(outputDirectory), 'raw'], { env: { ...process.env, TAR_OPTIONS: '', LC_ALL: 'C' } });
  const archive = await readFile(join(outputDirectory, archiveFile));
  const manifest = {
    schemaVersion: 2,
    storage: { type: 'github-release-asset', url: url.href, file: archiveFile,
      bytes: archive.length, sha256: sha256(archive) },
    compression: { format: 'gzip', level: 6, mtime: 0, os: 255 },
    packaging: 'GNU tar: ustar, name sort, epoch mtime, uid/gid 0, directories 0755, files 0644',
    artifacts: input.artifacts,
  };
  await writeFile(join(outputDirectory, 'INDEX.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Check the downloaded archive before extracting it.
export async function verifyArchive(indexPath, root) {
  const manifest = JSON.parse(await readFile(indexPath, 'utf8')); inventory(manifest);
  check(manifest.schemaVersion === 2, 'External manifest required');
  const storage = manifest.storage;
  check(storage && /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/.test(storage.file), 'Unsafe archive filename');
  equalBytes(await readFile(join(root, storage.file)), storage.bytes, storage.sha256, storage.file);
  return manifest;
}

// ROOT contains both the downloaded .tar and its extracted raw/ directory.
export async function verify(indexPath, root) {
  const manifest = await verifyArchive(indexPath, root);
  for (const row of manifest.artifacts) {
    const compressed = await readFile(join(root, row.file));
    equalBytes(compressed, row.gzipBytes, row.gzipSha256, row.file);
    equalBytes(gunzipSync(compressed), row.sourceBytes, row.sha256, row.sourceFile);
  }
  return manifest.artifacts.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, index, ...args] = process.argv.slice(2);
  if (command === 'pack' && args.length === 3) {
    const manifest = await pack(index, ...args);
    console.log(`Packaged ${manifest.artifacts.length} artifacts; archive SHA-256 ${manifest.storage.sha256}`);
  } else if (command === 'verify-archive' && args.length === 1) {
    const manifest = await verifyArchive(index, args[0]);
    console.log(`Verified archive SHA-256 ${manifest.storage.sha256}`);
  } else if (command === 'verify' && args.length === 1) {
    console.log(`Verified ${await verify(index, args[0])} artifacts and archive`);
  } else {
    throw new Error('Usage: artifacts.mjs pack INDEX SOURCE NEW_OUTPUT HTTPS_ASSET_URL | (verify-archive | verify) INDEX DOWNLOADED_AND_EXTRACTED_ROOT');
  }
}
