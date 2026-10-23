#!/usr/bin/env node
// Disposable native Producer contract check. Never pushes images or accesses production.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trustedModuleData } from './hosted-build.mjs';
import { resolveBuildCatalogSelection } from '../packages/module-runtime/dist/index.js';
import { hostedNativeComposeCases, parseHostedNativeSelection } from './hosted-native-selection.mjs';

const selection = parseHostedNativeSelection(process.argv.slice(2));
assert.equal(process.env.CI, 'true', 'This native contract check owns a disposable CI runner only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 30 * 60_000, ...options });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.match(sha, /^[a-f0-9]{40}$/u);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
const output = await mkdtemp(path.join(tmpdir(), 'scriptorium-hosted-verification-'));
const artifact = '/tmp/scriptorium-hosted-artifact';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const dockerfileHash = createHash('sha256').update(await readFile(path.join(root, 'Dockerfile'))).digest('hex');

function readOciBlob(archive, digest) {
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
  const bytes = execFileSync('tar', ['-xOf', archive, `blobs/sha256/${digest.slice(7)}`], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(hash(bytes), digest);
  return JSON.parse(bytes.toString('utf8'));
}

async function buildImage(target) {
  const archive = path.join(output, `${target}.tar`);
  const metadata = path.join(output, `${target}.json`);
  run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--target', target,
    '--build-arg', `SCRIPTORIUM_PRODUCER_REVISION=${sha}`,
    '--build-arg', `SCRIPTORIUM_DOCKERFILE_SHA256=${dockerfileHash}`,
    '--provenance=false', '--output', `type=oci,dest=${archive}`, '--metadata-file', metadata, '.']);
  const result = JSON.parse(await readFile(metadata, 'utf8'));
  const digest = result['containerimage.digest'];
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
  const index = JSON.parse(execFileSync('tar', ['-xOf', archive, 'index.json'], { encoding: 'utf8' }));
  assert.ok(index.manifests.some(item => item.digest === digest), 'Build metadata binds an exported OCI root');
  let manifest = readOciBlob(archive, digest);
  if (Array.isArray(manifest.manifests)) {
    const platform = manifest.manifests.find(item => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64');
    assert.ok(platform, 'OCI root includes the required platform');
    manifest = readOciBlob(archive, platform.digest);
  }
  const config = readOciBlob(archive, manifest.config.digest);
  assert.equal(config.os, 'linux');
  assert.equal(config.architecture, 'amd64');
  assert.equal(config.config.Labels['org.opencontainers.image.revision'], sha);
  return digest;
}

try {
  const runtimeBaseDigest = await buildImage('runtime-base');
  const buildKitDigest = await buildImage('buildkit');
  const catalogPath = path.join(output, 'catalog.json');
  run(process.execPath, ['scripts/hosted-build.mjs', 'catalog', '--producer-revision', sha,
    '--runtime-base-digest', runtimeBaseDigest, '--build-kit-digest', buildKitDigest, '--out', catalogPath]);
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const trusted = await trustedModuleData();
  assert.equal(catalog.producerRevision, sha);
  assert.equal(catalog.runtimeBaseDigest, runtimeBaseDigest);
  assert.equal(catalog.buildKitDigest, buildKitDigest);
  assert.equal(catalog.modules.length, trusted.length);

  const compositionResults = [];
  const cases = hostedNativeComposeCases(selection);
  if (cases.length > 0) {
    // Match Build Kit's online cache priming before each runner's offline native compose.
    // pnpm 12 supply-chain checks also need registry metadata, not just installed files.
    run(process.execPath, ['scripts/profile-package.mjs', '--modules-json', '[]', '--prebuilt',
      '--prime-deploy-cache', '--out', path.join(output, 'primed-app')]);
  }
  for (const composeCase of cases) {
    const requestedModules = [...composeCase.requestedModules];
    const resolved = resolveBuildCatalogSelection(catalog, requestedModules, trusted);
    const input = {
      contractVersion: catalog.contractVersion, producerRevision: sha, runtimeBaseDigest, buildKitDigest,
      recipeDigest: catalog.recipeDigest, sourceDigest: catalog.sourceDigest, lockDigest: catalog.lockDigest,
      requestedModules: [...requestedModules].sort(), resolvedModules: [...resolved.resolvedModules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      platform: 'linux/amd64', options: {},
    };
    const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
    run(process.execPath, ['scripts/hosted-build.mjs', 'compose', '--input-base64url', encoded,
      '--source', `ghcr.io/yohn-jp/scriptorium/verification@${buildKitDigest}`],
      { env: { ...process.env, SCRIPTORIUM_PRODUCER_REVISION: sha } });
    const metadataDir = path.join(artifact, 'usr/share/scriptorium');
    const report = JSON.parse(await readFile(path.join(metadataDir, 'build-artifact-report.json'), 'utf8'));
    assert.equal(report.buildKey, hash(Buffer.from(JSON.stringify(input))));
    const composedCatalog = JSON.parse(await readFile(path.join(metadataDir, 'build-catalog.json'), 'utf8'));
    assert.equal(composedCatalog.sourceDigest, catalog.sourceDigest);
    assert.equal(composedCatalog.recipeDigest, catalog.recipeDigest);
    assert.equal(composedCatalog.lockDigest, catalog.lockDigest);
    assert.equal(composedCatalog.runtimeBaseDigest, runtimeBaseDigest);
    assert.equal(composedCatalog.buildKitDigest, buildKitDigest);
    assert.equal(composedCatalog.producerRevision, sha);
    const manifest = JSON.parse(await readFile(path.join(metadataDir, 'composition-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.resolvedModules.map(item => item.id).sort(), resolved.resolvedModules.map(item => item.id).sort());
    compositionResults.push({
      selection: composeCase.name,
      requestedModules: [...requestedModules].sort(),
      resolvedModules: resolved.resolvedModules.map(item => item.id).sort(),
      buildKey: report.buildKey,
      composeMode: 'OFFLINE',
    });
  }
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  const result = {
    schemaVersion: 'scriptorium-hosted-native-verification/v1',
    acceptanceLevel: 'DISPOSABLE_NATIVE_PRODUCER',
    selection,
    sourceSha: sha,
    dockerfileSha256: dockerfileHash,
    runtimeBaseDigest,
    buildKitDigest,
    catalog: {
      result: 'PASS',
      producerRevision: catalog.producerRevision,
      sourceDigest: catalog.sourceDigest,
      recipeDigest: catalog.recipeDigest,
      lockDigest: catalog.lockDigest,
      moduleCount: catalog.modules.length,
    },
    compositions: compositionResults,
    publication: false,
    hostedRuntimeAcceptance: 'NOT_CHECKED',
  };
  const reportPath = path.resolve(process.env.SCRIPTORIUM_NATIVE_REPORT_PATH ?? path.join(tmpdir(), `scriptorium-hosted-native-${sha}-${selection}.json`));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, reportPath }));
} finally {
  await rm(output, { recursive: true, force: true });
  // This directory is the native Producer's fixed output, on this disposable runner only.
  if (process.env.CI === 'true') await rm(artifact, { recursive: true, force: true });
}
