import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpWritingContext,
  MCP_WRITING_CONTEXT_MAX_CHARACTERS,
  McpWritingContextInputError,
} from "./context-manifest.js";

test("writing context preserves source identity, bounds, and selection provenance", () => {
  const manuscriptText = "本文".repeat(MCP_WRITING_CONTEXT_MAX_CHARACTERS);
  const context = createMcpWritingContext({
    projectId: "project-one",
    sceneId: "scene-one",
    sceneRevision: "scene-rev-1",
    sceneTitle: "一場面",
    manuscriptId: "manuscript-one",
    manuscriptRevision: "manuscript-rev-1",
    manuscriptText,
    selection: { from: 1, to: 3, text: "本文" },
    capturedAt: 123,
  });

  assert.equal(context.captured_at, 123);
  assert.equal(context.saved_manuscript.text.length, MCP_WRITING_CONTEXT_MAX_CHARACTERS);
  assert.equal(context.saved_manuscript.revision, "manuscript-rev-1");
  assert.equal(context.selection.status, "client_provided");
  assert.equal(context.selection.content_hash, "d0ab52a4");
  assert.equal(context.manifest.parts[1]?.source, "arcadia");
  assert.equal(context.manifest.parts[1]?.revision, "manuscript-rev-1");
  assert.equal(
    context.manifest.parts[1]?.size.source_character_count,
    MCP_WRITING_CONTEXT_MAX_CHARACTERS * 2,
  );
  assert.equal(
    context.manifest.parts[1]?.size.included_character_count,
    MCP_WRITING_CONTEXT_MAX_CHARACTERS,
  );
  assert.match(context.manifest.parts[1]?.inclusion_reason ?? "", /saved scene manuscript/);
  assert.equal(context.manifest.parts[2]?.source, "mcp_client");
  assert.equal(context.manifest.parts[1]?.trimmed, true);
  assert.deepEqual(context.draft, { status: "not_shared" });
  assert.equal(context.manifest.scope, "arcadia_provided_context");
  assert.equal(context.manifest.external_host_final_prompt_observed, false);

  const manifestOnly = createMcpWritingContext({
    projectId: "project-one",
    sceneId: "scene-one",
    sceneRevision: "scene-rev-1",
    sceneTitle: "一場面",
    manuscriptId: "manuscript-one",
    manuscriptRevision: "manuscript-rev-1",
    manuscriptText,
    selection: { from: 1, to: 3, text: "本文" },
    manifestOnly: true,
    capturedAt: 123,
  });
  assert.equal(manifestOnly.manifest.parts[0]?.dropped, true);
  assert.equal(manifestOnly.manifest.parts[0]?.size.included_character_count, 0);
  assert.equal(manifestOnly.manifest.parts[0]?.metadata_included, true);
  assert.equal(manifestOnly.manifest.parts[1]?.dropped, true);
  assert.equal(manifestOnly.manifest.parts[1]?.size.included_character_count, 0);
  assert.equal(manifestOnly.manifest.parts[2]?.dropped, true);
  assert.equal(manifestOnly.manifest.parts[2]?.size.included_character_count, 0);
});

test("writing context truncates Unicode by character and validates selection identity", () => {
  const context = createMcpWritingContext({
    projectId: "project-one",
    sceneId: "scene-one",
    sceneTitle: "😀".repeat(513),
    manuscriptId: "manuscript-one",
    manuscriptRevision: "manuscript-rev-1",
    manuscriptText: "😀x",
    selection: { from: 0, to: 2, text: "😀" },
  });
  assert.equal(context.scene.title?.length, 1024);
  assert.equal(context.manifest.parts[0]?.size.source_character_count, 513);
  assert.equal(context.manifest.parts[0]?.size.included_character_count, 512);
  assert.equal(context.manifest.parts[0]?.trimmed, true);
  assert.equal(context.saved_manuscript.text, "😀x");
  assert.equal(context.selection.content_hash, "cb31c4b8");

  assert.throws(
    () => createMcpWritingContext({
      projectId: "project-one",
      sceneId: "scene-one",
      manuscriptId: "manuscript-one",
      manuscriptRevision: "manuscript-rev-1",
      manuscriptText: "saved",
      selection: { from: 2, to: 1, text: "invalid" },
    }),
    McpWritingContextInputError,
  );
  assert.throws(
    () => createMcpWritingContext({
      projectId: "project-one",
      sceneId: "scene-one",
      manuscriptId: "manuscript-one",
      manuscriptRevision: "manuscript-rev-1",
      manuscriptText: "saved",
      selection: { from: 0, to: 5_001, text: "x".repeat(5_001) },
    }),
    McpWritingContextInputError,
  );
});
