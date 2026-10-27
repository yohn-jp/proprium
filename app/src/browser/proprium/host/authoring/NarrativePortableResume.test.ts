import assert from "node:assert/strict";
import test from "node:test";
import { validatePortableResume } from "./NarrativePortableResume.js";

const marker = { device_id: "device", scene_id: "scene", title: "Scene", manuscript_path: "manuscript/a.md", manuscript_revision: "body", sentence_index: 2, scroll_top: 10, updated_at: "2026-01-01T00:00:00Z", availability: "ready" as const, publication: "remote_confirmed" as const };
const context = { scene_id: "scene", manuscript_path: "manuscript/a.md", manuscript_revision: "body", metadata_revision: "metadata" };
const signal = () => new AbortController().signal;

test("portable position uses current metadata and is validated with null draft", async () => {
  const calls: string[] = [];
  const position = await validatePortableResume(async (action, input) => {
    calls.push(action);
    if (action.endsWith("scene.context")) return context;
    return { status: "ready", candidate: input.resume_position };
  }, marker, signal());
  assert.deepEqual(calls, ["proprium.narrative.scene.context", "proprium.narrative.scene.continue"]);
  assert.deepEqual(position, { scene_id: "scene", manuscript_path: "manuscript/a.md", manuscript_revision: "body", metadata_revision: "metadata", draft_generation: null, sentence_index: 2, scroll_top: 10 });
});

test("stale markers and changed paths cannot become navigation positions", async () => {
  await assert.rejects(validatePortableResume(async () => { throw new Error("unexpected read"); }, { ...marker, availability: "stale" }, signal()), /対応/);
  await assert.rejects(validatePortableResume(async () => ({ ...context, manuscript_path: "manuscript/other.md" }), marker, signal()), /変更/);
  await assert.rejects(validatePortableResume(async action => action.endsWith("scene.context") ? context : { status: "stale_position", candidate: null }, marker, signal()), /利用できません/);
});

test("cancellation between context and continuation prevents continuation", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(validatePortableResume(async () => { calls++; controller.abort(); return context; }, marker, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});
