import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationContext } from "@scriptorium/migration";
import { createStoryMigrationProducer } from "./producer.js";

const yaml = "id: scene-17\ntype: scene\nfuture_story_field:\n  nested: preserved\n";
const markdown = "---\ntitle: Draft\nfuture_frontmatter: retained\n---\n本文\n";
const revision = "a".repeat(64);

function contextFor(input: {
  files?: Record<string, string>;
  targets?: Record<string, string>;
  targetFiles?: string[];
  enabled?: boolean;
}): MigrationContext {
  const files = new Map(
    Object.entries(input.files ?? {}).map(([path, content]) => [path, Buffer.from(content)]),
  );
  const targets = new Map(Object.entries(input.targets ?? {}));
  const repository = {
    provider: "local" as const,
    repositoryId: "story-migration-test",
    defaultBranch: "main",
    ownerScope: "test-owner",
    url: "file:///legacy/story",
  };
  const snapshot = { repository, remoteCommit: "b".repeat(40) };

  return {
    source: {
      projectRoot: "/legacy/story",
      async readProjectFile(path) {
        return files.get(path) ?? null;
      },
      async listProjectFiles(prefix) {
        return [...files.keys()].filter((path) => path.startsWith(`${prefix}/`)).sort();
      },
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
