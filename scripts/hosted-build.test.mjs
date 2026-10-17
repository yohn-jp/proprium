import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODULE_PERSISTENCE_FORMATS, resolveBuildCatalogSelection } from '../packages/module-runtime/dist/index.js';
import { catalogFor, persistenceForModules, resourceDeclarationFor } from './hosted-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleIds = ['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp'];

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
