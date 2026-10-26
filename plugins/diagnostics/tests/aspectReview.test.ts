import assert from "node:assert/strict";
import test from "node:test";
import { runDeterministicAspectReview, type AspectReviewScene } from "../src/aspectReview.js";

const revision = "a".repeat(64);
function scene(sceneId: string, body: string, overrides: Partial<AspectReviewScene> = {}): AspectReviewScene {
  return {
    sceneId, sceneTitle: sceneId, body,
    manuscriptPath: `manuscript/${sceneId}.md`, manuscriptRevision: revision,
    metadataPath: `plot/${sceneId}.yaml`, metadataRevision: revision,
    ...overrides,
  };
}

test("aspect review preserves pinned tempo thresholds and maps shortened quotes to exact UTF-16 evidence", () => {
  const long = `😀${"地".repeat(700)}`;
  const report = runDeterministicAspectReview("ch-1", "章", [scene("sc-long", long), scene("sc-short", "短文")], ["tempo"]);
  const finding = report.findings.find((item) => item.sceneId === "sc-long");
  assert.ok(finding?.quote);
  assert.equal(finding.evidence?.length, 1);
  assert.equal(finding.evidence?.[0].path, "manuscript/sc-long.md");
  assert.equal(long.slice(finding!.evidence![0].start, finding!.evidence![0].end), finding!.evidence![0].quote);
  assert.ok(finding!.evidence![0].end > finding!.evidence![0].start);
});

test("POV shifts cite declared metadata and mixed-person prose spans independently", () => {
  const body = "私の手は震えた。彼は窓の外を見つめていた。";
  const report = runDeterministicAspectReview("ch-1", "章", [
    scene("sc-1", body, { povId: "char-a", povName: "葵" }),
    scene("sc-2", "彼女は帰った。", { povId: "char-b", povName: "蓮" }),
  ], ["pov-shift"]);
  const declared = report.findings.find((item) => !item.sceneId);
  assert.equal(declared?.evidence?.length, 2);
  assert.ok(declared?.evidence?.every((item) => item.start === 0 && item.end === 0 && item.path.startsWith("plot/")));
  const mixed = report.findings.find((item) => item.sceneId === "sc-1");
  assert.ok(mixed?.quote);
  assert.equal(mixed?.evidence?.[0].quote, body.slice(mixed!.evidence![0].start, mixed!.evidence![0].end));
});

test("aspect input is scoped per selected category and reports no strong signal as an observation", () => {
  const report = runDeterministicAspectReview("ch-1", "章", [scene("sc-1", "穏やかな短文。")], ["over-explain"]);
  assert.deepEqual(report.aspects, ["over-explain"]);
  assert.match(report.findings[0].finding, /強い兆候は検出されなかった/u);
  assert.equal(report.findings[0].evidence, undefined);
});
