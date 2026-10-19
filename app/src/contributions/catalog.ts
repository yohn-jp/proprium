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

/** Layout position is host-owned; slot remains only the legacy placement hint. */
export function workspaceContributions(contributions: UiContribution[], modules: ModuleStatus[]): UiContribution[] {
  const available = new Set(modules.filter((item) => callableAvailability.has(item.availability)).map((item) => item.id));
  const seen = new Set<string>();
  return contributions.filter((item) => {
    if (!available.has(item.module) || (item.kind ?? "panel") !== "panel" ||
        (item.contexts && !item.contexts.includes("workspace")) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
