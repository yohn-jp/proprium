import type { ModuleContext, ModuleDefinition, ModuleManifest } from "@scriptorium/contracts";
import { createStoryActions } from "./actions.js";

export const storyManifest: ModuleManifest = {
  id: "story",
  version: "0.1.0",
  contractVersion: 1,
  dependencies: [],
  provides: [],
  requires: [],
  optionalRequires: ["nlp.tokenizer"],
  serverEntry: "./dist/index.js",
  browserEntry: "./dist/browser.js",
  statePaths: ["bible", "plot", "manuscript", "meta/scriptorium/modules/story"],
  locality: "local",
};

export function createModule(context: ModuleContext): ModuleDefinition {
  return {
    manifest: storyManifest,
    actions: createStoryActions(context),
    ui: [
      { id: "story.navigator", module: "story", slot: "dock", title: "Story navigator", action: "story.volumes.tree" },
      { id: "story.inspector", module: "story", slot: "inspection", title: "Story inspector", action: "story.entities.get" },
      { id: "story.continuity", module: "story", slot: "review", title: "Continuity", action: "story.threads.lifecycle" },
      { id: "story.world-state", module: "story", slot: "review", title: "World state", action: "story.world-state.workbench" },
      { id: "story.series", module: "story", slot: "settings", title: "Series", action: "story.series.list" },
    ],
    async dispose() {},
  };
}

export { createStoryActions } from "./actions.js";
export { readStorySnapshot } from "./snapshot.js";
export { createStoryMigrationProducer } from "./migration/index.js";
export * from "./domain/index.js";
