import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODULE_PERSISTENCE_FORMATS, resolveBuildCatalogSelection } from '../packages/module-runtime/dist/index.js';
import { assertCleanRevisionSnapshot, browserManifestEntryFiles, calculateBuildDigests, canonicalJson, catalogFor, persistenceForModules, resourceDeclarationFor } from './hosted-build.mjs';
import { assertSigstoreBundleMatches, assertSupportedCosignVersion, createSlsaStatement } from './hosted-attestation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleIds = ['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp', 'search'];

test('hosted source inventory excludes developer performance symlinks without disabling source validation', async () => {
  // scripts/performance/podman is a tracked development-only symlink.
  // The hosted source digest must not traverse that unrelated directory.
  const digests = await calculateBuildDigests();
  assert.match(digests.sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(digests.recipeDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(digests.lockDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('hosted browser artifact binding follows hashed Vite entry and stylesheet files', () => {
  assert.deepEqual(browserManifestEntryFiles({
    'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true },
    'style.css': { file: 'assets/styles-EfGh5678.css' },
  }), {
    entryFile: 'assets/index-AbCd1234.js',
    stylesheetFiles: ['assets/styles-EfGh5678.css'],
  });
  assert.deepEqual(browserManifestEntryFiles({
    'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true, css: ['assets/styles-EfGh5678.css'] },
  }), {
    entryFile: 'assets/index-AbCd1234.js',
    stylesheetFiles: ['assets/styles-EfGh5678.css'],
  });
  assert.throws(() => browserManifestEntryFiles({
    'index.html': { file: 'main.js', isEntry: true },
    'style.css': { file: 'styles.css' },
  }), /content-hashed application entry/u);
  assert.throws(() => browserManifestEntryFiles({
    'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true },
    'style.css': { file: '../styles.css' },
  }), /content-hashed application stylesheet/u);
});

async function shippedModuleData() {
  const trustedModules = await Promise.all(moduleIds.map(async (id) => {
    const bytes = await readFile(path.join(root, 'modules', id, 'package.json'));
    const manifest = JSON.parse(bytes.toString('utf8')).scriptoriumModule;
    return {
      manifest,
      artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      contractRange: '^1',
      conflicts: [],
      ...resourceDeclarationFor(manifest),
    };
  }));
  const catalog = catalogFor({
    producerRevision: 'a'.repeat(40),
    runtimeBaseDigest: `sha256:${'1'.repeat(64)}`,
    buildKitDigest: `sha256:${'2'.repeat(64)}`,
    recipeDigest: `sha256:${'3'.repeat(64)}`,
    lockDigest: `sha256:${'4'.repeat(64)}`,
    sourceDigest: `sha256:${'5'.repeat(64)}`,
  }, trustedModules);
  return { catalog, trustedModules };
}

test('composition persistence declares base and selected module readers/writers only', () => {
  const persistence = persistenceForModules(['publishing', 'story'], MODULE_PERSISTENCE_FORMATS);
  const readable = new Map(persistence.readable.map(({ formatId, versions }) => [formatId, versions]));
  const writable = new Set(persistence.writable.map(({ formatId, version }) => `${formatId}@${version}`));

  assert.deepEqual(readable.get('scriptorium.git-operations'), [1]);
  assert.deepEqual(readable.get('scriptorium.git-proposal-legacy'), [1]);
  assert.deepEqual(readable.get('scriptorium.browser-recovery-indexeddb'), [3]);
  assert.deepEqual(readable.get('scriptorium.module-story.series'), [1]);
  assert.deepEqual(readable.get('scriptorium.module-publishing.cover'), [1]);
  assert.equal(readable.has('scriptorium.module-story.change-sets'), false);
  assert.equal(readable.has('scriptorium.module-assistant.model-settings'), false);
  assert.equal(writable.has('scriptorium.module-publishing.cover@1'), false);
  assert.equal(writable.has('scriptorium.module-story.series@1'), true);
  assert.equal(persistence.contractVersion, 'scriptorium-persistence/v1');
});

test('composition persistence rejects duplicate module selections', () => {
  assert.throws(() => persistenceForModules(['story', 'story'], MODULE_PERSISTENCE_FORMATS), /unique/u);
});

test('hosted resource catalog covers Core, worker closures, and the full shipped selection', async () => {
  const { catalog, trustedModules } = await shippedModuleData();
  assert.deepEqual(catalog.baseResources, { cpuMilli: 250, memoryMiB: 256, ephemeralStorageMiB: 512 });
  assert.deepEqual(catalog.resourceProfiles, [
    { id: 'small', cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 1024 },
    { id: 'balanced', cpuMilli: 2000, memoryMiB: 4096, ephemeralStorageMiB: 8192 },
    { id: 'large', cpuMilli: 4000, memoryMiB: 8192, ephemeralStorageMiB: 16384 },
  ]);
  assert.equal(catalog.resourceProfiles.length, 3);
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'story').sharedResourceGroupIds, []);
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'mcp').sharedResourceGroupIds, []);
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'nlp').sharedResourceGroupIds, ['worker-runtime']);
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'semantic').sharedResourceGroupIds, ['semantic-models', 'worker-runtime']);
  const expectedWorkerLimits = {
    maxConcurrentJobs: 8,
    maxQueuedJobs: 8,
    maxWorkerServices: 8,
    maxConcurrentServiceJobs: 1,
    maxQueuedServiceJobs: 4,
  };
  for (const module of catalog.modules) {
    assert.deepEqual(module.workerLimits, trustedModules.find(({ manifest }) => manifest.id === module.id).manifest.workerEntry ? expectedWorkerLimits : {});
  }

  const core = resolveBuildCatalogSelection(catalog, [], trustedModules);
  assert.deepEqual(core.resourceRequirements, catalog.baseResources);
  const storyAndMcp = resolveBuildCatalogSelection(catalog, ['story', 'mcp'], trustedModules);
  assert.deepEqual(storyAndMcp.resourceRequirements, catalog.baseResources);
  const small = catalog.resourceProfiles.find(({ id }) => id === 'small');
  for (const requirements of [core.resourceRequirements, storyAndMcp.resourceRequirements]) {
    for (const key of ['cpuMilli', 'memoryMiB', 'ephemeralStorageMiB']) {
      assert.ok(requirements[key] <= small[key], `Core/add-on selection fits small ${key} allocation`);
    }
  }

  const semantic = resolveBuildCatalogSelection(catalog, ['semantic'], trustedModules);
  assert.deepEqual(semantic.resourceRequirements, {
    cpuMilli: 2250,
    memoryMiB: 6400,
    ephemeralStorageMiB: 5120,
  }, 'dependency closures charge the shared worker and semantic model pools once');
  const full = resolveBuildCatalogSelection(catalog, moduleIds, trustedModules);
  assert.equal(full.resolvedModules.length, moduleIds.length);
  assert.deepEqual(full.resourceRequirements, semantic.resourceRequirements);
  const large = catalog.resourceProfiles.find(({ id }) => id === 'large');
  for (const key of ['cpuMilli', 'memoryMiB', 'ephemeralStorageMiB']) {
    assert.ok(full.resourceRequirements[key] <= large[key], `full closure fits large ${key} allocation`);
  }
  assert.ok(full.resourceRequirements.memoryMiB > catalog.resourceProfiles.find(({ id }) => id === 'balanced').memoryMiB);
});

const hostedRevision = '1'.repeat(40);
const runtimeBaseDigest = `sha256:${'a'.repeat(64)}`;
const buildKitDigest = `sha256:${'b'.repeat(64)}`;
const sourceDigest = `sha256:${'c'.repeat(64)}`;
const recipeDigest = `sha256:${'d'.repeat(64)}`;
const lockDigest = `sha256:${'e'.repeat(64)}`;

function hostedAttestationFixture() {
  const catalog = {
    contractVersion: 'scriptorium-build/v1',
    producerRevision: hostedRevision,
    runtimeBaseDigest,
    buildKitDigest,
    sourceDigest,
    recipeDigest,
    lockDigest,
  };
  const runtimeMetadata = { contractVersion: 'scriptorium-platform/v1', producerRevision: hostedRevision };
  const catalogBytes = Buffer.from(canonicalJson(catalog), 'utf8');
  const runtimeMetadataBytes = Buffer.from(canonicalJson(runtimeMetadata), 'utf8');
  const statement = createSlsaStatement({
    producerRevision: hostedRevision,
    runtimeBaseImage: `ghcr.io/yohn-jp/scriptorium/runtime-base@${runtimeBaseDigest}`,
    buildKitImage: `ghcr.io/yohn-jp/scriptorium/build-kit@${buildKitDigest}`,
    catalog,
    runtimeMetadata,
    catalogBytes,
    runtimeMetadataBytes,
    sourceDigests: { sourceDigest, recipeDigest, lockDigest },
    startedOn: '2026-10-17T00:00:00.000Z',
    finishedOn: '2026-10-17T00:00:01.000Z',
    invocationId: 'urn:uuid:acb3c4d5-abcdef01-2345-6789-abcdef012345',
  });
  return { catalog, runtimeMetadata, catalogBytes, runtimeMetadataBytes, statement };
}

test('SLSA statement has exactly the signed Runtime Base and canonical metadata subjects', () => {
  const { catalogBytes, runtimeMetadataBytes, statement } = hostedAttestationFixture();
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(statement.subject, [
    { name: 'ghcr.io/yohn-jp/scriptorium/runtime-base', digest: { sha256: 'a'.repeat(64) } },
    { name: 'scriptorium-build/v1/catalog.json', digest: { sha256: digest(catalogBytes) } },
    { name: 'scriptorium-platform/v1/runtime-metadata.json', digest: { sha256: digest(runtimeMetadataBytes) } },
  ]);
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1');
  assert.equal(statement.predicate.buildDefinition.buildType, `https://github.com/yohn-jp/scriptorium/blob/${hostedRevision}/Dockerfile`);
  assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some((item) =>
    item.uri === 'git+https://github.com/yohn-jp/scriptorium' && item.digest.gitCommit === hostedRevision));
  assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some((item) =>
    item.uri === 'https://github.com/yohn-jp/scriptorium/source-inventory/v1' && item.digest.sha256 === 'c'.repeat(64)));
  assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some((item) =>
    item.uri === 'oci://ghcr.io/yohn-jp/scriptorium/build-kit' && item.digest.sha256 === 'b'.repeat(64)));
});

test('SLSA construction rejects image, metadata, source digest, or revision mismatches', () => {
  const input = hostedAttestationFixture();
  const make = (changes = {}) => createSlsaStatement({
    producerRevision: hostedRevision,
    runtimeBaseImage: `ghcr.io/yohn-jp/scriptorium/runtime-base@${runtimeBaseDigest}`,
    buildKitImage: `ghcr.io/yohn-jp/scriptorium/build-kit@${buildKitDigest}`,
    catalog: input.catalog,
    runtimeMetadata: input.runtimeMetadata,
    catalogBytes: input.catalogBytes,
    runtimeMetadataBytes: input.runtimeMetadataBytes,
    sourceDigests: { sourceDigest, recipeDigest, lockDigest },
    ...changes,
  });
  assert.throws(() => make({ producerRevision: '2'.repeat(40) }), /producer revision|catalog does not bind/u);
  assert.throws(() => make({ runtimeBaseImage: `ghcr.io/yohn-jp/scriptorium/runtime-base@sha256:${'f'.repeat(64)}` }), /catalog does not bind/u);
  assert.throws(() => make({ buildKitImage: `ghcr.io/yohn-jp/scriptorium/build-kit@sha256:${'f'.repeat(64)}` }), /catalog does not bind/u);
  assert.throws(() => make({ sourceDigests: { sourceDigest: `sha256:${'f'.repeat(64)}`, recipeDigest, lockDigest } }), /sourceDigest/u);
  assert.throws(() => make({ runtimeMetadata: { ...input.runtimeMetadata, producerRevision: '2'.repeat(40) } }), /runtime metadata/u);
});

test('source must be the clean checked-out commit named by the catalog', () => {
  assert.doesNotThrow(() => assertCleanRevisionSnapshot({ head: hostedRevision, status: '', producerRevision: hostedRevision }));
  assert.throws(() => assertCleanRevisionSnapshot({ head: hostedRevision, status: ' M scripts/hosted-build.mjs\n', producerRevision: hostedRevision }), /clean producer checkout/u);
  assert.throws(() => assertCleanRevisionSnapshot({ head: hostedRevision, status: '', producerRevision: '2'.repeat(40) }), /checked out Git HEAD/u);
});

test('unsigned or altered fake Sigstore bundle is rejected before it can be published', () => {
  const { statement } = hostedAttestationFixture();
  const statementBytes = Buffer.from(canonicalJson(statement), 'utf8');
  const unsigned = {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: 'ZmFrZQ==' },
      tlogEntries: [{ logId: { keyId: 'ZmFrZQ==' }, kindVersion: { kind: 'dsse', version: '0.0.1' }, inclusionProof: { checkpoint: { envelope: 'ZmFrZQ==' } } }],
    },
    dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: statementBytes.toString('base64'), signatures: [] },
  };
  assert.throws(() => assertSigstoreBundleMatches(unsigned, statementBytes), /unsigned/u);
  assert.throws(() => assertSigstoreBundleMatches({
    ...unsigned,
    dsseEnvelope: { ...unsigned.dsseEnvelope, signatures: [{ sig: 'ZmFrZQ==' }] },
  }, Buffer.from('{}')), /exact canonical SLSA statement/u);
});

test('Cosign identity verification rejects versions affected by GHSA-fx35-mq7g-6g98', () => {
  assert.throws(() => assertSupportedCosignVersion('v2.6.4'), /GHSA-fx35-mq7g-6g98/u);
  assert.doesNotThrow(() => assertSupportedCosignVersion('v2.6.5'));
  assert.doesNotThrow(() => assertSupportedCosignVersion('2.7.0'));
  assert.throws(() => assertSupportedCosignVersion('v3.1.2'), /GHSA-fx35-mq7g-6g98/u);
  assert.doesNotThrow(() => assertSupportedCosignVersion('v3.1.3'));
  assert.doesNotThrow(() => assertSupportedCosignVersion('v3.2.0'));
  assert.throws(() => assertSupportedCosignVersion('v2.6.5-rc.1'), /GHSA-fx35-mq7g-6g98/u);
  assert.throws(() => assertSupportedCosignVersion('v4.0.0'), /GHSA-fx35-mq7g-6g98/u);
});
