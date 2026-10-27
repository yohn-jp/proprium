import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guest } from "../guest.js";
import type { ActionRequest, ChangeSet, FileEntry, ReadChunk, Snapshot } from "./contracts.js";
import { invokeNarrative, narrativeIdForTitle, NARRATIVE_ACTIONS } from "./actions.js";
import { narrativeEntityRevision } from "./change-compiler.js";
import { sha256Hex } from "./hash.js";
import { appendYamlSequenceValue, parseYamlRecord, removeYamlSequenceIndex, updateYamlFields } from "./yaml-source.js";

const scope = { workspace_id: "workspace-a", repository_id: 42, branch: "main", generation: "generation-a" };
const snapshot: Snapshot = { id: "snapshot-a", local_commit: null, worktree_generation: "tree-a", draft_generation: null };
const encoder = new TextEncoder();
type AdoptedAuthoringSchema = {
  assertDescriptor(value: unknown): void;
  assertSurface(value: unknown): void;
  assertValue(schema: boolean | { readonly [key: string]: unknown }, value: unknown, phase?: string): void;
};
const adoptedSchemaPath = process.env.PROPRIUM_AUTHORING_SCHEMA ??
  fileURLToPath(new URL("../../../app/src/browser/proprium/authoring/schema.ts", import.meta.url));
const adoptedSchema = existsSync(adoptedSchemaPath)
  ? await import(pathToFileURL(adoptedSchemaPath).href) as AdoptedAuthoringSchema
  : undefined;
const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")) as {
  id: string;
  capabilities: string[];
  actions: Array<{
    plugin_id: string;
    action_id: string;
    schema_version: number;
    effect: string;
    required_capabilities: string[];
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
  }>;
  ui: unknown[];
};

function assertDeclaredOutput(actionId: string, value: unknown): void {
  const action = manifest.actions.find((item) => item.action_id === actionId);
  assert.ok(action, `manifest declares ${actionId}`);
  adoptedSchema?.assertValue(action.output_schema, value, `${actionId} output`);
}

function assertDeclaredInput(actionId: string, value: unknown): void {
  const action = manifest.actions.find((item) => item.action_id === actionId);
  assert.ok(action, `manifest declares ${actionId}`);
  adoptedSchema?.assertValue(action.input_schema, value, `${actionId} input`);
}

test("manifest action inventory and closed output schemas match the guest contract", () => {
  assert.equal(manifest.id, "proprium.narrative");
  assert.deepEqual(manifest.actions.map(({ action_id }) => action_id), [...NARRATIVE_ACTIONS]);
  for (const action of manifest.actions) {
    assert.equal(action.plugin_id, manifest.id);
    assert.equal(action.schema_version, 1);
    assert.ok(action.required_capabilities.every((capability) => manifest.capabilities.includes(capability)));
    const checkClosedObjects = (schema: unknown, path: string): void => {
      if (Array.isArray(schema)) {
        schema.forEach((item, index) => checkClosedObjects(item, `${path}[${index}]`));
      } else if (schema && typeof schema === "object") {
        const row = schema as Record<string, unknown>;
        if (row.type === "object") assert.ok(Object.hasOwn(row, "additionalProperties"), `${path} declares object closure`);
        for (const [key, value] of Object.entries(row)) checkClosedObjects(value, `${path}.${key}`);
      }
    };
    assert.equal(action.input_schema.type, "object");
    assert.equal(action.input_schema.additionalProperties, false);
    checkClosedObjects(action.input_schema, `${action.action_id}.input`);
    checkClosedObjects(action.output_schema, `${action.action_id}.output`);
  }
  const byId = new Map(manifest.actions.map((action) => [action.action_id, action]));
  const open = byId.get("proprium.narrative.scene.open")!.output_schema.properties as Record<string, any>;
  assert.deepEqual(Object.keys((open.navigation.properties as Record<string, any>).expected_context.properties), ["scope", "snapshot", "draft_generation"]);
  const proposal = byId.get("proprium.narrative.structure.create")!.output_schema.properties as Record<string, any>;
  const preview = proposal.preview.properties as Record<string, any>;
  assert.deepEqual(Object.keys(preview), ["title", "read_paths", "units"]);
  assert.deepEqual(Object.keys((preview.units.items as Record<string, any>).properties), ["id", "label", "depends_on", "operation_paths"]);
  const marks = byId.get("proprium.narrative.reading-marks.list")!.output_schema.properties as Record<string, any>;
  assert.deepEqual(Object.keys((marks.marks.items as Record<string, any>).properties), ["id", "offset", "length", "snippet", "comment", "createdAt", "position_status"]);
});

test("adopted Host validator accepts every Narrative descriptor and canonical surface", { skip: !adoptedSchema }, () => {
  for (const action of manifest.actions) adoptedSchema!.assertDescriptor(action);
  for (const surface of manifest.ui) adoptedSchema!.assertSurface(surface);
});

test("real values from all 14 Narrative actions match their declared output schemas", { skip: !adoptedSchema }, () => {
  const host = new MemoryHost();
  addWork(host, 2);
  const detectId = "proprium.narrative.work.detect";
  const detected = run(host, request(detectId, {}));
  assertDeclaredOutput(detectId, detected);
  const treeId = "proprium.narrative.hierarchy.tree";
  const tree = run(host, request(treeId, { limit: 128 })) as { tree_revision: string };
  assertDeclaredOutput(treeId, tree);
  const openId = "proprium.narrative.scene.open";
  const openRequest = request(openId, { scene_id: "scene-1" });
  openRequest.snapshot.remote_commit = "a".repeat(40);
  assertDeclaredOutput(openId, run(host, openRequest));
  const contextId = "proprium.narrative.scene.context";
  assertDeclaredOutput(contextId, run(host, request(contextId, { scene_id: "scene-1" })));
  const continueId = "proprium.narrative.scene.continue";
  const metadataPath = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-1.yaml";
  const metadataRevision = host.files.get(metadataPath)!.revision;
  const manuscriptRevision = host.files.get("manuscript/custom/scene-1.md")!.revision;
  assertDeclaredOutput(continueId, run(host, request(continueId, { resume_position: {
    scene_id: "scene-1", manuscript_path: "manuscript/custom/scene-1.md", metadata_revision: metadataRevision,
    manuscript_revision: manuscriptRevision, draft_generation: null, sentence_index: 1, scroll_top: 0,
  } })));
  const createId = "proprium.narrative.structure.create";
  assertDeclaredOutput(createId, run(host, request(createId, {
    kind: "volume", title: "Another volume", id: "another-volume", expected_tree_revision: tree.tree_revision,
  }, "schema-create")));
  const updateId = "proprium.narrative.structure.update";
  assertDeclaredOutput(updateId, run(host, request(updateId, {
    kind: "scene", id: "scene-1", patch: { title: "Renamed scene" }, expected_metadata_revision: metadataRevision,
  }, "schema-update")));
  const reorderId = "proprium.narrative.structure.reorder";
  assertDeclaredOutput(reorderId, run(host, request(reorderId, {
    kind: "scene", parent_id: "work-chapter", ordered_ids: ["scene-2", "scene-1"], expected_tree_revision: tree.tree_revision,
  }, "schema-reorder")));
  const listMarksId = "proprium.narrative.reading-marks.list";
  assertDeclaredOutput(listMarksId, run(host, request(listMarksId, { scene_id: "scene-1" })));
  const createMarkId = "proprium.narrative.reading-marks.create";
  assertDeclaredOutput(createMarkId, run(host, request(createMarkId, {
    scene_id: "scene-1", mark: { id: "mark-new", offset: 0, length: 4, snippet: "Body", createdAt: "2026-10-26T02:00:00Z" },
    expected_metadata_revision: metadataRevision, expected_manuscript_revision: manuscriptRevision,
  }, "schema-mark-create")));
  host.add(metadataPath, [
    "id: scene-1", "type: scene", "title: Scene 1", "volume: work-volume", "chapter: work-chapter", "order: 1",
    "manuscript: manuscript/custom/scene-1.md", "readingMarks:", "  - id: mark-existing", "    offset: 0", "    length: 4",
    "    snippet: Body", "    createdAt: '2026-10-26T01:00:00Z'", "",
  ].join("\n"));
  const currentMetadataRevision = host.files.get(metadataPath)!.revision;
  const deleteMarkId = "proprium.narrative.reading-marks.delete";
  assertDeclaredOutput(deleteMarkId, run(host, request(deleteMarkId, {
    scene_id: "scene-1", mark_id: "mark-existing", expected_metadata_revision: currentMetadataRevision,
    expected_manuscript_revision: manuscriptRevision,
  }, "schema-mark-delete")));
  const compileId = "proprium.narrative.changes.compile";
  const raw = sourceRaw(host, metadataPath);
  const compilerInput = {
    operations: [sourceOperation("schema-title", "scene.update", { kind: "revision", value: narrativeEntityRevision(raw) },
      { sceneId: "scene-1" }, { changes: { title: "Compiler title" } })],
    evidence: [],
  };
  assertDeclaredInput(compileId, compilerInput);
  assertDeclaredOutput(compileId, run(host, request(compileId, compilerInput)));
  const resumeListId = "proprium.narrative.resume.marks.list";
  assertDeclaredOutput(resumeListId, run(host, request(resumeListId, {})));
  const resumeProposeId = "proprium.narrative.resume.mark.propose";
  assertDeclaredOutput(resumeProposeId, run(host, request(resumeProposeId, {
    scene_id: "scene-1", expected_manuscript_revision: manuscriptRevision, expected_marker_revision: null,
    sentence_index: 1, scroll_top: 0,
  }, "schema-resume")));
});

test("compiler schema preserves the pinned bounded dynamic JSON shape and rejects unsafe keys/depth", { skip: !adoptedSchema }, () => {
  const action = manifest.actions.find((item) => item.action_id === "proprium.narrative.changes.compile")!;
  const nested = (levels: number): unknown => {
    let value: unknown = "leaf";
    for (let index = 0; index < levels; index++) value = { nested: value };
    return value;
  };
  const createInput = (values: Record<string, unknown>) => ({
    operations: [sourceOperation("opaque-create", "entity.create", { kind: "absent" },
      { entityId: "foreign-id", entityType: "character" }, { values })], evidence: [],
  });
  adoptedSchema!.assertValue(action.input_schema, createInput({ arbitraryOwnerField: { values: ["kept", 1, true, null] }, nested: nested(15) }));
  assert.throws(() => adoptedSchema!.assertValue(action.input_schema, createInput({ nested: nested(16) })));
  assert.throws(() => adoptedSchema!.assertValue(action.input_schema, createInput(JSON.parse('{"__proto__":"blocked"}'))));
  assert.throws(() => adoptedSchema!.assertValue(action.input_schema, createInput({ ["x".repeat(257)]: "blocked" })));
});

class MemoryHost {
  readonly files = new Map<string, { bytes: Uint8Array; revision: string }>();
  readonly snapshots = new Map<string, Map<string, { bytes: Uint8Array; revision: string }>>();
  readonly reads: string[] = [];
  changeset?: ChangeSet;
  calls = new Map<string, number>();
  identity: Record<string, unknown> = { device_id: "device-local", legacy_project_ids: [], publication: { remote_commit: null, files: [] } };
  timestamp = "2026-10-26T02:00:00Z";

  add(path: string, text: string): string {
    const bytes = encoder.encode(text);
    const revision = sha256Hex(text);
    this.files.set(path, { bytes, revision });
    return revision;
  }

  addSnapshot(id: string, path: string, text: string): string {
    const files = new Map([...this.files].map(([name, file]) => [name, { bytes: file.bytes.slice(), revision: file.revision }]));
    const bytes = encoder.encode(text);
    const revision = sha256Hex(text);
    files.set(path, { bytes, revision });
    this.snapshots.set(id, files);
    return revision;
  }

  filesFor(payload: Record<string, unknown>): Map<string, { bytes: Uint8Array; revision: string }> {
    const id = (payload.snapshot as { id?: string } | undefined)?.id;
    return id ? this.snapshots.get(id) ?? this.files : this.files;
  }

  respond(operation: string, payload: Record<string, unknown>): unknown {
    this.calls.set(operation, (this.calls.get(operation) ?? 0) + 1);
    if (operation === "workspace.file.list") {
      const prefix = String(payload.prefix);
      const files: FileEntry[] = [...this.filesFor(payload)]
        .filter(([path]) => path.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, file]) => ({ path, revision: file.revision, byte_length: file.bytes.length, media_type: "text/plain" }));
      const cursor = payload.cursor === null ? 0 : Number(String(payload.cursor).replace(/^offset:/u, ""));
      const limit = Number(payload.limit);
      const entries = files.slice(cursor, cursor + limit);
      const next = cursor + entries.length;
      return { entries, next_cursor: next < files.length ? `offset:${next}` : null };
    }
    if (operation === "workspace.file.read") {
      const path = String(payload.path);
      this.reads.push(path);
      const file = this.filesFor(payload).get(path);
      if (!file) throw Object.assign(new Error(`missing ${path}`), { code: "file_not_found" });
      const offset = Number(payload.offset);
      const length = Number(payload.length);
      const bytes = file.bytes.slice(offset, offset + length);
      const next = offset + bytes.length;
      return {
        revision: file.revision,
        total_bytes: file.bytes.length,
        offset,
        bytes: Array.from(bytes),
        next_offset: next < file.bytes.length ? next : null,
      } satisfies ReadChunk;
    }
    if (operation === "workspace.change.propose") {
      const change = payload.changeset as ChangeSet;
      this.changeset = change;
      return { proposal_id: "proposal-1", preview: { title: change.title, read_paths: [], units: [] } };
    }
    if (operation === "workspace.identity.read") return this.identity;
    if (operation === "workspace.change.timestamp") return { timestamp: this.timestamp };
    throw new Error(`Unexpected Host operation: ${operation}`);
  }
}

function request(action_id: string, input: Record<string, unknown>, idempotency_key?: string): ActionRequest {
  return {
    request_id: `request-${action_id}`,
    plugin_id: "proprium.narrative",
    action_id,
    schema_version: 1,
    scope,
    snapshot: { ...snapshot },
    input,
    deadline_ms: 30_000,
    ...(idempotency_key ? { idempotency_key } : {}),
  };
}

function run(host: MemoryHost, req: ActionRequest): unknown {
  const action = invokeNarrative(req, {
    *request<T>(operation: string, payload: Record<string, unknown>): Generator<{ kind: "host_call"; call_id: string; operation: string; payload: Record<string, unknown> }, T, unknown> {
      return (yield { kind: "host_call", call_id: "", operation, payload }) as T;
    },
  });
  let state = action.next();
  while (!state.done) {
    const call = state.value as { operation: string; payload: Record<string, unknown> };
    try { state = action.next(host.respond(call.operation, call.payload)); }
    catch (error) { state = action.throw(error); }
  }
  return state.value;
}

function addWork(host: MemoryHost, sceneCount = 2): void {
  host.add("plot/volumes/folder-not-id/volume.yaml", "# volume note\nid: work-volume\ntitle: Work\ntype: volume\norder: 1\nunknown: keep\n");
  host.add("plot/volumes/folder-not-id/chapters/directory-not-id/chapter.yaml", "id: work-chapter\ntype: chapter\ntitle: Chapter\nvolume: work-volume\norder: 1\n");
  for (let index = 1; index <= sceneCount; index++) {
    const id = `scene-${index}`;
    const path = `manuscript/custom/${id}.md`;
    host.add(`plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-${id}.yaml`,
      `id: ${id}\ntype: scene\ntitle: Scene ${index}\nvolume: work-volume\nchapter: work-chapter\norder: ${index}\nmanuscript: ${path}\n`);
    if (index === 1) host.add(path, "Body\n");
  }
}

function sourceOperation(id: string, kind: string, precondition: Record<string, unknown>, target: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  return { id, kind, evidenceIds: [], assessment: { confidence: 0.9, risk: "low" }, precondition, target, ...fields };
}
function sourceRaw(host: MemoryHost, path: string): Record<string, unknown> {
  return parseYamlRecord(new TextDecoder().decode(host.files.get(path)!.bytes), path).value;
}

test("SHA-256 guest identity uses the standard digest", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("tree pages more than 256 hierarchy files and opens the explicit manuscript link", () => {
  const host = new MemoryHost();
  addWork(host, 300);
  const detected = run(host, request("proprium.narrative.work.detect", {})) as { status: string; work_id: string; health: string };
  assert.equal(detected.status, "recognized");
  assert.equal(detected.work_id, "github:42");
  assert.equal(detected.health, "clean");
  assert.ok(host.calls.get("workspace.file.list")! > 1);

  const page = run(host, request("proprium.narrative.hierarchy.tree", { parent_id: "work-chapter", limit: 128 })) as {
    items: Array<{ id: string; manuscript_path?: string }>;
    next_cursor: string;
    tree_revision: string;
  };
  assert.equal(page.items.length, 128);
  assert.equal(page.items[0]?.manuscript_path, "manuscript/custom/scene-1.md");
  assert.ok(page.next_cursor);
  const rest = run(host, request("proprium.narrative.hierarchy.tree", {
    parent_id: "work-chapter", cursor: page.next_cursor, limit: 200, expected_tree_revision: page.tree_revision,
  })) as { items: unknown[]; next_cursor: null };
  assert.equal(rest.items.length, 172);
  assert.equal(rest.next_cursor, null);
  assert.equal(host.reads.some((path) => path.startsWith("manuscript/")), false, "tree listing does not read bodies");

  const opened = run(host, request("proprium.narrative.scene.open", { scene_id: "scene-1" })) as {
    manuscript_path: string;
    navigation: { target: { path: string } };
  };
  assert.equal(opened.manuscript_path, "manuscript/custom/scene-1.md");
  assert.equal(opened.navigation.target.path, opened.manuscript_path);
  assert.deepEqual(host.reads.filter((path) => path.startsWith("manuscript/")), ["manuscript/custom/scene-1.md"]);
});

test("scene creation proposes body, metadata and reordered siblings in one unit", () => {
  const host = new MemoryHost();
  addWork(host, 2);
  const detected = run(host, request("proprium.narrative.work.detect", {})) as { tree_revision: string };
  const result = run(host, request("proprium.narrative.structure.create", {
    kind: "scene", title: "第３章 — Arrival", volume_id: "work-volume", chapter_id: "work-chapter", position: 2,
    expected_tree_revision: detected.tree_revision,
  }, "create-scene-1")) as { proposal_id: string };
  assert.equal(result.proposal_id, "proposal-1");
  const change = host.changeset!;
  const operations = change.units[0]!.operations;
  assert.equal(change.units.length, 1);
  assert.equal(operations.length, 3);
  assert.deepEqual(operations.map((operation) => operation.kind), ["create", "create", "replace"]);
  assert.equal(operations[0]!.path, "plot/volumes/work-volume/chapters/work-chapter/scenes/sc-3-arrival.yaml");
  assert.equal(change.read_set.find((entry) => entry.path === "manuscript/work-volume/work-chapter/sc-3-arrival.md")?.revision, null);
  assert.match(new TextDecoder().decode(new Uint8Array(operations[0]!.content!)), /manuscript: manuscript\/work-volume\/work-chapter\/sc-3-arrival\.md/u);
  assert.equal(narrativeIdForTitle("scene", "同じ", ["sc-1", "sc-2"]), "sc-3");
});

test("new volume order follows the highest finite order and titles retain accepted surrounding whitespace", () => {
  const host = new MemoryHost();
  addWork(host, 0);
  host.add("plot/volumes/second/volume.yaml", "id: second\ntype: volume\ntitle: Second\norder: 4\n");
  host.add("plot/volumes/third/volume.yaml", "id: third\ntype: volume\ntitle: Third\n");
  const detected = run(host, request("proprium.narrative.work.detect", {})) as { tree_revision: string };
  run(host, request("proprium.narrative.structure.create", {
    kind: "volume", title: " New volume ", id: "new-volume", expected_tree_revision: detected.tree_revision,
  }, "create-volume"));
  const operation = host.changeset!.units[0]!.operations.find((row) => row.path.endsWith("/new-volume/volume.yaml"))!;
  const created = parseYamlRecord(new TextDecoder().decode(new Uint8Array(operation.content!)), operation.path);
  assert.equal(created.value.order, 5);
  assert.equal(created.value.title, " New volume ");
  assert.equal(host.changeset!.units[0]!.operations.length, 1, "append leaves existing records untouched");
});

test("known but unusable hierarchy paths diagnose malformed work and do not return an empty root tree", () => {
  const host = new MemoryHost();
  host.add("plot/volumes/broken/volume.yaml", "- not a mapping\n");
  const detected = run(host, request("proprium.narrative.work.detect", {})) as { status: string; diagnostics: Array<{ code: string }> };
  assert.equal(detected.status, "malformed");
  assert.ok(detected.diagnostics.some((item) => item.code === "malformed_work"));
  assert.throws(() => run(host, request("proprium.narrative.hierarchy.tree", {})),
    (error: unknown) => (error as { code?: string }).code === "unsupported_format");
});

test("hierarchy keeps tied and missing order rows accessible with diagnostics", () => {
  const host = new MemoryHost();
  addWork(host, 3);
  const tiedPath = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-2.yaml";
  const tied = new TextDecoder().decode(host.files.get(tiedPath)!.bytes).replace("order: 2", "order: 1");
  host.add(tiedPath, tied);
  const missingPath = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-3.yaml";
  host.add(missingPath, new TextDecoder().decode(host.files.get(missingPath)!.bytes).replace("order: 3\n", ""));
  const detected = run(host, request("proprium.narrative.work.detect", {})) as { health: string; diagnostics: Array<{ code: string; path?: string }> };
  assert.equal(detected.health, "partial");
  assert.ok(detected.diagnostics.some((item) => item.code === "invalid_order" && item.path === tiedPath));
  assert.ok(detected.diagnostics.some((item) => item.code === "invalid_order" && item.path === missingPath));
  const tree = run(host, request("proprium.narrative.hierarchy.tree", { parent_id: "work-chapter" })) as { items: Array<{ id: string }> };
  assert.deepEqual(tree.items.map((row) => row.id), ["scene-1", "scene-2", "scene-3"]);
});

test("reading marks preserve malformed rows, YAML comments and unknown fields with UTF-16 spans", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const path = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-1.yaml";
  const source = "# scene comment\nid: scene-1\ntype: scene\ntitle: Scene 1\nvolume: work-volume\nchapter: work-chapter\norder: 1\nmanuscript: manuscript/custom/scene-1.md\nreadingMarks:\n  # retain this annotation\n  - id: old\n    offset: 0\n    length: 1\n    snippet: A\n    createdAt: '2026-10-26T00:00:00Z'\n    futureField: retain\n  - id: broken\n    offset: nope\n";
  const metadataRevision = host.add(path, source);
  const manuscriptRevision = host.add("manuscript/custom/scene-1.md", "A漢🙂\nbody\n");
  const listed = run(host, request("proprium.narrative.reading-marks.list", { scene_id: "scene-1" })) as {
    metadata_revision: string; manuscript_revision: string; marks: Array<{ id: string; position_status: string }>;
    diagnostics: Array<{ code: string; index?: number }>;
  };
  assert.equal(listed.metadata_revision, metadataRevision);
  assert.equal(listed.manuscript_revision, manuscriptRevision);
  assert.deepEqual(listed.marks.map((mark) => [mark.id, mark.position_status]), [["old", "current"]]);
  assert.ok(listed.diagnostics.some((item) => item.code === "invalid_reading_marks" && item.index === 1));

  run(host, request("proprium.narrative.reading-marks.create", {
    scene_id: "scene-1",
    mark: { id: "japanese-passage", offset: 1, length: 3, snippet: "漢🙂", createdAt: "2026-10-26T01:00:00Z" },
    expected_metadata_revision: metadataRevision,
    expected_manuscript_revision: manuscriptRevision,
  }, "mark-scene-1"));
  const change = host.changeset!;
  assert.deepEqual(change.read_set.find((entry) => entry.path === "manuscript/custom/scene-1.md"), {
    path: "manuscript/custom/scene-1.md", revision: manuscriptRevision,
  });
  const changed = new TextDecoder().decode(new Uint8Array(change.units[0]!.operations[0]!.content!));
  for (const retained of ["# scene comment", "# retain this annotation", "futureField: retain", "offset: nope", "id: japanese-passage"]) {
    assert.ok(changed.includes(retained), `preserves ${retained}`);
  }
});

test("changes.compile emits a source-mapped scene metadata/body unit and complete sibling insert", () => {
  const host = new MemoryHost();
  addWork(host, 2);
  const chapterPath = "plot/volumes/folder-not-id/chapters/directory-not-id/chapter.yaml";
  const scenePaths = [
    "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-1.yaml",
    "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-2.yaml",
  ];
  const expectedSiblings = scenePaths.map((path) => {
    const raw = sourceRaw(host, path);
    return { id: String(raw.id), revision: narrativeEntityRevision(raw) };
  });
  const result = run(host, request("proprium.narrative.changes.compile", {
    operations: [
      sourceOperation("create-scene", "scene.create", { kind: "absent" }, { sceneId: "scene-3" }, {
        values: { id: "scene-3", type: "scene", title: "Inserted", volume: "work-volume", chapter: "work-chapter", order: 3 },
      }),
      sourceOperation("insert-scene", "scene.insert", { kind: "revision", value: narrativeEntityRevision(sourceRaw(host, chapterPath)) },
        { sceneId: "scene-3", chapterId: "work-chapter" }, { position: 2, expectedSiblings }),
    ],
    evidence: [],
  })) as {
    read_set: Array<{ path: string; revision: string | null }>;
    units: Array<{ source_operation_ids: string[]; operations: Array<{ id: string; kind: string; path: string; expected_revision: string | null; content?: number[] }> }>;
    operation_map: Array<{ source_operation_id: string; unit_id: string; operation_ids: string[] }>;
  };
  assert.equal(result.units.length, 1);
  assert.deepEqual(result.units[0]!.source_operation_ids, ["create-scene", "insert-scene"]);
  assert.equal(result.units[0]!.operations.length, 3);
  const metadata = result.units[0]!.operations.find((operation) => operation.path.endsWith("/scenes/scene-3.yaml"))!;
  assert.equal(metadata.kind, "create");
  assert.equal(metadata.expected_revision, null);
  assert.match(new TextDecoder().decode(new Uint8Array(metadata.content!)), /order: 2/u);
  const body = result.units[0]!.operations.find((operation) => operation.path === "manuscript/work-volume/work-chapter/scene-3.md")!;
  assert.equal(body.kind, "create");
  assert.match(new TextDecoder().decode(new Uint8Array(body.content!)), /status: planned/u);
  assert.equal(result.read_set.find((entry) => entry.path === body.path)?.revision, null);
  assert.deepEqual(result.operation_map.map((item) => item.source_operation_id), ["create-scene", "insert-scene"]);
  assert.equal(host.changeset, undefined, "the compiler never proposes a ChangeSet");
  assert.equal(host.calls.get("workspace.change.propose"), undefined);
});

test("changes.compile splits Narrative scene fields from semantic fields and verifies UTF-16 mark evidence", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const metadataPath = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-1.yaml";
  const bodyPath = "manuscript/custom/scene-1.md";
  const metadata = sourceRaw(host, metadataPath);
  const metadataRevision = narrativeEntityRevision(metadata);
  const bodyRevision = host.add(bodyPath, "A漢🙂\nbody\n");
  const mark = { id: "pair-mark", offset: 1, length: 3, snippet: "漢🙂", createdAt: "2026-10-26T01:00:00Z" };
  const result = run(host, request("proprium.narrative.changes.compile", {
    operations: [sourceOperation("update-scene", "scene.update", { kind: "revision", value: metadataRevision }, { sceneId: "scene-1" }, {
      changes: { title: "Changed title", pov: "character-1", readingMarks: [mark] }, evidenceIds: ["body-range"],
    })],
    evidence: [{ id: "body-range", sourceKind: "manuscript", sourceId: bodyPath, revision: bodyRevision, range: { start: 1, end: 4 } }],
  })) as { read_set: Array<{ path: string; revision: string | null }>; units: Array<{ operations: Array<{ path: string; content?: number[] }> }> };
  const output = new TextDecoder().decode(new Uint8Array(result.units[0]!.operations[0]!.content!));
  assert.match(output, /title: Changed title/u);
  assert.match(output, /id: pair-mark/u);
  assert.doesNotMatch(output, /pov:/u, "Knowledge-owned fields stay out of the Narrative projection");
  assert.equal(result.read_set.find((entry) => entry.path === bodyPath)?.revision, bodyRevision);
  assert.equal(host.calls.get("workspace.change.propose"), undefined);
});

test("changes.compile rejects unsupported owners and stale source revisions", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const metadataPath = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-1.yaml";
  const metadataRevision = narrativeEntityRevision(sourceRaw(host, metadataPath));
  assert.throws(() => run(host, request("proprium.narrative.changes.compile", {
    operations: [sourceOperation("update-scene", "scene.update", { kind: "revision", value: metadataRevision }, { sceneId: "scene-1" }, { changes: { pov: "character-1" } })],
    evidence: [],
  })), (error: unknown) => (error as { code?: string }).code === "dependency_unavailable");
  assert.throws(() => run(host, request("proprium.narrative.changes.compile", {
    operations: [sourceOperation("update-scene", "scene.update", { kind: "revision", value: "stale" }, { sceneId: "scene-1" }, { changes: { title: "Changed" } })],
    evidence: [],
  })), (error: unknown) => (error as { code?: string }).code === "snapshot_stale");
});

test("changes.compile reads staged YAML but keeps source preconditions and read_set on the original snapshot", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const metadataPath = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-1.yaml";
  const originalRaw = sourceRaw(host, metadataPath);
  const originalRevision = narrativeEntityRevision(originalRaw);
  const originalFileRevision = host.files.get(metadataPath)!.revision;
  const stagedText = `${new TextDecoder().decode(host.files.get(metadataPath)!.bytes)}pov: character-1\n`;
  const stagedFileRevision = host.addSnapshot("stage-1", metadataPath, stagedText);
  const result = run(host, request("proprium.narrative.changes.compile", {
    staging_snapshot: "stage-1",
    operations: [sourceOperation("mixed-update", "scene.update", { kind: "revision", value: originalRevision }, { sceneId: "scene-1" }, {
      changes: { title: "Staged projection" },
    })],
    evidence: [],
  })) as { read_set: Array<{ path: string; revision: string | null }>; units: Array<{ operations: Array<{ path: string; content?: number[]; expected_revision: string | null }> }> };
  const outputOperation = result.units[0]!.operations[0]!;
  const output = new TextDecoder().decode(new Uint8Array(outputOperation.content!));
  assert.equal(outputOperation.expected_revision, originalFileRevision);
  assert.equal(result.read_set.find((entry) => entry.path === metadataPath)?.revision, originalFileRevision);
  assert.match(output, /title: Staged projection/u);
  assert.match(output, /pov: character-1/u);
  assert.notEqual(stagedFileRevision, originalFileRevision);
});

test("resume.marks.list pages scoped markers, checks linked body revisions and reports file-level publication", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const bodyPath = "manuscript/custom/scene-1.md";
  const bodyRevision = host.add(bodyPath, "Saved manuscript\n");
  const markerPath = "meta/proprium/plugins/proprium.narrative/resume.v1.yaml";
  const markerRevision = host.add(markerPath, [
    "schemaVersion: 1",
    "positions:",
    "  - deviceId: device-a",
    "    repositoryId: 42",
    "    branch: main",
    "    sceneId: scene-1",
    "    manuscriptPath: manuscript/custom/scene-1.md",
    `    manuscriptRevision: ${bodyRevision}`,
    "    sentenceIndex: 2",
    "    scrollTop: 15",
    "    updatedAt: '2026-10-26T01:00:00Z'",
    "  - deviceId: device-b",
    "    repositoryId: 42",
    "    branch: main",
    "    sceneId: scene-1",
    "    manuscriptPath: manuscript/custom/scene-1.md",
    `    manuscriptRevision: ${"a".repeat(64)}`,
    "    sentenceIndex: null",
    "    scrollTop: 0",
    "    updatedAt: '2026-10-26T01:30:00Z'",
    "  - deviceId: another-branch",
    "    repositoryId: 42",
    "    branch: draft",
    "    sceneId: scene-1",
    "    manuscriptPath: manuscript/custom/scene-1.md",
    `    manuscriptRevision: ${bodyRevision}`,
    "    sentenceIndex: 3",
    "    scrollTop: 2",
    "    updatedAt: '2026-10-26T01:45:00Z'",
    "",
  ].join("\n"));
  host.identity = { device_id: "device-local", legacy_project_ids: [], publication: {
    remote_commit: "remote-commit", files: [{ path: markerPath, revision: markerRevision, remote_confirmed: true }],
  } };
  const first = run(host, request("proprium.narrative.resume.marks.list", { limit: 1 })) as {
    items: Array<{ device_id: string; title: string; availability: string; publication: string }>;
    next_cursor: string | null;
    source_revision: string;
  };
  assert.equal(first.items.length, 1);
  assert.deepEqual(first.items[0], {
    device_id: "device-a", scene_id: "scene-1", title: "Scene 1", manuscript_path: bodyPath,
    manuscript_revision: bodyRevision, sentence_index: 2, scroll_top: 15,
    updated_at: "2026-10-26T01:00:00Z", availability: "ready", publication: "remote_confirmed",
  });
  assert.equal(first.source_revision, markerRevision);
  assert.ok(first.next_cursor);
  const second = run(host, request("proprium.narrative.resume.marks.list", { cursor: first.next_cursor!, limit: 1 })) as {
    items: Array<{ device_id: string; availability: string; publication: string }>;
    next_cursor: string | null;
  };
  assert.deepEqual(second.items.map((item) => [item.device_id, item.availability, item.publication]), [["device-b", "stale", "remote_confirmed"]]);
  assert.equal(second.next_cursor, null);
});

test("resume markers reject malformed manuscript revisions", () => {
  const host = new MemoryHost();
  host.add("meta/proprium/plugins/proprium.narrative/resume.v1.yaml", [
    "schemaVersion: 1", "positions:", "  - deviceId: device-a", "    repositoryId: 42",
    "    branch: main", "    sceneId: scene-1", "    manuscriptPath: manuscript/a.md",
    "    manuscriptRevision: invalid", "    sentenceIndex: null", "    scrollTop: 0",
    "    updatedAt: '2026-10-26T01:00:00Z'", "",
  ].join("\n"));
  assert.throws(() => run(host, request("proprium.narrative.resume.marks.list", {})), { code: "unsupported_format" });
});

test("resume.mark.propose updates only this device marker and preserves unknown YAML with exact preconditions", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const bodyPath = "manuscript/custom/scene-1.md";
  const bodyRevision = host.add(bodyPath, "Saved manuscript\n");
  const markerPath = "meta/proprium/plugins/proprium.narrative/resume.v1.yaml";
  const original = [
    "# retain root comment",
    "schemaVersion: 1",
    "futureRoot: keep",
    "positions:",
    "  - deviceId: device-local",
    "    repositoryId: 42",
    "    branch: main",
    "    sceneId: scene-1",
    "    manuscriptPath: manuscript/custom/scene-1.md",
    `    manuscriptRevision: ${bodyRevision}`,
    "    sentenceIndex: 1 # retain scalar comment",
    "    scrollTop: 4",
    "    updatedAt: '2026-10-26T01:00:00Z'",
    "    futureEntry: keep",
    "  - deviceId: other-device",
    "    repositoryId: 42",
    "    branch: main",
    "    sceneId: scene-1",
    "    manuscriptPath: manuscript/custom/scene-1.md",
    `    manuscriptRevision: ${bodyRevision}`,
    "    sentenceIndex: null",
    "    scrollTop: 0",
    "    updatedAt: '2026-10-26T01:30:00Z'",
    "",
  ].join("\n");
  const markerRevision = host.add(markerPath, original);
  host.identity = { device_id: "device-local", legacy_project_ids: [] };
  const result = run(host, request("proprium.narrative.resume.mark.propose", {
    scene_id: "scene-1", expected_manuscript_revision: bodyRevision, expected_marker_revision: markerRevision,
    sentence_index: 5, scroll_top: 22.5,
  }, "save-resume-position")) as { proposal_id: string };
  assert.equal(result.proposal_id, "proposal-1");
  assert.equal(host.calls.get("workspace.identity.read"), 1);
  assert.equal(host.calls.get("workspace.change.timestamp"), 1);
  const changeset = host.changeset!;
  assert.equal(changeset.units.length, 1);
  const operation = changeset.units[0]!.operations[0]!;
  assert.equal(operation.kind, "replace");
  assert.equal(operation.path, markerPath);
  assert.equal(operation.expected_revision, markerRevision);
  assert.equal(changeset.read_set.find((entry) => entry.path === bodyPath)?.revision, bodyRevision);
  const changed = new TextDecoder().decode(new Uint8Array(operation.content!));
  for (const retained of ["# retain root comment", "futureRoot: keep", "# retain scalar comment", "futureEntry: keep", "deviceId: other-device"]) {
    assert.ok(changed.includes(retained), `preserves ${retained}`);
  }
  assert.match(changed, /sentenceIndex: 5 # retain scalar comment/u);
  assert.match(changed, /scrollTop: 22\.5/u);
  assert.match(changed, /updatedAt: '2026-10-26T02:00:00Z'/u);

  const dirtyRequest = request("proprium.narrative.resume.mark.propose", {
    scene_id: "scene-1", expected_manuscript_revision: bodyRevision, expected_marker_revision: markerRevision,
    sentence_index: 5, scroll_top: 22.5,
  }, "dirty-resume-position");
  dirtyRequest.snapshot = { ...snapshot, draft_generation: "pending-draft" };
  assert.throws(() => run(host, dirtyRequest), (error: unknown) => (error as { code?: string }).code === "dirty_draft");
});

test("resume.mark.propose creates the portable marker with an absent-path precondition", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const bodyPath = "manuscript/custom/scene-1.md";
  const bodyRevision = host.add(bodyPath, "Saved manuscript\n");
  host.identity = { device_id: "device-new", legacy_project_ids: [] };
  run(host, request("proprium.narrative.resume.mark.propose", {
    scene_id: "scene-1", expected_manuscript_revision: bodyRevision, expected_marker_revision: null,
    sentence_index: null, scroll_top: 0,
  }, "create-portable-position"));
  const operation = host.changeset!.units[0]!.operations[0]!;
  assert.equal(operation.path, "meta/proprium/plugins/proprium.narrative/resume.v1.yaml");
  assert.equal(operation.kind, "create");
  assert.equal(operation.expected_revision, null);
  const created = new TextDecoder().decode(new Uint8Array(operation.content!));
  assert.match(created, /schemaVersion: 1/u);
  assert.match(created, /deviceId: device-new/u);
  assert.match(created, /repositoryId: 42/u);
  assert.match(created, /sentenceIndex: null/u);
});

test("YAML edits preserve unrelated source and the component guest resumes Host calls", () => {
  const original = "# keep\r\nid: ch-1\r\ntype: chapter\r\ntitle: \"Old\" # title note\r\nvolume: vol-1\r\nunknown: { future: true }\r\n";
  const updated = updateYamlFields(original, "chapter.yaml", { title: "New" });
  assert.equal(updated, original.replace('"Old"', '"New"'));
  const appended = appendYamlSequenceValue(original, "chapter.yaml", "readingMarks", { id: "mark-1" });
  assert.match(appended, /unknown: \{ future: true \}/u);
  const removed = removeYamlSequenceIndex(appended, "chapter.yaml", "readingMarks", 0);
  assert.doesNotMatch(removed, /id: mark-1/u);

  const host = new MemoryHost();
  addWork(host, 1);
  guest.initialize({ pluginId: "proprium.narrative", version: "0.1.0", workspaceId: scope.workspace_id });
  let message = guest.invoke(JSON.stringify(request("proprium.narrative.work.detect", {})));
  let steps = 0;
  for (;;) {
    const call = JSON.parse(message) as { kind?: string; call_id?: string; operation?: string; payload?: Record<string, unknown>; ok?: boolean };
    if (call.kind !== "host_call") {
      assert.equal(call.ok, true);
      const response = JSON.parse(message) as { value: { status: string; work_id: string } };
      assert.equal(response.value.status, "recognized");
      assert.equal(response.value.work_id, "github:42");
      break;
    }
    message = guest.invoke(JSON.stringify({
      kind: "host_response", call_id: call.call_id, ok: true, value: host.respond(call.operation!, call.payload!),
    }));
    if (++steps > 30) assert.fail("guest did not finish its Host continuation");
  }
  guest.dispose();
});

test("component guest routes changes.compile through cooperative Host continuations", () => {
  const host = new MemoryHost();
  addWork(host, 1);
  const scenePath = "plot/volumes/folder-not-id/chapters/directory-not-id/scenes/file-scene-1.yaml";
  const sceneRaw = sourceRaw(host, scenePath);
  guest.initialize({ pluginId: "proprium.narrative", version: "0.1.0", workspaceId: scope.workspace_id });
  let message = guest.invoke(JSON.stringify(request("proprium.narrative.changes.compile", {
    operations: [sourceOperation("update-scene", "scene.update", { kind: "revision", value: narrativeEntityRevision(sceneRaw) }, { sceneId: "scene-1" }, {
      changes: { title: "Through WASM adapter" },
    })], evidence: [],
  })));
  let steps = 0;
  for (;;) {
    const call = JSON.parse(message) as { kind?: string; call_id?: string; operation?: string; payload?: Record<string, unknown>; ok?: boolean; value?: unknown };
    if (call.kind !== "host_call") {
      assert.equal(call.ok, true);
      const result = call.value as { operation_map: Array<{ source_operation_id: string }> };
      assert.deepEqual(result.operation_map.map((item) => item.source_operation_id), ["update-scene"]);
      break;
    }
    message = guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value: host.respond(call.operation!, call.payload!) }));
    if (++steps > 50) assert.fail("compiler guest did not finish its Host continuation");
  }
  assert.equal(host.calls.get("workspace.change.propose"), undefined);
  guest.dispose();
});
