import assert from "node:assert/strict";
import test from "node:test";
import { checkProjectContinuity } from "../src/projectContinuity.js";
import type { ProjectEntity, ProjectLink } from "../src/projectConsistency.js";

const revision = "c".repeat(64);
function entity(id: string, type: string, raw: Record<string, unknown>, filePath = `plot/${id}.yaml`): ProjectEntity {
  return { id, type, raw, filePath, revision };
}

test("continuity uses only declared ordered facts and returns source scene identities", () => {
  const entities = [
    entity("vol-1", "volume", { order: 1 }),
    entity("ch-1", "chapter", { volume: "vol-1", order: 1 }),
    entity("loc-a", "location", { travel: { adjacent: ["loc-b"], daysTo: { "loc-b": 5 } } }, "bible/locations/a.yaml"),
    entity("loc-b", "location", { travel: { adjacent: ["loc-a"] } }, "bible/locations/b.yaml"),
    entity("loc-c", "location", {}, "bible/locations/c.yaml"),
    entity("char-a", "character", {}, "bible/characters/a.yaml"),
    entity("char-b", "character", {}, "bible/characters/b.yaml"),
    entity("item-1", "item", {}, "bible/items/one.yaml"),
    entity("sc-1", "scene", { chapter: "ch-1", order: 1, location: "loc-a", manuscript: "manuscript/one.md", effects: [{ action: "acquire_item", characterId: "char-a", itemId: "item-1" }] }, "plot/scenes/one.yaml"),
    entity("sc-2", "scene", { chapter: "ch-1", order: 2, location: "loc-b", manuscript: "manuscript/two.md", effects: [{ action: "use_item", characterId: "char-b", itemId: "item-1" }] }, "plot/scenes/two.yaml"),
    entity("sc-3", "scene", { chapter: "ch-1", order: 3, location: "loc-c", manuscript: "manuscript/three.md" }, "plot/scenes/three.yaml"),
  ];
  const links: ProjectLink[] = [
    { from: "sc-1", to: "char-a", kind: "appears" },
    { from: "sc-2", to: "char-a", kind: "appears" }, { from: "sc-2", to: "char-b", kind: "appears" },
    { from: "sc-3", to: "char-a", kind: "appears" },
  ];
  const report = checkProjectContinuity(entities, links, new Map([
    ["manuscript/one.md", "この場面"], ["manuscript/two.md", "四日後の朝"], ["manuscript/three.md", "昨日の夜"],
  ]));
  const reasons = report.findings.map((finding) => finding.reason);
  assert.ok(reasons.includes("travel-impossible"));
  assert.ok(reasons.includes("item-owner-mismatch"));
  assert.ok(reasons.includes("unrecorded-teleport"));
  assert.ok(reasons.includes("non-adjacent-location"));
  assert.ok(reasons.includes("timeline-reversal"));
  assert.ok(report.findings.every((finding) => finding.evidence.some((item) => item.path === "plot/scenes/one.yaml" || item.path === "plot/scenes/two.yaml")));
});

test("unknown location, travel duration, and time remain unknown rather than becoming warnings", () => {
  const entities = [entity("vol-1", "volume", { order: 1 }), entity("ch-1", "chapter", { volume: "vol-1", order: 1 }),
    entity("char-a", "character", {}, "bible/characters/a.yaml"),
    entity("sc-1", "scene", { chapter: "ch-1", order: 1, manuscript: "one.md" }),
    entity("sc-2", "scene", { chapter: "ch-1", order: 2, manuscript: "two.md" })];
  const links = [{ from: "sc-1", to: "char-a", kind: "appears" }, { from: "sc-2", to: "char-a", kind: "appears" }];
  assert.deepEqual(checkProjectContinuity(entities, links, new Map([['one.md', '本文'], ['two.md', '続く']])).findings, []);
});
