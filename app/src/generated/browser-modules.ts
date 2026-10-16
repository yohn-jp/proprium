import type { BrowserModuleDefinition, ModuleId } from "@scriptorium/contracts";

/** Replaced by the selected production profile when optional browser modules are included. */
export type ModuleBrowserLoaders = Partial<Record<ModuleId, () => Promise<BrowserModuleDefinition>>>;
export const moduleBrowserLoaders: ModuleBrowserLoaders = {};
