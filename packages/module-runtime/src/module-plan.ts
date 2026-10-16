import { CONTRACT_VERSION, type ModuleId, type ModuleManifest } from "@scriptorium/contracts";
import { ModuleRuntimeError, isModuleId, MODULE_IDS } from "./runtime-error.js";

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const capabilityId = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

export interface ResolvedModulePlan {
  manifests: ReadonlyMap<ModuleId, Readonly<ModuleManifest>>;
  /** Requested modules and their complete dependency closure. */
  enabled: ReadonlySet<ModuleId>;
  /** Dependencies precede their consumers. */
  order: readonly ModuleId[];
}

function boundedString(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    throw new ModuleRuntimeError("invalid_manifest", `Invalid ${label}`);
  }
  return value;
}

function safeEntry(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const entry = boundedString(value, label, 1024);
  if (entry.includes("\\") || entry.includes("\0") || entry.split("/").includes("..")) {
    throw new ModuleRuntimeError("invalid_manifest", `Unsafe ${label}`);
  }
  return entry;
}

function copyManifest(value: ModuleManifest): Readonly<ModuleManifest> {
  if (!value || typeof value !== "object" || !isModuleId((value as ModuleManifest).id)) {
    throw new ModuleRuntimeError("unknown_module_id", "Module manifest has an unknown ID");
  }
  const manifest = value as ModuleManifest;
  const id = manifest.id;
  if (typeof manifest.version !== "string" || !semver.test(manifest.version)) {
    throw new ModuleRuntimeError("invalid_module_version", `Module ${id} has an invalid version`);
  }
  if (manifest.contractVersion !== CONTRACT_VERSION) {
    throw new ModuleRuntimeError("contract_version_mismatch", `Module ${id} requires contract ${String(manifest.contractVersion)}; host provides ${CONTRACT_VERSION}`);
  }
  if (!Array.isArray(manifest.dependencies) || !Array.isArray(manifest.provides) || !Array.isArray(manifest.requires) ||
      (manifest.optionalRequires !== undefined && !Array.isArray(manifest.optionalRequires)) || !Array.isArray(manifest.statePaths)) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has invalid dependency, capability, or state metadata`);
  }
  const dependencies = manifest.dependencies.map((dependency) => {
    if (!isModuleId(dependency)) throw new ModuleRuntimeError("unknown_module_id", `Module ${id} declares unknown dependency ${String(dependency)}`);
    return dependency;
  });
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has duplicate or self dependencies`);
  }
  const capabilities = (values: string[], label: string): string[] => {
    if (values.length > 64 || values.some((item) => typeof item !== "string" || !capabilityId.test(item))) {
      throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has invalid ${label}`);
    }
    if (new Set(values).size !== values.length) throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has duplicate ${label}`);
    return [...values];
  };
  if (manifest.locality !== "local" && manifest.locality !== "optional-external") {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has invalid locality`);
  }
  if (manifest.statePaths.length > 64 || manifest.statePaths.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\") || path.length > 1024)) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has unsafe state paths`);
  }
  const provides = capabilities(manifest.provides, "provided capabilities");
  const requires = capabilities(manifest.requires, "required capabilities");
  const optionalRequires = capabilities(manifest.optionalRequires ?? [], "optional capabilities");
  if (optionalRequires.some((capability) => requires.includes(capability) || provides.includes(capability))) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} repeats a provided, required, or optional capability`);
  }
  return Object.freeze({
    id,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    dependencies: Object.freeze(dependencies) as unknown as ModuleId[],
    provides: Object.freeze(provides) as unknown as string[],
    requires: Object.freeze(requires) as unknown as string[],
    optionalRequires: Object.freeze(optionalRequires) as unknown as string[],
    serverEntry: safeEntry(manifest.serverEntry, `${id} server entry`),
    browserEntry: safeEntry(manifest.browserEntry, `${id} browser entry`),
    workerEntry: safeEntry(manifest.workerEntry, `${id} worker entry`),
    statePaths: Object.freeze([...manifest.statePaths]) as unknown as string[],
    locality: manifest.locality,
  });
}

/** Pure metadata resolution. This function never evaluates a module loader. */
export function resolveModulePlan(
  manifests: readonly ModuleManifest[],
  requestedIds: readonly string[],
  hostCapabilities: readonly string[] = [],
): ResolvedModulePlan {
  if (!Array.isArray(manifests) || manifests.length > MODULE_IDS.length) {
    throw new ModuleRuntimeError("invalid_manifest", "Module manifest set exceeds the supported module count");
  }
  const installed = new Map<ModuleId, Readonly<ModuleManifest>>();
  for (const raw of manifests) {
    const manifest = copyManifest(raw);
    if (installed.has(manifest.id)) throw new ModuleRuntimeError("duplicate_module_id", `Module ${manifest.id} is installed more than once`);
    installed.set(manifest.id, manifest);
  }

  const capabilityOwners = new Map<string, ModuleId>();
  for (const manifest of installed.values()) {
    for (const capability of manifest.provides) {
      const current = capabilityOwners.get(capability);
      if (current) throw new ModuleRuntimeError("duplicate_capability_provider", `Capability ${capability} is provided by both ${current} and ${manifest.id}`);
      capabilityOwners.set(capability, manifest.id);
    }
  }

  for (const manifest of installed.values()) {
    for (const dependency of manifest.dependencies) {
      if (!installed.has(dependency)) {
        throw new ModuleRuntimeError("missing_dependency", `Module ${manifest.id} requires installed module ${dependency}`);
      }
    }
  }

  const requested = new Set<ModuleId>();
  for (const id of requestedIds) {
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${String(id)}`);
    if (!installed.has(id)) throw new ModuleRuntimeError("redeployment_required", `Module ${id} is not included in this profile; redeployment is required`);
    requested.add(id);
  }

  const enabled = new Set<ModuleId>();
  const enable = (id: ModuleId): void => {
    if (enabled.has(id)) return;
    enabled.add(id);
    for (const dependency of installed.get(id)!.dependencies) enable(dependency);
  };
  for (const id of requested) enable(id);

  const ordered: ModuleId[] = [];
  const visiting = new Set<ModuleId>();
  const visited = new Set<ModuleId>();
  const visit = (id: ModuleId): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new ModuleRuntimeError("dependency_cycle", `Module or capability dependency cycle includes ${id}`);
    visiting.add(id);
    const manifest = installed.get(id)!;
    for (const dependency of manifest.dependencies) visit(dependency);
    for (const capability of manifest.requires) {
      const provider = capabilityOwners.get(capability);
      if (provider && provider !== id && enabled.has(provider)) visit(provider);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const id of installed.keys()) visit(id);

  const availableCapabilities = new Set<string>();
  for (const capability of hostCapabilities) {
    if (typeof capability !== "string" || !capabilityId.test(capability)) throw new ModuleRuntimeError("invalid_capability", "Host declares an invalid capability ID");
    availableCapabilities.add(capability);
  }
  for (const capability of hostCapabilities) {
    const moduleProvider = capabilityOwners.get(capability);
    if (moduleProvider) throw new ModuleRuntimeError("duplicate_capability_provider", `Capability ${capability} is provided by both the host and ${moduleProvider}`);
  }
  for (const id of enabled) for (const capability of installed.get(id)!.provides) availableCapabilities.add(capability);
  for (const id of enabled) {
    const missing = installed.get(id)!.requires.filter((capability) => !availableCapabilities.has(capability));
    if (missing.length) throw new ModuleRuntimeError("missing_capability", `Module ${id} requires unavailable capabilities: ${missing.join(", ")}`);
  }

  return { manifests: installed, enabled, order: ordered.filter((id) => enabled.has(id)) };
}
