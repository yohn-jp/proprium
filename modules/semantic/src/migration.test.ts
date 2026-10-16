import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationContext } from "@scriptorium/migration";
import { createSemanticMigrationProducer } from "./migration.js";

const repository = {
  provider: "local" as const,
  repositoryId: "semantic-migration-test",
  defaultBranch: "main",
  ownerScope: "test-owner",
  url: "file:///legacy/semantic",
};
const snapshot = { repository, remoteCommit: "b".repeat(40) };
const legacyPath = "meta/scriptorium/modules/semantic/legacy/files/meta/contradiction-dismissals.jsonl";
const canonicalPath = "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl";
const revision = "a".repeat(64);

function contextFor(input: { source?: string; targets?: Record<string, string>; enabled?: boolean }): MigrationContext {
  const targets = new Map(Object.entries(input.targets ?? {}));
  return {
    source: {
      projectRoot: "/legacy/semantic",
      async readProjectFile(path) { return path === "meta/contradiction-dismissals.jsonl" && input.source !== undefined ? Buffer.from(input.source) : null; },
      async listProjectFiles() { return []; },
      async readWorkspaceFile() { return null; },
      async listWorkspaceFiles() { return []; },
      async inspectSqlite() { return []; },
      async readSqliteTable() { return []; },
      async inspectWorkspaceSqlite() { return []; },
      async readWorkspaceSqliteTable() { return []; },
      async inspectGit() { throw new Error("unused"); },
      async readGitPendingFiles() { throw new Error("unused"); },
    } as MigrationContext["source"],
    target: {
      snapshot,
      async read(path) {
        const content = targets.get(path);
        return content === undefined ? null : { content, revision };
      },
      async list(prefix) { return [...targets.keys()].filter((path) => path.startsWith(`${prefix}/`)).sort(); },
    },
    repository,
    snapshot,
    enabledModules: new Set(input.enabled === false ? [] : ["semantic"]),
  };
}

test("semantic reactivation restores opaque dismissal decisions exactly and reports conflicts", async () => {
  const sourceBytes = '{"candidateId":"rule:item-owner-mismatch:sc-1:sc-2:c-1:item-1","timestamp":"2025-03-01T00:00:00.000Z","future":true}\nnot-json\n';
  const restored = await createSemanticMigrationProducer().inspect(contextFor({ targets: { [legacyPath]: sourceBytes } }));
  assert.equal(restored.entries[0]?.source, legacyPath);
  assert.equal(restored.entries[0]?.target, canonicalPath);
  assert.equal(restored.entries[0]?.category, "authoritative");
  assert.equal(restored.entries[0]?.disposition, "planned");
  assert.equal(restored.operations[0]?.writes[0]?.content, sourceBytes);
  assert.deepEqual(restored.operations[0]?.reads, [{ path: canonicalPath, revision: null }]);

  const conflict = await createSemanticMigrationProducer().inspect(contextFor({
    targets: { [legacyPath]: sourceBytes, [canonicalPath]: "author-reviewed replacement\n" },
  }));
  assert.equal(conflict.operations.length, 0);
  assert.equal(conflict.entries[0]?.disposition, "conflict");
});

test("semantic reactivation leaves disabled-module legacy data unreadable", async () => {
  const result = await createSemanticMigrationProducer().inspect(contextFor({
    targets: { [legacyPath]: '{"candidateId":"dismissed","timestamp":"2025-03-01"}\n' },
    enabled: false,
  }));
  assert.deepEqual(result, { entries: [], operations: [], recovery: [] });
});
