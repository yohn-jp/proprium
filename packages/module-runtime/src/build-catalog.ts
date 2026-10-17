import type { ModuleId, ModuleManifest } from "@scriptorium/contracts";
import { resolveModulePlan } from "./module-plan.js";
import { isModuleId, ModuleRuntimeError } from "./runtime-error.js";

type ResourceAmounts = {
  cpuMilli: number;
  memoryMiB: number;
  ephemeralStorageMiB: number;
};

/** The wire fields are the strict `BuildCatalogSchema` in Praetorium's contracts. */
export type ProducerBuildCatalog = {
  contractVersion: "scriptorium-build/v1";
  producerRevision: string;
  runtimeBaseDigest: string;
  buildKitDigest: string;
  recipeDigest: string;
  lockDigest: string;
  sourceDigest: string;
  supportedPlatforms: string[];
  modules: ProducerBuildModule[];
  baseResources: ResourceAmounts;
  sharedResourceGroups: Array<{ id: string; resources: ResourceAmounts }>;
  resourceProfiles: Array<{ id: string } & ResourceAmounts>;
};

export type ProducerBuildModule = {
  id: string;
  version: string;
  artifactDigest: string;
  requires: string[];
  conflicts: string[];
  contractRange: string;
  exclusiveResources: ResourceAmounts;
  sharedResourceGroupIds: string[];
  workerLimits: Record<string, number>;
};

/** Trusted descriptors are generated from the shipped module package manifests. */
export type TrustedBuildModule = {
  manifest: ModuleManifest;
  /** SHA-256 of the installed package.json + dist file tree for this producer revision. */
  artifactDigest: string;
  contractRange: string;
  conflicts: readonly string[];
  exclusiveResources: ResourceAmounts;
  sharedResourceGroupIds: readonly string[];
  workerLimits: Readonly<Record<string, number>>;
};

export type ResolvedBuildCatalogSelection = {
  requestedModules: ModuleId[];
  resolvedModules: Array<{ id: ModuleId; version: string; artifactDigest: string }>;
  resourceRequirements: ResourceAmounts;
  moduleOrder: ModuleId[];
};

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const CONTRACT_RANGE = /^\^1(?:\.0(?:\.0)?)?$/u;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/u;

function fail(message: string): never {
  throw new ModuleRuntimeError("invalid_build_catalog", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResourceId(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_ID.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function resourceAmounts(value: unknown, label: string): ResourceAmounts {
  if (!isRecord(value) || !hasExactKeys(value, ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"])) {
    fail(`Build catalog ${label} is invalid`);
  }
  const amounts = [value.cpuMilli, value.memoryMiB, value.ephemeralStorageMiB];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || (amount as number) < 0)) {
    fail(`Build catalog ${label} is invalid`);
  }
  return {
    cpuMilli: value.cpuMilli as number,
    memoryMiB: value.memoryMiB as number,
    ephemeralStorageMiB: value.ephemeralStorageMiB as number,
  };
}

function addResources(target: ResourceAmounts, value: ResourceAmounts): void {
  target.cpuMilli += value.cpuMilli;
  target.memoryMiB += value.memoryMiB;
  target.ephemeralStorageMiB += value.ephemeralStorageMiB;
  if (Object.values(target).some((amount) => !Number.isSafeInteger(amount))) {
    fail("Build catalog resource total exceeds the supported integer range");
  }
}

/**
 * Resolves an immutable producer catalog using the exact installed module
 * manifests that were embedded by the producer build. The output is sorted
 * for the `scriptorium-build/v1` canonical input and carries dependency order
 * separately for execution.
 */
export function resolveBuildCatalogSelection(
  catalogValue: unknown,
  requestedModuleIds: readonly string[],
  trustedModules: readonly TrustedBuildModule[],
): ResolvedBuildCatalogSelection {
  if (!isRecord(catalogValue) || catalogValue.contractVersion !== "scriptorium-build/v1") {
    fail("Build catalog contract version is unsupported");
  }
  if (!Array.isArray(requestedModuleIds) || requestedModuleIds.length > 256 ||
      requestedModuleIds.some((id) => typeof id !== "string") ||
      new Set(requestedModuleIds).size !== requestedModuleIds.length) {
    fail("Requested module IDs are invalid or duplicated");
  }
  const catalog = catalogValue as unknown as ProducerBuildCatalog;
  if (!hasExactKeys(catalogValue, [
        "contractVersion", "producerRevision", "runtimeBaseDigest", "buildKitDigest", "recipeDigest",
        "lockDigest", "sourceDigest", "supportedPlatforms", "modules", "baseResources",
        "sharedResourceGroups", "resourceProfiles",
      ]) ||
      !REVISION.test(catalog.producerRevision ?? "") ||
      !DIGEST.test(catalog.runtimeBaseDigest ?? "") ||
      !DIGEST.test(catalog.buildKitDigest ?? "") ||
      !DIGEST.test(catalog.recipeDigest ?? "") ||
      !DIGEST.test(catalog.lockDigest ?? "") ||
      !DIGEST.test(catalog.sourceDigest ?? "") ||
      !Array.isArray(catalog.supportedPlatforms) || catalog.supportedPlatforms.length === 0 ||
      !Array.isArray(catalog.modules) || !Array.isArray(catalog.sharedResourceGroups) ||
      !Array.isArray(catalog.resourceProfiles) || catalog.modules.length > 256 ||
      catalog.supportedPlatforms.length > 32 || catalog.sharedResourceGroups.length > 256 ||
      catalog.resourceProfiles.length > 256) {
    fail("Build catalog identity or collections are invalid");
  }
  const baseResources = resourceAmounts(catalog.baseResources, "base resources");
  if (new Set(catalog.supportedPlatforms).size !== catalog.supportedPlatforms.length ||
      catalog.supportedPlatforms.some((platform) => typeof platform !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}\/[a-z0-9][a-z0-9._-]{0,31}$/u.test(platform))) {
    fail("Build catalog platforms are invalid or duplicated");
  }
  if (catalog.modules.length !== trustedModules.length ||
      new Set(catalog.modules.map(({ id }) => id)).size !== catalog.modules.length ||
      new Set(trustedModules.map(({ manifest }) => manifest.id)).size !== trustedModules.length) {
    fail("Build catalog module set does not match the producer's shipped modules");
  }

  const trustedById = new Map(trustedModules.map((item) => [item.manifest.id, item]));
  const catalogById = new Map<string, ProducerBuildModule>();
  for (const module of catalog.modules) {
    if (!isRecord(module) || !hasExactKeys(module, [
          "id", "version", "artifactDigest", "requires", "conflicts", "contractRange",
          "exclusiveResources", "sharedResourceGroupIds", "workerLimits",
        ]) || typeof module.id !== "string" || !isModuleId(module.id) ||
        typeof module.version !== "string" || module.version.length === 0 || module.version.length > 512 ||
        !DIGEST.test(module.artifactDigest) || !Array.isArray(module.requires) ||
        !Array.isArray(module.conflicts) || !Array.isArray(module.sharedResourceGroupIds) ||
        module.requires.length > 256 || module.conflicts.length > 256 ||
        module.sharedResourceGroupIds.length > 256 || module.sharedResourceGroupIds.some((id) => !isResourceId(id)) ||
        !isRecord(module.workerLimits) ||
        Object.entries(module.workerLimits).some(([id, limit]) => !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(id) ||
          !Number.isSafeInteger(limit) || (limit as number) < 0)) {
      fail("Build catalog contains an invalid module descriptor");
    }
    const trusted = trustedById.get(module.id);
    if (!trusted) fail(`Build catalog includes unshipped module ${module.id}`);
    const manifest = trusted.manifest;
    const expectedRequires = [...manifest.dependencies].sort();
    const expectedConflicts = [...trusted.conflicts].sort();
    const expectedSharedGroups = [...trusted.sharedResourceGroupIds].sort();
    const expectedWorkerLimits = Object.fromEntries(Object.entries(trusted.workerLimits).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const expectedExclusiveResources = resourceAmounts(trusted.exclusiveResources, `${module.id} resources`);
    resourceAmounts(module.exclusiveResources, `${module.id} resources`);
    if (!DIGEST.test(trusted.artifactDigest) ||
        module.version !== manifest.version || module.artifactDigest !== trusted.artifactDigest ||
        !CONTRACT_RANGE.test(module.contractRange) || module.contractRange !== trusted.contractRange ||
        !equalJson([...module.requires].sort(), expectedRequires) ||
        !equalJson([...module.conflicts].sort(), expectedConflicts) ||
        !equalJson([...module.sharedResourceGroupIds].sort(), expectedSharedGroups) ||
        !equalJson(Object.fromEntries(Object.entries(module.workerLimits).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), expectedWorkerLimits) ||
        !equalJson(module.exclusiveResources, expectedExclusiveResources)) {
      fail(`Build catalog descriptor for ${module.id} differs from the shipped module manifest`);
    }
    catalogById.set(module.id, module);
  }

  for (const group of catalog.sharedResourceGroups) {
    if (!isRecord(group) || !hasExactKeys(group, ["id", "resources"]) ||
        !isResourceId(group.id)) {
      fail("Build catalog shared resource group is invalid");
    }
    resourceAmounts(group.resources, `shared group ${group.id}`);
  }
  if (new Set(catalog.sharedResourceGroups.map(({ id }) => id)).size !== catalog.sharedResourceGroups.length) {
    fail("Build catalog shared resource groups are duplicated");
  }
  if (catalog.resourceProfiles.some((profile) => !isRecord(profile) ||
      !hasExactKeys(profile, ["id", "cpuMilli", "memoryMiB", "ephemeralStorageMiB"]) ||
      !isResourceId(profile.id)) ||
      new Set(catalog.resourceProfiles.map(({ id }) => id)).size !== catalog.resourceProfiles.length) {
    fail("Build catalog resource profiles are duplicated");
  }
  for (const profile of catalog.resourceProfiles) {
    resourceAmounts({
      cpuMilli: profile.cpuMilli,
      memoryMiB: profile.memoryMiB,
      ephemeralStorageMiB: profile.ephemeralStorageMiB,
    }, `resource profile ${profile.id}`);
  }

  const plan = resolveModulePlan(trustedModules.map(({ manifest }) => manifest), requestedModuleIds);
  const selected = new Set(plan.enabled);
  for (const moduleId of selected) {
    const module = catalogById.get(moduleId);
    if (!module) fail(`Build catalog does not provide selected module ${moduleId}`);
    for (const conflict of module.conflicts) {
      if (selected.has(conflict as ModuleId)) {
        fail(`Selected modules ${moduleId} and ${conflict} conflict`);
      }
    }
  }

  const resources = { ...baseResources };
  const sharedGroupIds = new Set<string>();
  const resolvedModules = [...selected].sort().map((id) => {
    const module = catalogById.get(id)!;
    addResources(resources, resourceAmounts(module.exclusiveResources, `${id} resources`));
    for (const groupId of module.sharedResourceGroupIds) sharedGroupIds.add(groupId);
    return { id, version: module.version, artifactDigest: module.artifactDigest };
  });
  const sharedGroups = new Map(catalog.sharedResourceGroups.map(({ id, resources: amounts }) => [id, amounts]));
  for (const id of [...sharedGroupIds].sort()) {
    const amounts = sharedGroups.get(id);
    if (!amounts) fail(`Build catalog is missing shared resource group ${id}`);
    addResources(resources, resourceAmounts(amounts, `shared group ${id}`));
  }

  return {
    requestedModules: [...new Set(requestedModuleIds)].sort() as ModuleId[],
    resolvedModules,
    resourceRequirements: resources,
    moduleOrder: [...plan.order],
  };
}
