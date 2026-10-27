import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterSummaryFingerprint, isFreshSummary, parseSummaryOutput } from "../src/summaries.js";

test("summary parser requires three ordered lines and bounded scene facts", () => {
  assert.deepEqual(parseSummaryOutput('{"summaryLines":["一","二","三"],"characters":["灯"],"stateChanges":[]}', "scene"), { summaryLines: ["一", "二", "三"], characters: ["灯"], stateChanges: [] });
  assert.throws(() => parseSummaryOutput('{"summaryLines":["一","二"]}', "chapter"), { code: "invalid_input" });
});
test("summary freshness binds exact source and prompt and chapter child identity/order", () => {
  const children = [{ id: "a", sourceHash: "1".repeat(64) }, { id: "b", sourceHash: "2".repeat(64) }];
  const hash = chapterSummaryFingerprint(children);
  assert.notEqual(hash, chapterSummaryFingerprint([...children].reverse()));
  assert.notEqual(hash, chapterSummaryFingerprint([{ ...children[0]!, id: "c" }, children[1]!]));
  const record = { sourceHash: hash, promptVersion: "chapter-summary@2", model: "local", summaryLines: ["1", "2", "3"] };
  assert.equal(isFreshSummary(record, hash, "chapter-summary@2"), true);
  assert.equal(isFreshSummary(record, hash, "chapter-summary@3"), false);
  assert.equal(isFreshSummary(record, "other", "chapter-summary@2"), false);
});

test("summary YAML update preserves unknown fields and comments", async () => {
  const { updateSummaryYaml } = await import("../src/summaries.js");
  const result = updateSummaryYaml("# retained\nsceneId: scene-1\nlegacyField: \"keep\" # preserve quote\nsummaryLines: [old]\n", {
    sceneId: "scene-1", summaryLines: ["一", "二", "三"], sourceHash: "a".repeat(64), promptVersion: "scene-summary@3", model: "test",
  });
  assert.match(result, /# retained/u);
  assert.ok(result.includes('legacyField: "keep" # preserve quote\n'));
  assert.match(result, /sceneId: scene-1/u);
});

test("scene summary proposal rechecks sources and emits one guarded metadata change", async () => {
  const { proposeSummary } = await import("../src/summaries.js");
  const scope = { workspace_id: "w", repository_id: 7, branch: "main", generation: "g" };
  const snapshot = { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null };
  const request = { schema_version: 1 as const, request_id: "request", plugin_id: "proprium.paired-writing", action_id: "paired.summary.propose", scope, snapshot, input: {}, deadline_ms: 30000, idempotency_key: "key-1" };
  const meta = "plot/volumes/v/chapters/c/scenes/s1.yaml", body = "manuscript/s1.md", summaryPath = "plot/volumes/v/chapters/c/scene-summaries/s1.yaml";
  const mr = "a".repeat(64), br = "b".repeat(64), text = "灯台に向かった。";
  const host = { request(operation: string, payload: Record<string, unknown>) { return (function* () { return yield { kind: "host_call", call_id: "", operation, payload }; })(); } };
  const iterator = proposeSummary({ scope: "scene", targetId: "s1", expectedFileRevisions: [{ path: meta, revision: mr }, { path: body, revision: br }, { path: summaryPath, revision: null }],
    summary: { summaryLines: ["一", "二", "三"], characters: [], stateChanges: [] }, sourceHash: br,
    citations: [{ path: body, revision: br, sceneId: "s1" }], provenance: { provider: "local", model: "fixture", promptVersion: "scene-summary@3" } }, host as any, request);
  let current = iterator.next(); let proposal: any;
  while (!current.done) {
    const call = current.value; let response: unknown;
    if (call.operation === "workspace.plugin.invoke") response = { ok: true, request_id: "r", scope, snapshot, warnings: [], value: call.payload.action_id === "knowledge.scene.references.get" ? { appears: [] } : call.payload.action_id === "proprium.narrative.scene.open"
      ? { scene: { id: "s1", metadata_path: meta, metadata_revision: mr }, manuscript_path: body, manuscript_revision: br }
      : { scene_id: "s1", metadata_revision: mr, manuscript_path: body, manuscript_revision: br } };
    else if (call.operation === "workspace.file.read" && call.payload.path === body) { const bytes = [...new TextEncoder().encode(text)]; response = { revision: br, total_bytes: bytes.length, offset: 0, bytes, next_offset: null }; }
    else if (call.operation === "workspace.file.read" && call.payload.path === summaryPath) { current = iterator.throw(Object.assign(new Error("missing"), { code: "file_not_found" })); continue; }
    else if (call.operation === "workspace.change.timestamp") response = { timestamp: "2026-01-01T00:00:00Z" };
    else if (call.operation === "workspace.change.propose") { proposal = call.payload.changeset; response = { proposal_id: "proposal-1" }; }
    else throw new Error(`Unexpected host call ${call.operation}`);
    current = iterator.next(response);
  }
  assert.equal((current.value as any).proposal_id, "proposal-1");
  assert.deepEqual(proposal.read_set, [{ path: body, revision: br }, { path: summaryPath, revision: null }, { path: meta, revision: mr }].sort((a, b) => a.path.localeCompare(b.path)));
  assert.equal(proposal.units.length, 1);
  assert.equal(proposal.units[0].operations[0].path, summaryPath);
  assert.equal(proposal.units[0].operations[0].expected_revision, null);
});

test("chapter summary proposes ordered children and parent in one guarded unit", async () => {
  const { proposeSummary } = await import("../src/summaries.js");
  const scope = { workspace_id: "w", repository_id: 7, branch: "main", generation: "g" };
  const snapshot = { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null };
  const request = { schema_version: 1 as const, request_id: "r", plugin_id: "proprium.paired-writing", action_id: "paired.summary.propose", scope, snapshot, input: {}, deadline_ms: 30000, idempotency_key: "chapter-key" };
  const chapter = "plot/volumes/v/chapters/c/chapter.yaml", root = "plot/volumes/v/chapters/c";
  const children = ["s1", "s2"].map((id, i) => ({ id, meta: `${root}/scenes/${id}.yaml`, body: `manuscript/${id}.md`, metaRevision: String(i + 1).repeat(64), bodyRevision: String(i + 3).repeat(64), summary: `${root}/scene-summaries/${id}.yaml` }));
  const chapterRevision = "a".repeat(64), parent = `${root}/chapter-summary.yaml`;
  const expected = [{ path: chapter, revision: chapterRevision }, { path: parent, revision: null }, ...children.flatMap(c => [{ path: c.meta, revision: c.metaRevision }, { path: c.body, revision: c.bodyRevision }, { path: c.summary, revision: null }])];
  const lines = { summaryLines: ["一", "二", "三"], characters: [], stateChanges: [] };
  const proposalChildren = children.map(c => ({ id: c.id, sourceHash: c.bodyRevision, summary: lines, cached: false, provenance: { provider: "local", model: "fixture", promptVersion: "scene-summary@3" } }));
  const input = { scope: "chapter", targetId: "chapter-1", expectedFileRevisions: expected, summary: { summaryLines: ["甲", "乙", "丙"] }, sourceHash: chapterSummaryFingerprint(children.map(c => ({ id: c.id, sourceHash: c.bodyRevision }))),
    citations: children.map(c => ({ path: c.body, revision: c.bodyRevision, sceneId: c.id })), provenance: { provider: "local", model: "fixture", promptVersion: "chapter-summary@2" }, children: proposalChildren };
  const host = { request(operation: string, payload: Record<string, unknown>) { return (function* () { return yield { kind: "host_call", call_id: "", operation, payload }; })(); } };
  const iter = proposeSummary(input, host as any, request); let current = iter.next(), change: any;
  while (!current.done) {
    const call = current.value; let response: any;
    if (call.operation === "workspace.plugin.invoke") {
      const id = call.payload.action_id, args = call.payload.input as any; let value: any;
      if (id === "proprium.narrative.hierarchy.tree") value = { items: args.parent_id === null ? [{ id: "volume-1", kind: "volume", metadata_path: "volume.yaml", metadata_revision: chapterRevision }] : args.parent_id === "volume-1" ? [{ id: "chapter-1", kind: "chapter", metadata_path: chapter, metadata_revision: chapterRevision }] : children.map(c => ({ id: c.id, kind: "scene", metadata_path: c.meta, metadata_revision: c.metaRevision })), next_cursor: null, tree_revision: "tree" };
      else if (id === "knowledge.scene.references.get") value = { appears: [] };
      else { const child = children.find(c => c.id === args.scene_id)!; value = id === "proprium.narrative.scene.open" ? { scene: { id: child.id, metadata_path: child.meta, metadata_revision: child.metaRevision }, manuscript_path: child.body, manuscript_revision: child.bodyRevision } : { scene_id: child.id, metadata_revision: child.metaRevision, manuscript_path: child.body, manuscript_revision: child.bodyRevision }; }
      response = { ok: true, request_id: "child", scope, snapshot, warnings: [], value };
    } else if (call.operation === "workspace.file.read") {
      const child = children.find(c => c.body === call.payload.path);
      if (!child) { current = iter.throw(Object.assign(new Error("missing"), { code: "file_not_found" })); continue; }
      const bytes = [...new TextEncoder().encode(`本文 ${child.id}`)]; response = { revision: child.bodyRevision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null };
    } else if (call.operation === "workspace.change.timestamp") response = { timestamp: "2026-01-01T00:00:00Z" };
    else if (call.operation === "workspace.change.propose") { change = call.payload.changeset; response = { proposal_id: "p1" }; }
    else throw new Error(`Unexpected Host call ${call.operation}`);
    current = iter.next(response);
  }
  assert.equal(change.units.length, 1);
  assert.deepEqual(change.units[0].operations.map((op: any) => op.path), [children[0]!.summary, children[1]!.summary, parent]);
  assert.deepEqual(change.read_set, expected.sort((a, b) => a.path.localeCompare(b.path)));
  const yaml = await import("yaml"); const stored = yaml.parse(new TextDecoder().decode(Uint8Array.from(change.units[0].operations[2].content)));
  assert.deepEqual(stored.children.map((row: any) => row.id), ["s1", "s2"]);
  const { sha256 } = await import("../src/sha256.js");
  for (let i = 0; i < 2; i++) {
    assert.equal(stored.children[i].summary_path, change.units[0].operations[i].path);
    assert.equal(stored.children[i].summary_revision, sha256(Uint8Array.from(change.units[0].operations[i].content)));
  }
  assert.deepEqual(stored.source_files, children.flatMap(c => [{ path: c.meta, revision: c.metaRevision }, { path: c.body, revision: c.bodyRevision }]));
});

test("summary update retains unrelated CRLF bytes around block sequences", async () => {
  const { updateSummaryYaml } = await import("../src/summaries.js");
  const source = "# 文頭\r\nsceneId: s1\r\nsummaryLines:\r\n  - 旧一\r\n  - 旧二\r\n  - 旧三\r\ncustom:  'keep'   # 手書き\r\n";
  const result = updateSummaryYaml(source, { summaryLines: ["一", "二", "三"] });
  assert.ok(result.startsWith("# 文頭\r\nsceneId: s1\r\n"));
  assert.ok(result.endsWith("custom:  'keep'   # 手書き\r\n"));
  assert.equal(/(?<!\r)\n/u.test(result), false);
});

test("scene summary preview uses pinned known characters without invoking a provider", async () => {
  const { previewSummary } = await import("../src/summaries.js");
  const scope = { workspace_id: "w", repository_id: 7, branch: "main", generation: "g" };
  const snapshot = { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null };
  const request = { schema_version: 1 as const, request_id: "r", plugin_id: "proprium.paired-writing", action_id: "paired.summary.preview", scope, snapshot, input: {}, deadline_ms: 30000 };
  const meta = "plot/volumes/v/chapters/c/scenes/s1.yaml", body = "manuscript/s1.md", mr = "a".repeat(64), br = "b".repeat(64), cr = "c".repeat(64);
  const host = { request(operation: string, payload: Record<string, unknown>) { return (function* () { return yield { kind: "host_call", call_id: "", operation, payload }; })(); } };
  const iter = previewSummary({ scope: "scene", targetId: "s1", expectedSnapshot: "s" }, host as any, request); let current = iter.next();
  while (!current.done) {
    const call = current.value; let response: any;
    if (call.operation === "workspace.plugin.invoke") {
      const action = call.payload.action_id;
      const value = action === "knowledge.scene.references.get" ? { appears: [{ id: "c1", type: "character", status: "resolved", name: "灯", path: "bible/c.yaml", revision: cr }] }
        : action === "proprium.narrative.scene.open" ? { scene: { id: "s1", metadata_path: meta, metadata_revision: mr }, manuscript_path: body, manuscript_revision: br }
          : { scene_id: "s1", metadata_revision: mr, manuscript_path: body, manuscript_revision: br };
      response = { ok: true, scope, snapshot, request_id: "child", warnings: [], value };
    } else if (call.operation === "workspace.file.read" && call.payload.path === body) {
      const bytes = [...new TextEncoder().encode("本文")]; response = { revision: br, total_bytes: bytes.length, offset: 0, bytes, next_offset: null };
    } else if (call.operation === "workspace.file.read") { current = iter.throw(Object.assign(new Error("missing"), { code: "file_not_found" })); continue; }
    else throw new Error(`Unexpected provider or write call: ${call.operation}`);
    current = iter.next(response);
  }
  const result = current.value as any;
  assert.equal(result.provider_invoked, false);
  assert.match(result.children[0].prompt, /既知の登場人物: 灯/u);
  assert.ok(result.expectedFileRevisions.some((row: any) => row.path === "bible/c.yaml" && row.revision === cr));
});

test("scene suggestion returns typed provider failure and never proposes on unavailable provider", async () => {
  const { suggestSummary } = await import("../src/summaries.js");
  const scope = { workspace_id: "w", repository_id: 7, branch: "main", generation: "g" };
  const snapshot = { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null };
  const request = { schema_version: 1 as const, request_id: "r", plugin_id: "proprium.paired-writing", action_id: "paired.summary.suggest", scope, snapshot, input: {}, deadline_ms: 30000 };
  const meta = "plot/volumes/v/chapters/c/scenes/s1.yaml", body = "manuscript/s1.md", mr = "a".repeat(64), br = "b".repeat(64);
  const host = { request(operation: string, payload: Record<string, unknown>) { return (function* () { return yield { kind: "host_call", call_id: "", operation, payload }; })(); } };
  const unavailable = function* () { throw Object.assign(new Error("No model"), { code: "provider_unavailable" }); };
  const iter = suggestSummary({ scope: "scene", targetId: "s1", expectedSnapshot: "s" }, host as any, request, unavailable as any); let current = iter.next();
  while (!current.done) {
    const call = current.value; let response: any;
    if (call.operation === "workspace.plugin.invoke") {
      const action = call.payload.action_id;
      const value = action === "knowledge.scene.references.get" ? { appears: [] } : action === "proprium.narrative.scene.open" ? { scene: { id: "s1", metadata_path: meta, metadata_revision: mr }, manuscript_path: body, manuscript_revision: br } : { scene_id: "s1", metadata_revision: mr, manuscript_path: body, manuscript_revision: br };
      response = { ok: true, scope, snapshot, request_id: "child", warnings: [], value };
    } else if (call.operation === "workspace.file.read" && call.payload.path === body) {
      const bytes = [...new TextEncoder().encode("本文")]; response = { revision: br, total_bytes: bytes.length, offset: 0, bytes, next_offset: null };
    } else if (call.operation === "workspace.file.read") { current = iter.throw(Object.assign(new Error("missing"), { code: "file_not_found" })); continue; }
    else throw new Error(`Unexpected write or Host operation: ${call.operation}`);
    try { current = iter.next(response); } catch (error) { assert.equal((error as any).code, "provider_unavailable"); return; }
  }
  assert.fail("Expected provider_unavailable");
});

test("summary generation accepts fenced JSON from a provider", () => {
  assert.deepEqual(parseSummaryOutput('```json\n{"summaryLines":["一","二","三"]}\n```', "chapter"), { summaryLines: ["一", "二", "三"] });
});
