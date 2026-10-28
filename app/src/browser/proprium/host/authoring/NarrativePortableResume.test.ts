import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { NarrativePortableResume, proposePortableResumePosition, validatePortableResume } from "./NarrativePortableResume.js";

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

test("portable marker proposal reads the current source revision and binds the Host captured position", async () => {
  const controller = new AbortController();
  const captured = { scene_id: "scene", expected_manuscript_revision: "b".repeat(64), sentence_index: 2, scroll_top: 10 };
  const calls: Array<{ action: string; input?: Record<string, unknown> }> = [];
  const phases: string[] = [];
  await proposePortableResumePosition(async (action, input) => {
    calls.push({ action, input });
    return { items: [], next_cursor: null, source_revision: null };
  }, () => captured, async (event, input) => {
    phases.push("propose");
    calls.push({ action: "propose", input });
    assert.equal(event.type, "click");
  }, new Event("click"), controller.signal, () => phases.push("ready"));
  assert.equal(calls[0]?.action, "proprium.narrative.resume.marks.list");
  assert.deepEqual(calls[0]?.input, { limit: 1 });
  assert.equal(calls[1]?.action, "propose");
  assert.deepEqual(calls[1]?.input, { ...captured, expected_marker_revision: null });
  assert.deepEqual(phases, ["ready", "propose"]);
});

test("portable marker proposal rejects invalid positions and malformed marker revisions before propose", async () => {
  let proposed = false;
  const capture = { scene_id: "scene", expected_manuscript_revision: "b".repeat(64), sentence_index: null, scroll_top: 10 };
  await assert.rejects(proposePortableResumePosition(async () => ({ source_revision: "not-a-revision" }), () => capture,
    async () => { proposed = true; }, new Event("click"), new AbortController().signal), /リビジョン/u);
  await assert.rejects(proposePortableResumePosition(async () => { throw new Error("unexpected read"); }, () => ({ ...capture, scroll_top: -1 }),
    async () => { proposed = true; }, new Event("click"), new AbortController().signal), /位置/u);
  assert.equal(proposed, false);
});

test("portable marker proposal is a visible user action and cannot run after cancellation", async () => {
  const html = renderToStaticMarkup(createElement(NarrativePortableResume, { scopeKey: "scope", read: async () => ({ items: [], next_cursor: null, source_revision: null }),
    capture: () => ({ scene_id: "scene", expected_manuscript_revision: "b".repeat(64), sentence_index: null, scroll_top: 0 }),
    propose: async () => undefined, open: async () => undefined }));
  assert.match(html, /現在の位置を共有用に提案/u);
  const controller = new AbortController();
  let proposed = false;
  await assert.rejects(proposePortableResumePosition(async () => {
    controller.abort();
    return { items: [], next_cursor: null, source_revision: null };
  }, () => ({ scene_id: "scene", expected_manuscript_revision: "b".repeat(64), sentence_index: null, scroll_top: 0 }),
    async () => { proposed = true; }, new Event("click"), controller.signal), { name: "AbortError" });
  assert.equal(proposed, false);
});
