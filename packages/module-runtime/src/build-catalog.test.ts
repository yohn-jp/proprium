import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuildCatalogSelection, type ProducerBuildCatalog, type TrustedBuildModule } from "./build-catalog.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const resources = { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 };
const trustedModules: TrustedBuildModule[] = [
  {
    manifest: {
      id: "story",
      version: "0.1.0",
      contractVersion: 1,
      dependencies: [],
      provides: [],
      requires: [],
      statePaths: ["manuscript"],
      locality: "local",
      serverEntry: "./dist/index.js",
      browserEntry: "./dist/browser.js",
    },
    artifactDigest: digest("a"),
    contractRange: "^1",
    conflicts: [],
    exclusiveResources: resources,
    sharedResourceGroupIds: [],
    workerLimits: {},
  },
  {
    manifest: {
      id: "nlp",
      version: "0.1.0",
      contractVersion: 1,
      dependencies: [],
      provides: ["nlp.tokenizer"],
      requires: [],
      statePaths: [],
      locality: "local",
      serverEntry: "./dist/index.js",
    },
    artifactDigest: digest("b"),
    contractRange: "^1",
    conflicts: [],
    exclusiveResources: resources,
    sharedResourceGroupIds: [],
    workerLimits: {},
  },
  {
    manifest: {
      id: "semantic",
      version: "0.1.0",
      contractVersion: 1,
      dependencies: ["story", "nlp"],
      provides: ["semantic.embedding"],
      requires: ["nlp.tokenizer"],
      statePaths: [],
      locality: "local",
      serverEntry: "./dist/index.js",
      browserEntry: "./dist/browser.js",
    },
    artifactDigest: digest("c"),
    contractRange: "^1",
    conflicts: [],
    exclusiveResources: resources,
    sharedResourceGroupIds: [],
    workerLimits: {},
  },
];

function catalogFor(modules: readonly TrustedBuildModule[]): ProducerBuildCatalog {
  return {
    contractVersion: "scriptorium-build/v1",
    producerRevision: "1".repeat(40),
    runtimeBaseDigest: digest("1"),
    buildKitDigest: digest("2"),
    recipeDigest: digest("3"),
    lockDigest: digest("4"),
    sourceDigest: digest("5"),
    supportedPlatforms: ["linux/amd64"],
    modules: modules.map(({ manifest, artifactDigest, contractRange, conflicts, exclusiveResources,
      sharedResourceGroupIds, workerLimits }) => ({
      id: manifest.id,
      version: manifest.version,
      artifactDigest,
      requires: [...manifest.dependencies].sort(),
      conflicts: [...conflicts],
      contractRange,
      exclusiveResources: { ...exclusiveResources },
      sharedResourceGroupIds: [...sharedResourceGroupIds],
      workerLimits: { ...workerLimits },
    })),
    baseResources: { ...resources },
    sharedResourceGroups: [],
    resourceProfiles: [],
  };
}

test("producer catalog resolves arbitrary selections through the exact module dependency closure", () => {
  const result = resolveBuildCatalogSelection(catalogFor(trustedModules), ["semantic"], trustedModules);
  assert.deepEqual(result.requestedModules, ["semantic"]);
  assert.deepEqual(result.resolvedModules.map(({ id }) => id), ["nlp", "semantic", "story"]);
  assert.deepEqual(result.moduleOrder, ["story", "nlp", "semantic"]);
  assert.deepEqual(result.resourceRequirements, resources);
});

test("producer catalog rejects changed trusted identities and unknown ABI fields", () => {
  const catalog = catalogFor(trustedModules);
  const changedDigest = structuredClone(catalog);
  changedDigest.modules[0]!.artifactDigest = digest("f");
  assert.throws(() => resolveBuildCatalogSelection(changedDigest, ["semantic"], trustedModules), /differs from the shipped module manifest/);

  const withUnknownField = { ...catalog, unrecognized: true };
  assert.throws(() => resolveBuildCatalogSelection(withUnknownField, [], trustedModules), /identity or collections are invalid/);
});

test("producer catalog accepts resource IDs from the shared contract slug namespace", () => {
  const modules = structuredClone(trustedModules);
  modules[1]!.sharedResourceGroupIds = ["worker-runtime"];
  const catalog = catalogFor(modules);
  catalog.sharedResourceGroups = [{
    id: "worker-runtime",
    resources: { cpuMilli: 10, memoryMiB: 20, ephemeralStorageMiB: 30 },
  }];
  catalog.resourceProfiles = [{ id: "small", cpuMilli: 100, memoryMiB: 200, ephemeralStorageMiB: 300 }];
  const selected = resolveBuildCatalogSelection(catalog, ["nlp"], modules);
  assert.deepEqual(selected.resourceRequirements, { cpuMilli: 10, memoryMiB: 20, ephemeralStorageMiB: 30 });

  const invalidGroup = structuredClone(catalog);
  invalidGroup.sharedResourceGroups[0]!.id = "Worker-runtime";
  assert.throws(() => resolveBuildCatalogSelection(invalidGroup, ["nlp"], modules), /shared resource group is invalid/u);

  const invalidProfile = structuredClone(catalog);
  invalidProfile.resourceProfiles[0]!.id = "small_profile";
  assert.throws(() => resolveBuildCatalogSelection(invalidProfile, ["nlp"], modules), /resource profiles are duplicated/u);

  const invalidReferenceModules = structuredClone(modules);
  invalidReferenceModules[1]!.sharedResourceGroupIds = ["Worker-runtime"];
  assert.throws(() => resolveBuildCatalogSelection(catalogFor(invalidReferenceModules), ["nlp"], invalidReferenceModules), /invalid module descriptor/u);
});
