import assert from "node:assert/strict";
import test from "node:test";
import type { ModuleStatus, UiContribution } from "@scriptorium/contracts";
import { discoverableContributions } from "./contributions/catalog";

const contributions: UiContribution[] = [
  { id: "story.navigator", module: "story", slot: "dock", title: "Story navigator", action: "story.volumes.tree" },
  { id: "story.continuity", module: "story", slot: "review", title: "Continuity", action: "story.threads.lifecycle" },
  { id: "assistant.rewrite", module: "assistant", slot: "dock", title: "Rewrite", action: "assistant.rewrite" },
];

function moduleStatus(id: ModuleStatus["id"], availability: ModuleStatus["availability"]): ModuleStatus {
  return { id, availability, activeJobs: 0 };
}

test("catalog exposes only the selected slot and callable modules, in server order", () => {
  const modules = [
    moduleStatus("story", "enabled-idle"),
    moduleStatus("assistant", "active"),
    moduleStatus("nlp", "disabled"),
  ];

  assert.deepEqual(discoverableContributions(contributions, modules, "dock"), [contributions[0], contributions[2]]);
  assert.deepEqual(discoverableContributions(contributions, modules, "review"), [contributions[1]]);
});

test("catalog hides disabled and profile-excluded modules", () => {
  const modules = [moduleStatus("story", "disabled"), moduleStatus("assistant", "not-included")];

  assert.deepEqual(discoverableContributions(contributions, modules, "dock"), []);
  assert.deepEqual(discoverableContributions(contributions, [], "review"), []);
});
