import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationContext } from "@scriptorium/migration";
import { createAssistantMigrationProducer } from "./migration.js";

const repository = {
  provider: "local" as const,
  repositoryId: "assistant-migration-test",
  defaultBranch: "main",
  ownerScope: "test-owner",
  url: "file:///legacy/assistant",
};
const snapshot = { repository, remoteCommit: "b".repeat(40) };
const settingsSourcePath = ".arcadia/llm-model-settings.json";
const usageSourcePath = ".arcadia/llm-usage.jsonl";
const settingsLegacyPath = "meta/scriptorium/modules/assistant/legacy/files/.arcadia/llm-model-settings.json";
const usageLegacyPath = "meta/scriptorium/modules/assistant/legacy/files/.arcadia/llm-usage.jsonl";
const settingsTargetPath = "meta/scriptorium/modules/assistant/model-settings.json";
const usageTargetPath = "meta/scriptorium/modules/assistant/usage.jsonl";
const revision = "a".repeat(64);

function contextFor(input: {
  sources?: Record<string, string>;
  targets?: Record<string, string>;
  enabled?: boolean;
}): MigrationContext {
  const targets = new Map(Object.entries(input.targets ?? {}));
  return {
    source: {
      projectRoot: "/legacy/assistant",
      async readProjectFile(path) {
        const content = input.sources?.[path];
        return content === undefined ? null : Buffer.from(content);
      },
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
    enabledModules: new Set(input.enabled === false ? [] : ["assistant"]),
  };
}

test("Assistant reactivation restores exact settings and usage bytes, including unknown fields", async () => {
  const settings = '{\n  "defaultPresetId": "author-choice",\n  "presets": [],\n  "futureSetting": {"retained": true}\n}\n';
  const usage = '{"ts":"2025-10-01T00:00:00.000Z","feature":"scene-summary","model":"local-model-id","promptVersion":"scene-summary-v1","inputTokens":12,"outputTokens":7,"cacheHit":false,"durationMs":345,"aborted":false,"queueWaitMs":19,"futureUsageField":{"kept":true}}\n';
  const result = await createAssistantMigrationProducer().inspect(contextFor({
    targets: { [settingsLegacyPath]: settings, [usageLegacyPath]: usage },
  }));

  assert.deepEqual(result.entries.map(({ source, target, category, disposition }) => ({ source, target, category, disposition })), [
    { source: settingsLegacyPath, target: settingsTargetPath, category: "authoritative", disposition: "planned" },
    { source: usageLegacyPath, target: usageTargetPath, category: "authoritative", disposition: "planned" },
  ]);
  assert.equal(result.operations.length, 2);
  assert.deepEqual(result.operations.map((operation) => operation.writes[0]?.content), [settings, usage]);
  assert.deepEqual(result.operations.map((operation) => operation.writes[0]?.path), [settingsTargetPath, usageTargetPath]);
  for (const operation of result.operations) {
    assert.equal(operation.effect, "migration");
    assert.equal(operation.reads[0]?.revision, null);
    assert.equal(operation.writes[0]?.revision, null);
  }
});

test("Assistant reactivation reports matching files and withholds conflicts", async () => {
  const settings = '{"defaultPresetId":"author-choice","presets":[]}\n';
  const usage = '{"ts":"2025-10-01T00:00:00.000Z","feature":"rewrite","future":true}\n';
  const matching = await createAssistantMigrationProducer().inspect(contextFor({
    targets: { [settingsLegacyPath]: settings, [settingsTargetPath]: settings, [usageLegacyPath]: usage, [usageTargetPath]: usage },
  }));
  assert.deepEqual(matching.entries.map((entry) => entry.disposition), ["unchanged", "unchanged"]);
  assert.equal(matching.operations.length, 0);

  const conflict = await createAssistantMigrationProducer().inspect(contextFor({
    targets: {
      [settingsLegacyPath]: settings,
      [settingsTargetPath]: settings,
      [usageLegacyPath]: usage,
      [usageTargetPath]: "{\"ts\":\"2025-10-02T00:00:00.000Z\",\"feature\":\"rewrite\"}\n",
    },
  }));
  assert.deepEqual(conflict.entries.map((entry) => entry.disposition), ["unchanged", "conflict"]);
  assert.equal(conflict.operations.length, 0);
});

test("Assistant reactivation defers when disabled, absent, or still owned by the source importer", async () => {
  const producer = createAssistantMigrationProducer();
  const legacySettings = '{"defaultPresetId":"author-choice"}\n';
  const legacyUsage = '{"ts":"2025-10-01T00:00:00.000Z","feature":"rewrite"}\n';

  assert.deepEqual(await producer.inspect(contextFor({
    enabled: false,
    targets: { [settingsLegacyPath]: legacySettings, [usageLegacyPath]: legacyUsage },
  })), {
    entries: [], operations: [], recovery: [],
  });
  assert.deepEqual(await producer.inspect(contextFor({})), {
    entries: [], operations: [], recovery: [],
  });
  assert.deepEqual(await producer.inspect(contextFor({
    sources: { [settingsSourcePath]: legacySettings, [usageSourcePath]: legacyUsage },
    targets: { [settingsLegacyPath]: "older-value", [usageLegacyPath]: "older-value" },
  })), {
    entries: [], operations: [], recovery: [],
  });
});
