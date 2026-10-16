import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { CoreStore } from "../../core/dist/index.js";
import {
  createMigrationProducerRegistry,
  inspectLegacyProject,
  proposeMigrationImport,
  registerMigrationProducer,
} from "../dist/index.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

async function writeFile(root, relativePath, value) {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, value);
}

async function treeState(root) {
  const state = [];
  const visit = async (directory) => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await fs.lstat(absolute, { bigint: true });
      const entry = {
        path: relative,
        type: child.isDirectory() ? "directory" : child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other",
        mode: info.mode.toString(),
        size: info.size.toString(),
        mtimeNs: info.mtimeNs.toString(),
      };
      if (child.isDirectory()) {
        state.push(entry);
        await visit(absolute);
      } else if (child.isSymbolicLink()) {
        state.push({ ...entry, link: await fs.readlink(absolute) });
      } else if (child.isFile()) {
        state.push({ ...entry, hash: hash(await fs.readFile(absolute)) });
      } else state.push(entry);
    }
  };
  await visit(root);
  return state;
}

async function makeLegacyRepository(root) {
  const seed = path.join(root, "seed");
  const remote = path.join(root, "legacy-remote.git");
  const sourceRoot = path.join(root, "legacy-project");
  await fs.mkdir(seed, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
  git(seed, "config", "user.name", "Synthetic Author");
  git(seed, "config", "user.email", "author@example.invalid");
  await writeFile(seed, ".gitignore", ".arcadia/\n");
  await writeFile(seed, "meta/project.yaml", "id: legacy-project\ntitle: Synthetic Work\nextension: preserve-this\n");
  await writeFile(seed, "story/scene.md", "published scene\n");
  await writeFile(seed, "notes/delete-me.md", "old note to remove\n");
  await writeFile(seed, "docs/typechange-target.txt", "symlink payload\n");
  await fs.symlink("typechange-target.txt", path.join(seed, "docs/typechange.md"));
  git(seed, "add", ".");
  git(seed, "commit", "-m", "synthetic legacy baseline");

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--set-upstream", "origin", "main");
  execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, sourceRoot], { stdio: "ignore" });
  git(sourceRoot, "config", "user.name", "Synthetic Author");
  git(sourceRoot, "config", "user.email", "author@example.invalid");

  await writeFile(sourceRoot, "notes/from-local-commit.md", "preserve committed local work\n");
  git(sourceRoot, "add", "notes/from-local-commit.md");
  git(sourceRoot, "commit", "-m", "unpublished author work");
  await writeFile(sourceRoot, "story/scene.md", "staged final author version\n");
  git(sourceRoot, "add", "story/scene.md");
  await writeFile(sourceRoot, "notes/staged-add.md", "staged addition\n");
  git(sourceRoot, "add", "notes/staged-add.md");
  await fs.unlink(path.join(sourceRoot, "docs/typechange.md"));
  await writeFile(sourceRoot, "docs/typechange.md", "regular file replacing legacy symlink\n");
  git(sourceRoot, "add", "docs/typechange.md");
  await fs.unlink(path.join(sourceRoot, "notes/delete-me.md"));
  git(sourceRoot, "add", "-u", "notes/delete-me.md");

  // These are synthetic path-only credential markers. They must be excluded before the
  // migration reader reads their bytes and must never reach the proposal or target.
  await writeFile(sourceRoot, ".npmrc", "DO_NOT_EXPORT_SYNTHETIC_NPM_SECRET\n");
  await writeFile(sourceRoot, ".ssh/id_ed25519", "DO_NOT_EXPORT_SYNTHETIC_SSH_SECRET\n");
  await writeFile(sourceRoot, "notes/story-clue.md", "The word secret is part of this fictional clue.\n");
  return { remote, sourceRoot };
}

function insertStateProposal(database, { id, status, subject, token }) {
  database.prepare(`INSERT INTO state_proposals (
    id, scene_id, event_json, manuscript_hash, status, conflict_event_ids_json,
    duplicate_of_proposal_id, history_json, created_at, updated_at, api_token
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, "scene-legacy", JSON.stringify({ kind: "move", subject, object: "library" }), "source-hash",
      status, "[]", null, "[{\"action\":\"created\"}]", "2025-01-01T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z", token);
}

function insertSuggestion(database, { id, status, text }) {
  database.prepare(`INSERT INTO zukan_suggestions (
    id, entity_id, block_path, proposed_text, evidence_json, status, source,
    kind, source_session_id, source_turn_range_json, confidence, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, "character-legacy", "facts/0", text, "[{\"quote\":\"author evidence\"}]", status,
      "manuscript", "fact", null, null, "high", "2025-02-01T00:00:00.000Z", "2025-02-02T00:00:00.000Z");
}

function createLegacyDatabase(file, rows) {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  database.exec(`
    CREATE TABLE state_proposals (
      id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, event_json TEXT NOT NULL,
      manuscript_hash TEXT NOT NULL, status TEXT NOT NULL, conflict_event_ids_json TEXT NOT NULL,
      duplicate_of_proposal_id TEXT, history_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, api_token TEXT
    );
    CREATE TABLE zukan_suggestions (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, block_path TEXT NOT NULL,
      proposed_text TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, kind TEXT, source_session_id TEXT, source_turn_range_json TEXT,
      confidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE entities (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE scene_state_events (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE reader_knowledge_events (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE private_tokens (id TEXT, token_value TEXT);
  `);
  for (const row of rows.state ?? []) insertStateProposal(database, row);
  for (const row of rows.suggestions ?? []) insertSuggestion(database, row);
  database.prepare("INSERT INTO entities VALUES (?, ?)").run("derived-entity", "DO_NOT_PUBLISH_DERIVED_ENTITY");
  database.prepare("INSERT INTO scene_state_events VALUES (?, ?)").run("derived-state", "DO_NOT_PUBLISH_SCENE_EVENT");
  database.prepare("INSERT INTO reader_knowledge_events VALUES (?, ?)").run("derived-knowledge", "DO_NOT_PUBLISH_KNOWLEDGE_EVENT");
  database.prepare("INSERT INTO private_tokens VALUES (?, ?)").run("credential-row", "DO_NOT_EXPORT_SQLITE_SECRET");
  return database;
}

async function addLegacyProjectState(sourceRoot, workspaceRoot) {
  const projectDatabasePath = path.join(sourceRoot, ".arcadia", "index.sqlite");
  await fs.mkdir(path.dirname(projectDatabasePath), { recursive: true });
  const projectDatabase = createLegacyDatabase(projectDatabasePath, {
    state: [
      { id: "state-approved-project", status: "approved", subject: "project-version", token: "DO_NOT_EXPORT_SQLITE_SECRET" },
      { id: "state-conflict", status: "approved", subject: "project-version", token: null },
      { id: "state-pending-project", status: "proposed", subject: "pending-project", token: null },
    ],
    suggestions: [
      { id: "zukan-approved-project", status: "approved", text: "preserved approved project fact" },
    ],
  });

  const workspaceDatabasePath = path.join(workspaceRoot, "index", path.basename(sourceRoot), "index.sqlite");
  await fs.mkdir(path.dirname(workspaceDatabasePath), { recursive: true });
  const workspaceDatabase = createLegacyDatabase(workspaceDatabasePath, {
    state: [
      { id: "state-approved-workspace", status: "rejected", subject: "workspace-version", token: null },
      { id: "state-conflict", status: "approved", subject: "workspace-version", token: null },
    ],
    suggestions: [
      { id: "zukan-approved-workspace", status: "rejected", text: "preserved rejected workspace fact" },
      { id: "zukan-pending-workspace", status: "pending", text: "local review only" },
    ],
  });
  return [projectDatabase, workspaceDatabase];
}

async function addLegacyFiles(sourceRoot, workspaceRoot) {
  const exactFiles = new Map([
    ["meta/speaker-corrections.jsonl", "{\"id\":\"speaker-correction-stable\",\"speakerId\":\"speaker-1\",\"label\":\"Mika\",\"unknownExtension\":{\"keep\":true}}\n"],
    ["meta/speaker-model.json", "{\"version\":1,\"featureNames\":[\"manual\"],\"weights\":[0.5],\"bias\":0,\"extension\":\"retain\"}\n"],
    ["meta/synonyms.yaml", "groups:\n  - canonical: lantern\n    variants: [lamp, light]\nlegacy-extension: preserve\n"],
    ["meta/candidate-ignore-list.yaml", "terms:\n  - keep-out\nunknown-field: preserve\n"],
    ["meta/contradiction-dismissals.jsonl", "{\"id\":\"dismissal-stable\",\"candidateId\":\"candidate-1\",\"reason\":\"author reviewed\"}\n"],
    ["meta/publish-episodes.yaml", "episodes:\n  - id: episode-stable\n    scenes: [scene-legacy]\nunknown-field: preserve\n"],
    [".arcadia/llm-model-settings.json", "{\"defaultPresetId\":\"small-local\",\"presets\":[{\"id\":\"small-local\",\"model\":\"local/tiny\"}],\"extension\":{\"keep\":true}}\n"],
    [".arcadia/nlp-feature-settings.json", "{\"enabledFeatures\":[],\"privacy\":\"local-only\",\"extension\":7}\n"],
    [".arcadia/llm-usage.jsonl", "{\"id\":\"usage-stable\",\"model\":\"local/tiny\",\"tokens\":3}\n"],
    [".arcadia/change-sets/applied.json", "{\"changeSet\":{\"id\":\"applied-changeset-stable\"},\"status\":\"applied\",\"unknownField\":{\"keep\":true}}\n"],
    [".arcadia/snapshots/scene-before.md", "---\nauthor_note: preserve\n---\nScratch snapshot\n"],
    [".arcadia/llm-cache/summary.json", "{\"derived\":true}\n"],
  ]);
  for (const [relativePath, content] of exactFiles) await writeFile(sourceRoot, relativePath, content);
  const cover = Buffer.from([0, 255, 3, 10, 13, 128, 42]);
  const attachment = Buffer.from([1, 2, 0, 254, 255, 9]);
  await writeFile(sourceRoot, ".arcadia/cover.jpg", cover);
  await writeFile(sourceRoot, ".arcadia/snapshots/attachments/diagram.bin", attachment);

  const selectedGrant = {
    id: "share-grant-stable",
    ownerId: "synthetic-private-owner",
    projectId: "legacy-project-id",
    scope: "episode-1",
    label: "Reader access",
    tokenHash: "b".repeat(64),
    tokenPrefix: "DO_NOT_EXPORT_BEARER_PREFIX",
    bearerToken: "DO_NOT_EXPORT_BEARER_VALUE",
    createdAt: "2025-03-01T00:00:00.000Z",
    expiresAt: "2026-03-01T00:00:00.000Z",
  };
  const unrelatedGrant = { ...selectedGrant, id: "unrelated-grant", projectId: "different-legacy-project" };
  await writeFile(workspaceRoot, "app-state/share-tokens.json", JSON.stringify([selectedGrant, unrelatedGrant]) + "\n");
  await writeFile(workspaceRoot, "app-state/projects.json", JSON.stringify([{ id: "legacy-project-id", url: "https://example.invalid/owner/work.git" }]) + "\n");
  await writeFile(workspaceRoot, "app-state/users.json", "DO_NOT_EXPORT_WORKSPACE_USER_SECRET\n");
}

function readOperationWrites(inspection) {
  return inspection.operations.flatMap((operation) => operation.writes);
}

test("legacy import survives author-approved publication and complete Core dataDir replacement", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-import-recovery-"));
  const workspaceRoot = path.join(tempRoot, "legacy-data");
  const targetDataDir = path.join(tempRoot, "core-data");
  const databases = [];
  try {
    const { remote, sourceRoot } = await makeLegacyRepository(tempRoot);
    const projectDatabases = await addLegacyProjectState(sourceRoot, workspaceRoot);
    databases.push(...projectDatabases);
    await addLegacyFiles(sourceRoot, workspaceRoot);

    const sourceBefore = await treeState(sourceRoot);
    const workspaceBefore = await treeState(workspaceRoot);
    const core = new CoreStore({ dataDir: targetDataDir, allowLocalRemotes: true });
    const project = await core.registerProject({ url: remote });
    const reader = await core.reader(project.id);
    const targetIdentity = reader.snapshot.repository;
    const inputMapping = { "legacy-project-id": targetIdentity };
    let producerMapping;
    const registry = createMigrationProducerRegistry();
    registerMigrationProducer(registry, {
      id: "mapping-contract-probe",
      async inspect(context) {
        producerMapping = context.legacyRepositoryMappings;
        return { entries: [], operations: [], recovery: [] };
      },
    });
    const inspect = () => inspectLegacyProject({
      sourceRoot,
      workspaceDataRoot: workspaceRoot,
      workspaceProjectId: "legacy-project-id",
      legacyRepositoryMappings: inputMapping,
      target: reader,
      registry,
    });

    const inspection = await inspect();
    assert.equal(inspection.pendingWorkspace.pendingCommitCount, 1, "the unpublished local commit must be detected");
    assert.ok(inspection.pendingWorkspace.stagedPaths.includes("notes/staged-add.md"), "staged additions must be reported");
    assert.ok(inspection.pendingWorkspace.stagedPaths.includes("docs/typechange.md"), "staged type changes must be reported");
    assert.equal(producerMapping["legacy-project-id"].repositoryId, targetIdentity.repositoryId);
    assert.notEqual(producerMapping, inputMapping, "the producer receives a defensive mapping copy");
    assert.notEqual(producerMapping["legacy-project-id"], inputMapping["legacy-project-id"], "repository identities are copied too");

    const writes = readOperationWrites(inspection);
    const writeByPath = new Map(writes.map((write) => [write.path, write]));
    for (const targetPath of [
      "meta/scriptorium/modules/speaker/corrections.jsonl",
      "meta/scriptorium/modules/speaker/adopted-model.json",
      "meta/scriptorium/modules/nlp/synonyms.yaml",
      "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml",
      "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl",
      "meta/scriptorium/modules/publishing/episodes.yaml",
      "meta/scriptorium/modules/publishing/assets/cover.jpg",
      "meta/scriptorium/modules/assistant/model-settings.json",
      "meta/scriptorium/modules/assistant/usage.jsonl",
      "meta/scriptorium/modules/story/change-sets/applied.json",
      "meta/scriptorium/modules/story/local-snapshots/scene-before.md",
      "meta/scriptorium/modules/story/local-snapshots/attachments/diagram.bin",
      "meta/scriptorium/modules/story/state-proposals.jsonl",
      "meta/scriptorium/modules/story/zukan-suggestions.jsonl",
      "meta/scriptorium/modules/publishing/share-grants.jsonl",
      "notes/from-local-commit.md",
      "story/scene.md",
      "notes/staged-add.md",
      "notes/story-clue.md",
    ]) assert.ok(writeByPath.has(targetPath), `expected reviewable import write for ${targetPath}`);
    const typeChange = inspection.entries.find((entry) => entry.source === "docs/typechange.md");
    assert.equal(typeChange?.disposition, "blocked", "Core must withhold a symlink replacement it cannot safely read");
    assert.equal(writeByPath.get("notes/delete-me.md").content, null, "the staged deletion must be preserved");
    assert.ok(["meta/scriptorium/modules/publishing/assets/cover.jpg", "meta/scriptorium/modules/story/local-snapshots/attachments/diagram.bin"]
      .every((targetPath) => writeByPath.get(targetPath).encoding === "base64"), "binary assets must retain base64 encoding");

    for (const sourcePath of [
      ".arcadia/index.sqlite#entities",
      ".arcadia/index.sqlite#scene_state_events",
      ".arcadia/index.sqlite#reader_knowledge_events",
      "app-state/users.json",
    ]) {
      const entry = inspection.entries.find((item) => item.source === sourcePath);
      assert.ok(entry, `expected a classified report entry for ${sourcePath}`);
      assert.ok(["rebuild", "excluded"].includes(entry.disposition), `unexpected durable import for ${sourcePath}`);
    }
    assert.ok(inspection.entries.some((entry) => entry.source.includes("#state_proposals") && entry.category === "provisional" && entry.disposition === "deferred"));
    assert.ok(inspection.entries.some((entry) => entry.source.includes("state-conflict") && entry.disposition === "conflict"));
    assert.ok(inspection.recovery.some((record) => record.source.includes("state-pending-project")));
    assert.ok(!inspection.operations.some((operation) => operation.writes.some((write) => /entities|scene_state_events|reader_knowledge_events/u.test(write.path))));
    const proposalRows = writeByPath.get("meta/scriptorium/modules/story/state-proposals.jsonl").content;
    assert.ok(proposalRows.includes("state-approved-project"));
    assert.ok(proposalRows.includes("state-approved-workspace"));
    assert.ok(!proposalRows.includes("state-conflict"), "divergent rows must remain separate for review");
    assert.ok(!proposalRows.includes("state-pending-project"), "unaccepted proposals must not be promoted to canonical decisions");
    assert.ok(!proposalRows.includes("api_token"));
    assert.ok(!JSON.stringify(inspection).includes("DO_NOT_EXPORT_"), "synthetic credential/derived sentinels must not enter inspection output");

    const repeatedPlan = await inspect();
    assert.deepEqual(repeatedPlan.operations.map((operation) => operation.id), inspection.operations.map((operation) => operation.id),
      "operation identities must be deterministic for the same target snapshot and source state");
    assert.deepEqual(await treeState(sourceRoot), sourceBefore, "inspection must leave every source repository byte and metadata unchanged");
    assert.deepEqual(await treeState(workspaceRoot), workspaceBefore, "inspection must leave workspace stores, including SQLite sidecars, unchanged");

    const proposal = await proposeMigrationImport(core, project.id, inspection);
    await core.approve(project.id, {
      proposalId: proposal.id,
      operationIds: proposal.operations.map((operation) => operation.id),
      authorScope: "synthetic-author",
    });
    for (const operation of proposal.operations) await core.checkpoint(project.id, operation);
    const publication = await core.publish(project.id, "legacy-import-recovery");
    assert.equal(publication.state, "confirmed", "the actual bare remote must acknowledge publication");
    assert.ok(publication.remoteCommit);

    await fs.rm(targetDataDir, { recursive: true, force: true });
    const replacement = new CoreStore({ dataDir: targetDataDir, allowLocalRemotes: true });
    const restoredProject = await replacement.registerProject({ url: remote });
    const restoredReader = await replacement.reader(restoredProject.id);
    for (const write of writes) {
      const recovered = await restoredReader.read(write.path, write.encoding ?? "utf8");
      if (write.content === null) assert.equal(recovered, null, `deleted path ${write.path} must stay deleted`);
      else assert.equal(recovered?.content, write.content, `published bytes must survive target dataDir replacement at ${write.path}`);
    }

    const grants = await restoredReader.read("meta/scriptorium/modules/publishing/share-grants.jsonl");
    const grant = JSON.parse(grants.content.trim());
    assert.equal(grant.id, "share-grant-stable");
    assert.equal(grant.projectId, targetIdentity.repositoryId);
    assert.equal(grant.tokenHash, "b".repeat(64));
    assert.ok(!grants.content.includes("synthetic-private-owner"));
    assert.ok(!grants.content.includes("DO_NOT_EXPORT_BEARER"));

    const restoredStateRows = (await restoredReader.read("meta/scriptorium/modules/story/state-proposals.jsonl")).content;
    assert.deepEqual(
      restoredStateRows.trim().split("\n").map((line) => JSON.parse(line).id).sort(),
      ["state-approved-project", "state-approved-workspace"],
      "stable approved decision IDs must survive the real Git publication and fresh clone",
    );
    const conflicts = await restoredReader.list("meta/scriptorium/modules/story/legacy/sqlite-conflicts/state_proposals/");
    assert.equal(conflicts.length, 2, "both divergent legacy records must survive for author review");
    const allTargetPaths = await restoredReader.list("");
    assert.ok(!allTargetPaths.some((filePath) => filePath === ".npmrc" || filePath.endsWith("/.ssh/id_ed25519")));
    assert.ok(!allTargetPaths.some((filePath) => /scene_state_events|reader_knowledge_events/u.test(filePath)));
    const exactFileMappings = [
      ["meta/speaker-corrections.jsonl", "meta/scriptorium/modules/speaker/corrections.jsonl"],
      ["meta/speaker-model.json", "meta/scriptorium/modules/speaker/adopted-model.json"],
      ["meta/synonyms.yaml", "meta/scriptorium/modules/nlp/synonyms.yaml"],
      ["meta/candidate-ignore-list.yaml", "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml"],
      ["meta/contradiction-dismissals.jsonl", "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl"],
      ["meta/publish-episodes.yaml", "meta/scriptorium/modules/publishing/episodes.yaml"],
      [".arcadia/llm-model-settings.json", "meta/scriptorium/modules/assistant/model-settings.json"],
      [".arcadia/nlp-feature-settings.json", "meta/scriptorium/modules/nlp/feature-settings.json"],
      [".arcadia/llm-usage.jsonl", "meta/scriptorium/modules/assistant/usage.jsonl"],
      [".arcadia/change-sets/applied.json", "meta/scriptorium/modules/story/change-sets/applied.json"],
      [".arcadia/snapshots/scene-before.md", "meta/scriptorium/modules/story/local-snapshots/scene-before.md"],
      [".arcadia/cover.jpg", "meta/scriptorium/modules/publishing/assets/cover.jpg"],
      [".arcadia/snapshots/attachments/diagram.bin", "meta/scriptorium/modules/story/local-snapshots/attachments/diagram.bin"],
    ];
    for (const [sourcePath, targetPath] of exactFileMappings) {
      const sourceBytes = await fs.readFile(path.join(sourceRoot, sourcePath));
      const encoding = /\.(?:jpg|bin)$/u.test(sourcePath) ? "base64" : "utf8";
      const recovered = await restoredReader.read(targetPath, encoding);
      const expected = encoding === "base64" ? sourceBytes.toString("base64") : sourceBytes.toString("utf8");
      assert.equal(recovered?.content, expected, `legacy bytes and unknown fields must be preserved at ${targetPath}`);
    }

    const afterRecovery = await inspectLegacyProject({
      sourceRoot,
      workspaceDataRoot: workspaceRoot,
      workspaceProjectId: "legacy-project-id",
      legacyRepositoryMappings: inputMapping,
      target: restoredReader,
      registry,
    });
    assert.deepEqual(afterRecovery.operations, [], "a completed import must be idempotent after deleting all local Core state");
    assert.deepEqual(await treeState(sourceRoot), sourceBefore, "the source Git repository remains untouched after import and recovery");
    assert.deepEqual(await treeState(workspaceRoot), workspaceBefore, "the source workspace and SQLite stores remain untouched after import and recovery");
  } finally {
    for (const database of databases) database.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
