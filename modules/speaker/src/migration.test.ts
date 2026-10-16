import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationContext } from "@scriptorium/migration";
import { createSpeakerMigrationProducer } from "./migration.js";

const repository = {
  provider: "local" as const,
  repositoryId: "speaker-reactivation-test",
  defaultBranch: "main",
  ownerScope: "test-owner",
  url: "file:///legacy/speaker",
};
const snapshot = { repository, remoteCommit: "b".repeat(40) };
const fileCases = [
  {
    source: "meta/speaker-corrections.jsonl",
    legacy: "meta/scriptorium/modules/speaker/legacy/files/meta/speaker-corrections.jsonl",
    canonical: "meta/scriptorium/modules/speaker/corrections.jsonl",
  },
  {
    source: "meta/speaker-model.json",
    legacy: "meta/scriptorium/modules/speaker/legacy/files/meta/speaker-model.json",
    canonical: "meta/scriptorium/modules/speaker/adopted-model.json",
  },
] as const;

function contextFor(input: {
  source?: Record<string, string>;
  targets?: Record<string, string>;
  enabled?: boolean;
  onSourceRead?: (path: string) => void;
}): MigrationContext {
  const targets = new Map(Object.entries(input.targets ?? {}));
  return {
    source: {
      projectRoot: "/legacy/speaker",
      async readProjectFile(path) {
        input.onSourceRead?.(path);
        const content = input.source?.[path];
        return content === undefined ? null : Buffer.from(content, "utf8");
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
        return content === undefined ? null : { content, revision: "a".repeat(64) };
      },
      async list(prefix) { return [...targets.keys()].filter((path) => path.startsWith(`${prefix}/`)).sort(); },
    },
    repository,
    snapshot,
    enabledModules: new Set(input.enabled === false ? [] : ["speaker"]),
  };
}

test("speaker reactivation restores retained corrections and model bytes with stable absent-only proposals", async () => {
  const correctionBytes = '{"dialogueText":"future fields survive","speakerEntityId":null}\nopaque correction line\n';
  const modelBytes = '{"version":1,"weights":[0.5,-0.5],"future":true}\n';
  const targets = Object.fromEntries([
    [fileCases[0].legacy, correctionBytes],
    [fileCases[1].legacy, modelBytes],
  ]);
  const producer = createSpeakerMigrationProducer();
  const first = await producer.inspect(contextFor({ targets }));
  const second = await producer.inspect(contextFor({ targets }));

  assert.deepEqual(first.entries.map((entry) => entry.disposition), ["planned", "planned"]);
  assert.deepEqual(first.entries.map((entry) => [entry.source, entry.target, entry.category]), fileCases.map((file) => [file.legacy, file.canonical, "authoritative"]));
  assert.deepEqual(first.operations.map((operation) => operation.id), second.operations.map((operation) => operation.id));
  assert.deepEqual(first.operations.map((operation) => operation.writes[0]?.content), [correctionBytes, modelBytes]);
  assert.deepEqual(first.operations.map((operation) => operation.reads), fileCases.map((file) => [{ path: file.canonical, revision: null }]));
  assert.ok(first.operations.every((operation) => operation.effect === "migration"));
});

test("speaker reactivation reports unchanged and conflicting canonical files without overwriting", async () => {
  const correctionBytes = '{"canonical":"same"}\n';
  const modelBytes = '{"canonical":"different"}\n';
  const result = await createSpeakerMigrationProducer().inspect(contextFor({
    targets: {
      [fileCases[0].legacy]: correctionBytes,
      [fileCases[0].canonical]: correctionBytes,
      [fileCases[1].legacy]: '{"retained":"model"}\n',
      [fileCases[1].canonical]: modelBytes,
    },
  }));
  assert.deepEqual(result.entries.map((entry) => entry.disposition), ["unchanged", "conflict"]);
  assert.equal(result.operations.length, 0);
});

test("speaker reactivation defers to generic import while source files remain and does nothing while disabled", async () => {
  const retained = Object.fromEntries(fileCases.map((file) => [file.legacy, "preserved bytes\n"]));
  const source = Object.fromEntries(fileCases.map((file) => [file.source, "source bytes\n"]));
  const presentSource = await createSpeakerMigrationProducer().inspect(contextFor({ source, targets: retained }));
  assert.deepEqual(presentSource, { entries: [], operations: [], recovery: [] });

  let sourceReads = 0;
  const disabled = await createSpeakerMigrationProducer().inspect(contextFor({
    targets: retained,
    enabled: false,
    onSourceRead() { sourceReads += 1; },
  }));
  assert.deepEqual(disabled, { entries: [], operations: [], recovery: [] });
  assert.equal(sourceReads, 0, "disabled speaker data is not inspected for reactivation");
});
