import type { ModuleStatus, UiContribution } from "@scriptorium/contracts";

const callableAvailability = new Set<ModuleStatus["availability"]>(["enabled-idle", "active"]);

/** Contributions advertised by the selected profile and an enabled module for one host slot. */
export function discoverableContributions(
  contributions: UiContribution[],
  modules: ModuleStatus[],
  slot: UiContribution["slot"],
): UiContribution[] {
  const availableModules = new Set(
    modules.filter((module) => callableAvailability.has(module.availability)).map((module) => module.id),
  );
  return contributions.filter((item) => item.slot === slot && availableModules.has(item.module));
}
