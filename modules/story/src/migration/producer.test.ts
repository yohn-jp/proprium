import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationContext, SqliteRow, SqliteTableInfo } from "@scriptorium/migration";
import { createStoryMigrationProducer } from "./producer.js";

const yaml = "id: scene-17\ntype: scene\nfuture_story_field:\n  nested: preserved\n";
const markdown = "---\ntitle: Draft\nfuture_frontmatter: retained\n---\n本文\n";
const revision = "a".repeat(64);

function contextFor(input: {
  files?: Record<string, string>;
  workspaceFiles?: Record<string, string>;
  targets?: Record<string, string>;
  targetFiles?: string[];
  enabled?: boolean;
  legacyRepositoryMappings?: Record<string, { provider: "github"; repositoryId: string; defaultBranch: string; ownerScope: string; url: string }>;
  sqliteProject?: Record<string, SqliteRow[]>;
  sqliteWorkspace?: Record<string, SqliteRow[]>;
}): MigrationContext {
  const files = new Map(
    Object.entries(input.files ?? {}).map(([path, content]) => [path, Buffer.from(content)]),
  );
  const targets = new Map(Object.entries(input.targets ?? {}));
  const workspaceFiles = new Map(Object.entries(input.workspaceFiles ?? {}).map(([path, content]) => [path, Buffer.from(content)]));
  const repository = {
    provider: "local" as const,
    repositoryId: "story-migration-test",
    defaultBranch: "main",
    ownerScope: "test-owner",
    url: "file:///legacy/story",
  };
  const snapshot = { repository, remoteCommit: "b".repeat(40) };
  const sqliteProject = input.sqliteProject ?? {};
  const sqliteWorkspace = input.sqliteWorkspace ?? {};
  const sqliteTables = (tables: Record<string, SqliteRow[]>): SqliteTableInfo[] => Object.keys(tables).sort().map((name) => ({ name, sql: null, columns: [] }));

  return {
    source: {
      projectRoot: "/legacy/story",
      ...(input.sqliteWorkspace ? { workspaceDataRoot: "/legacy/workspace" } : {}),
      async readProjectFile(path) {
        return files.get(path) ?? null;
      },
      async listProjectFiles(prefix) {
        return [...files.keys()].filter((path) => path.startsWith(`${prefix}/`)).sort();
      },
      async readWorkspaceFile(path) { return workspaceFiles.get(path) ?? null; },
      async listWorkspaceFiles(prefix) { return [...workspaceFiles.keys()].filter((path) => path.startsWith(`${prefix}/`)).sort(); },
      async inspectSqlite(path) { return path === ".arcadia/index.sqlite" ? sqliteTables(sqliteProject) : []; },
      async readSqliteTable(path, table) { return path === ".arcadia/index.sqlite" ? sqliteProject[table] ?? [] : []; },
      async inspectWorkspaceSqlite(path) { return path === "index/story/index.sqlite" ? sqliteTables(sqliteWorkspace) : []; },
      async readWorkspaceSqliteTable(path, table) { return path === "index/story/index.sqlite" ? sqliteWorkspace[table] ?? [] : []; },
    } as MigrationContext["source"],
    target: {
      snapshot,
      async read(path) {
        const content = targets.get(path);
        return content === undefined ? null : { content, revision };
      },
      async list(prefix) {
        return (input.targetFiles ?? []).filter((path) => path.startsWith(`${prefix}/`)).sort();
      },
    },
    repository,
    snapshot,
    enabledModules: new Set(input.enabled === false ? [] : ["story"]),
    ...(input.legacyRepositoryMappings ? { legacyRepositoryMappings: input.legacyRepositoryMappings } : {}),
  };
}

test("imports canonical YAML and Markdown byte-for-byte at their source paths", async () => {
  const files = {
    "bible/characters/hero/profile.yaml": "id: hero-17\nfuture_character_field: retained\n",
    "plot/volumes/vol-1/scenes/scene-17.yaml": yaml,
    "meta/project.yaml": "id: project-17\nfuture_project_field: retained\n",
    "manuscript/vol-1/ch-1/scene-17.md": markdown,
    "meta/feature-settings.json": "{}",
  };
  const context = contextFor({ files });

  const result = await createStoryMigrationProducer().inspect(context);

  assert.equal(result.operations.length, 4);
  assert.equal(result.recovery.length, 0);
  assert.deepEqual(
    result.operations.flatMap((operation) => operation.writes.map(({ path, content }) => ({ path, content })))
      .sort((a, b) => a.path.localeCompare(b.path)),
    Object.entries(files)
      .filter(([path]) => path.endsWith(".yaml") || path.endsWith(".md"))
      .map(([path, content]) => ({ path, content }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.ok(
    result.operations.some((operation) =>
      operation.writes.some(({ path, content }) =>
        path === "plot/volumes/vol-1/scenes/scene-17.yaml" &&
        content === "id: scene-17\ntype: scene\nfuture_story_field:\n  nested: preserved\n",
      ),
    ),
  );
  assert.ok(
    result.operations.some((operation) =>
      operation.writes.some(({ path, content }) =>
        path === "manuscript/vol-1/ch-1/scene-17.md" && content === markdown,
      ),
    ),
  );
  assert.ok(result.entries.every(({ category, disposition }) => category === "authoritative" && disposition === "planned"));
});

test("preserves source Story files opaquely while the module is disabled", async () => {
  const source = "bible/locations/harbor.yaml";
  const content = "id: harbor\nunknown_future_field: retained\n";
  const result = await createStoryMigrationProducer().inspect(
    contextFor({ files: { [source]: content }, enabled: false }),
  );

  assert.equal(result.entries[0]?.source, source);
  assert.equal(
    result.entries[0]?.target,
    "meta/scriptorium/modules/story/legacy/files/bible/locations/harbor.yaml",
  );
  assert.equal(result.entries[0]?.category, "authoritative");
  assert.equal(result.entries[0]?.disposition, "preserved-unreadable");
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.operations[0]?.writes[0], {
    path: "meta/scriptorium/modules/story/legacy/files/bible/locations/harbor.yaml",
    revision: null,
    content,
  });
});

test("restores opaque Story documents to canonical paths after re-enabling the module", async () => {
  const source = "plot/threads/thread-3.yaml";
  const opaquePath = `meta/scriptorium/modules/story/legacy/files/${source}`;
  const content = "id: thread-3\nunknown_thread_field: retained\n";
  const result = await createStoryMigrationProducer().inspect(
    contextFor({
      targetFiles: [opaquePath],
      targets: { [opaquePath]: content },
    }),
  );

  assert.equal(result.entries[0]?.source, opaquePath);
  assert.equal(result.entries[0]?.target, source);
  assert.equal(result.entries[0]?.category, "authoritative");
  assert.equal(result.entries[0]?.disposition, "planned");
  assert.deepEqual(result.operations[0]?.writes[0], {
    path: source,
    revision: null,
    content,
  });
});

test("reports a canonical target conflict without overwriting it", async () => {
  const source = "bible/locations/harbor.yaml";
  const result = await createStoryMigrationProducer().inspect(
    contextFor({
      files: { [source]: "id: harbor\nunknown: source\n" },
      targets: { [source]: "id: harbor\nunknown: target\n" },
    }),
  );

  assert.equal(result.entries[0]?.disposition, "conflict");
  assert.equal(result.operations.length, 0);
});

test("maps legacy series project IDs to stable repository IDs and preserves source and unknown fields", async () => {
  const source = JSON.stringify({
    version: 1,
    series: [{ id: "series-one", name: "One", ownerId: "author", bibleProjectId: "old-bible", memberProjectIds: ["old-work"], createdAt: "2026-01-01T00:00:00.000Z", futureField: { keep: true } }],
    bindings: [{ projectId: "old-work", seriesId: "series-one", bibleRev: "abc", futureBinding: "keep" }],
    futureTopLevel: ["keep"],
  });
  const result = await createStoryMigrationProducer().inspect(contextFor({
    workspaceFiles: { "app-state/series.json": source },
    legacyRepositoryMappings: {
      "old-bible": { provider: "github", repositoryId: "123", defaultBranch: "main", ownerScope: "owner", url: "https://github.com/o/bible" },
      "old-work": { provider: "github", repositoryId: "456", defaultBranch: "main", ownerScope: "owner", url: "https://github.com/o/work" },
    },
  }));
  const write = result.operations.flatMap((operation) => operation.writes).find((item) => item.path === "meta/scriptorium/modules/story/v1/series.json");
  assert.ok(write);
  const settings = JSON.parse(write.content!) as Record<string, unknown>;
  assert.deepEqual(settings.futureTopLevel, ["keep"]);
  const series = (settings.series as Array<Record<string, unknown>>)[0]!;
  assert.equal(series.bibleRepositoryId, "123");
  assert.equal(series.bibleProjectId, "old-bible", "original source ID is retained for review/audit");
  assert.deepEqual(series.memberRepositoryIds, ["456"]);
  assert.deepEqual(series.futureField, { keep: true });
  const binding = (settings.bindings as Array<Record<string, unknown>>)[0]!;
  assert.equal(binding.repositoryId, "456");
  assert.equal(binding.projectId, "old-work");
  assert.equal(binding.futureBinding, "keep");
  assert.equal(result.entries.find((entry) => entry.source === "app-state/series.json")?.category, "authoritative");
});

test("retains unresolved series IDs with an explicit author-review marker", async () => {
  const result = await createStoryMigrationProducer().inspect(contextFor({
    workspaceFiles: { "app-state/series.json": JSON.stringify({ version: 1, series: [{ id: "series-one", name: "One", ownerId: "author", bibleProjectId: "old-bible", memberProjectIds: ["old-work"], createdAt: "2026-01-01T00:00:00.000Z" }], bindings: [{ projectId: "old-work", seriesId: "series-one" }] }) },
  }));
  const write = result.operations.flatMap((operation) => operation.writes).find((item) => item.path === "meta/scriptorium/modules/story/v1/series.json");
  assert.ok(write);
  const settings = JSON.parse(write.content!) as { series: Array<Record<string, unknown>>; bindings: Array<Record<string, unknown>>; migration: { storySeriesReview: string[] } };
  assert.equal(settings.series[0]?.bibleProjectId, "old-bible");
  assert.equal(settings.series[0]?.requiresAuthorReview, true);
  assert.equal(settings.bindings[0]?.projectId, "old-work");
  assert.equal(settings.bindings[0]?.requiresAuthorReview, true);
  assert.deepEqual(settings.migration.storySeriesReview, ["series[0].bibleProjectId=old-bible", "series[0].memberProjectIds=old-work", "bindings[0].projectId=old-work"]);
  assert.match(result.entries.find((entry) => entry.source === "app-state/series.json")?.detail ?? "", /author review/i);
});

test("preserves disabled series registry bytes in Story's opaque legacy namespace", async () => {
  const content = '{"version":1,"series":[],"bindings":[],"future":true}\n';
  const result = await createStoryMigrationProducer().inspect(contextFor({ workspaceFiles: { "app-state/series.json": content }, enabled: false }));
  assert.deepEqual(result.operations.flatMap((operation) => operation.writes).find((item) => item.path === "meta/scriptorium/modules/story/legacy/files/app-state/series.json"), {
    path: "meta/scriptorium/modules/story/legacy/files/app-state/series.json", revision: null, content,
  });
  assert.equal(result.entries.find((entry) => entry.source === "app-state/series.json")?.disposition, "preserved-unreadable");
});

test("converts source workflow tables to Story JSONL with decisions, unknown fields, and provenance intact", async () => {
  const state = {
    id: "state-1", scene_id: "scene-1",
    event_json: JSON.stringify({ sceneId: "scene-1", kind: "fact", subject: "char-1", order: 1 }),
    manuscript_hash: "fnv1a:abc", status: "proposed", conflict_event_ids_json: "[]",
    duplicate_of_proposal_id: null, history_json: "[]", created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z", future_state_field: "preserve", api_token: "never-persist",
  } satisfies SqliteRow;
  const zukan = {
    id: "suggestion-1", entity_id: "char-1", block_path: "lead.0", proposed_text: "A verified fact.",
    evidence_json: JSON.stringify([{ quote: "verified fact", sceneId: "scene-1" }]), status: "pending",
    source: "manuscript", kind: "fact", source_session_id: null, source_turn_range_json: null,
    confidence: "high", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    future_zukan_field: { keep: true },
  } satisfies SqliteRow;
  const result = await createStoryMigrationProducer().inspect(contextFor({
    sqliteProject: { state_proposals: [state] },
    sqliteWorkspace: { zukan_suggestions: [zukan] },
  }));
  const writes = result.operations.flatMap((operation) => operation.writes);
  const stateWrite = writes.find((write) => write.path === "meta/scriptorium/modules/story/state-proposals.jsonl");
  const zukanWrite = writes.find((write) => write.path === "meta/scriptorium/modules/story/zukan-suggestions.jsonl");
  assert.ok(stateWrite?.content);
  assert.ok(zukanWrite?.content);
  const stateRecord = JSON.parse(stateWrite.content.trim()) as Record<string, unknown>;
  const zukanRecord = JSON.parse(zukanWrite.content.trim()) as Record<string, unknown>;
  assert.equal(stateRecord.status, "proposed");
  assert.equal(stateRecord.future_state_field, "preserve");
  assert.equal("api_token" in stateRecord, false);
  assert.deepEqual(stateRecord.migrationSource, { databaseSources: [{ databaseId: "project-arcadia", databasePath: ".arcadia/index.sqlite", table: "state_proposals" }] });
  assert.equal(zukanRecord.status, "pending");
  assert.equal(zukanRecord.entityId, "char-1");
  assert.deepEqual(zukanRecord.evidence, [{ quote: "verified fact", sceneId: "scene-1" }]);
  assert.deepEqual(zukanRecord.future_zukan_field, { keep: true });
  assert.deepEqual(zukanRecord.migrationSource, { databaseSources: [{ databaseId: "workspace-index", databasePath: "index/story/index.sqlite", table: "zukan_suggestions" }] });
  assert.ok(result.entries.some((entry) => entry.category === "provisional" && entry.disposition === "planned" && entry.source === "sqlite#state_proposals"));
  assert.ok(result.entries.some((entry) => entry.category === "provisional" && entry.disposition === "planned" && entry.source === "sqlite#zukan_suggestions"));
});

test("withholds divergent workflow IDs and emits explicit local review recovery", async () => {
  const base: SqliteRow = {
    id: "state-duplicate", scene_id: "scene-1",
    event_json: JSON.stringify({ sceneId: "scene-1", kind: "fact", subject: "char-1", order: 1 }),
    manuscript_hash: "hash", status: "proposed", conflict_event_ids_json: "[]",
    duplicate_of_proposal_id: null, history_json: "[]", created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const result = await createStoryMigrationProducer().inspect(contextFor({
    sqliteProject: { state_proposals: [base] },
    sqliteWorkspace: { state_proposals: [{ ...base, status: "approved" }] },
  }));
  assert.equal(result.operations.some((operation) => operation.writes.some((write) => write.path === "meta/scriptorium/modules/story/state-proposals.jsonl")), false);
  assert.ok(result.entries.some((entry) => entry.disposition === "conflict" && /divergent values/.test(entry.detail ?? "")));
  assert.equal(result.recovery.length, 2);
  assert.ok(result.recovery.every((record) => record.category === "provisional" && /explicit author review/.test(record.detail)));
});
