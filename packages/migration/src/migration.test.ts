import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ChangeOperation, RepositoryIdentity, SnapshotId, SnapshotReader } from "@scriptorium/contracts";
import { assertChangeOperation } from "@scriptorium/contracts";
import { createLegacySourceReader, inspectLegacyProject, isSecretLegacyPath, proposeMigrationImport } from "./index.js";

const repository: RepositoryIdentity = {
  provider: "local",
  repositoryId: "new-project",
  defaultBranch: "main",
  ownerScope: "migration-test",
  url: "file:///migration-test/new-project",
};
const snapshot: SnapshotId = { repository, remoteCommit: "a".repeat(40) };

type TargetFiles = Map<string, { content: string; revision: string }>;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function targetReader(files: TargetFiles): SnapshotReader {
  return {
    snapshot,
    async read(filePath) {
      return files.get(filePath) ?? null;
    },
    async list(prefix) {
      return [...files.keys()].filter((filePath) => filePath.startsWith(prefix)).sort();
    },
  };
}

function applyOperations(files: TargetFiles, operations: ChangeOperation[]): void {
  for (const operation of operations) {
    assertChangeOperation(operation);
    for (const write of operation.writes) {
      if (write.content === null) files.delete(write.path);
      else files.set(write.path, { content: write.content, revision: digest(write.content) });
    }
  }
}

async function writeFile(root: string, relativePath: string, value: string | Buffer): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

function runGit(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function insertProposal(db: DatabaseSync, row: {
  id: string;
  scene_id: string;
  event_json: string;
  manuscript_hash: string;
  status: string;
  conflict_event_ids_json: string;
  duplicate_of_proposal_id: string | null;
  history_json: string;
  created_at: string;
  updated_at: string;
}): void {
  db.prepare(`INSERT INTO state_proposals (
    id, scene_id, event_json, manuscript_hash, status, conflict_event_ids_json,
    duplicate_of_proposal_id, history_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.scene_id, row.event_json, row.manuscript_hash, row.status,
      row.conflict_event_ids_json, row.duplicate_of_proposal_id, row.history_json, row.created_at, row.updated_at);
}

function proposalRow(id: string, status: string, eventJson = '{"kind":"move","subject":"A","object":"B"}') {
  return {
    id,
    scene_id: "scene-1",
    event_json: eventJson,
    manuscript_hash: "manuscript-hash-1",
    status,
    conflict_event_ids_json: "[]",
    duplicate_of_proposal_id: null,
    history_json: JSON.stringify([{ action: "created", at: "2025-01-01T00:00:00.000Z" }]),
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-02T00:00:00.000Z",
  };
}

function insertSuggestion(db: DatabaseSync, row: {
  id: string;
  entity_id: string;
  block_path: string;
  proposed_text: string;
  evidence_json: string;
  status: string;
  source: string;
  kind: string | null;
  source_session_id: string | null;
  source_turn_range_json: string | null;
  confidence: string | null;
  created_at: string;
  updated_at: string;
}): void {
  db.prepare(`INSERT INTO zukan_suggestions (
    id, entity_id, block_path, proposed_text, evidence_json, status, source, kind,
    source_session_id, source_turn_range_json, confidence, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.entity_id, row.block_path, row.proposed_text, row.evidence_json,
      row.status, row.source, row.kind, row.source_session_id, row.source_turn_range_json,
      row.confidence, row.created_at, row.updated_at);
}

function suggestionRow(id: string, status: string, proposedText = "A new fact") {
  return {
    id,
    entity_id: "entity-1",
    block_path: "facts/0",
    proposed_text: proposedText,
    evidence_json: '[{"quote":"source sentence","sceneId":"scene-1"}]',
    status,
    source: "manuscript",
    kind: "fact",
    source_session_id: null,
    source_turn_range_json: null,
    confidence: "high",
    created_at: "2025-02-01T00:00:00.000Z",
    updated_at: "2025-02-02T00:00:00.000Z",
  };
}

function schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE state_proposals (
      id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, event_json TEXT NOT NULL,
      manuscript_hash TEXT NOT NULL, status TEXT NOT NULL,
      conflict_event_ids_json TEXT NOT NULL, duplicate_of_proposal_id TEXT,
      history_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      vendor_extension TEXT
    );
    CREATE INDEX idx_state_proposals_scene_status ON state_proposals(scene_id, status, created_at);
    CREATE TABLE zukan_suggestions (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, block_path TEXT NOT NULL,
      proposed_text TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, kind TEXT, source_session_id TEXT,
      source_turn_range_json TEXT, confidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      plugin_payload TEXT
    );
    CREATE INDEX idx_zukan_suggestions_status ON zukan_suggestions(status, created_at);
    CREATE TABLE scene_state_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  `);
}

async function createDatabaseFixtures(sourceRoot: string, workspaceRoot: string): Promise<DatabaseSync[]> {
  const projectPath = path.join(sourceRoot, ".arcadia", "index.sqlite");
  const projectDb = new DatabaseSync(projectPath);
  projectDb.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  schema(projectDb);
  insertProposal(projectDb, proposalRow("project-approved", "approved"));
  insertProposal(projectDb, proposalRow("identical-proposal", "approved"));
  insertProposal(projectDb, proposalRow("shared-conflict", "approved", '{"kind":"move","subject":"left"}'));
  insertProposal(projectDb, proposalRow("project-pending", "proposed"));
  insertSuggestion(projectDb, suggestionRow("zukan-project-approved", "approved"));
  insertSuggestion(projectDb, suggestionRow("identical-suggestion", "rejected"));
  insertSuggestion(projectDb, suggestionRow("zukan-conflict", "approved", "Project version"));
  insertSuggestion(projectDb, suggestionRow("zukan-pending", "pending"));
  projectDb.exec("ALTER TABLE state_proposals ADD COLUMN api_token TEXT;");
  projectDb.exec("UPDATE state_proposals SET api_token = 'DO_NOT_EXPORT_SQLITE_SECRET_SENTINEL';");
  projectDb.exec("UPDATE state_proposals SET vendor_extension = 'preserve-unknown-state-field'; UPDATE zukan_suggestions SET plugin_payload = 'preserve-unknown-suggestion-field';");
  projectDb.exec(`CREATE TABLE private_tokens (id TEXT, token_value TEXT); INSERT INTO private_tokens VALUES ('secret-id', 'DO_NOT_EXPORT_TOKEN_SENTINEL');`);
  projectDb.exec(`CREATE TABLE unknown_plugin_state (id TEXT, payload TEXT); INSERT INTO unknown_plugin_state VALUES ('unknown-1', 'leave-unclassified');`);
  projectDb.exec("INSERT INTO scene_state_events VALUES ('derived-1', 'rebuild-me');");

  const externalPath = path.join(workspaceRoot, "index", path.basename(sourceRoot), "index.sqlite");
  await fs.mkdir(path.dirname(externalPath), { recursive: true });
  const externalDb = new DatabaseSync(externalPath);
  schema(externalDb);
  insertProposal(externalDb, proposalRow("external-approved", "rejected"));
  insertProposal(externalDb, proposalRow("identical-proposal", "approved"));
  insertProposal(externalDb, proposalRow("shared-conflict", "approved", '{"kind":"move","subject":"right"}'));
  insertProposal(externalDb, proposalRow("external-stale", "stale"));
  insertSuggestion(externalDb, suggestionRow("zukan-external-approved", "rejected"));
  insertSuggestion(externalDb, suggestionRow("identical-suggestion", "rejected"));
  insertSuggestion(externalDb, suggestionRow("zukan-conflict", "approved", "External version"));
  insertSuggestion(externalDb, suggestionRow("zukan-stale", "stale"));
  externalDb.exec("INSERT INTO scene_state_events VALUES ('external-derived-1', 'rebuild-me-too');");
  return [projectDb, externalDb];
}

async function sourceTreeState(root: string): Promise<Array<{ path: string; type: string; size: string; mode: string; mtimeNs: string; hash?: string; link?: string }>> {
  const result: Array<{ path: string; type: string; size: string; mode: string; mtimeNs: string; hash?: string; link?: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await fs.lstat(absolute, { bigint: true });
      const item = {
        path: relative,
        type: child.isDirectory() ? "directory" : child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other",
        size: info.size.toString(),
        mode: info.mode.toString(),
        mtimeNs: info.mtimeNs.toString(),
      };
      if (child.isDirectory()) {
        result.push(item);
        await walk(absolute);
      } else if (child.isSymbolicLink()) {
        result.push({ ...item, link: await fs.readlink(absolute) });
      } else if (child.isFile()) {
        result.push({ ...item, hash: digest(await fs.readFile(absolute)) });
      } else result.push(item);
    }
  };
  await walk(root);
  return result;
}

async function seedGitHistory(sourceRoot: string): Promise<void> {
  const base = path.dirname(sourceRoot);
  const seed = path.join(base, "seed");
  const remote = path.join(base, "remote.git");
  await fs.mkdir(path.join(seed, "story"), { recursive: true });
  await fs.mkdir(path.join(seed, "notes"), { recursive: true });
  await fs.mkdir(path.join(seed, "docs"), { recursive: true });
  await fs.writeFile(path.join(seed, "story", "scene.md"), "remote scene\n");
  await fs.writeFile(path.join(seed, "story", "delete-me.md"), "remote file to delete locally\n");
  await fs.writeFile(path.join(seed, "notes", "reading.md"), "remote reading note\n");
  await fs.writeFile(path.join(seed, "docs", "typechange.md.target"), "symlink target\n");
  await fs.symlink("typechange.md.target", path.join(seed, "docs", "typechange.md"));
  await fs.writeFile(path.join(seed, ".npmrc"), "//registry.npmjs.org/:_authToken=old-synthetic-token\n");
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "ignore" });
  runGit(seed, ["config", "user.email", "migration-test@example.invalid"]);
  runGit(seed, ["config", "user.name", "Migration Test"]);
  runGit(seed, ["add", "."]);
  runGit(seed, ["commit", "-m", "initial"]);
  execFileSync("git", ["clone", "--bare", seed, remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, sourceRoot], { stdio: "ignore" });
  runGit(sourceRoot, ["config", "user.email", "migration-test@example.invalid"]);
  runGit(sourceRoot, ["config", "user.name", "Migration Test"]);

  await fs.writeFile(path.join(sourceRoot, "story", "scene.md"), "local committed scene\n");
  await fs.writeFile(path.join(sourceRoot, "notes", "research.md"), "historical note: the secret token is a story clue\n");
  runGit(sourceRoot, ["add", "story/scene.md", "notes/research.md"]);
  runGit(sourceRoot, ["commit", "-m", "local pending commit"]);
  await fs.writeFile(path.join(sourceRoot, "story", "scene.md"), "staged user override\n");
  runGit(sourceRoot, ["add", "story/scene.md"]);
  await fs.unlink(path.join(sourceRoot, "docs", "typechange.md"));
  await fs.writeFile(path.join(sourceRoot, "docs", "typechange.md"), "staged type change\n");
  await fs.writeFile(path.join(sourceRoot, "notes", "staged-added.md"), "staged addition\n");
  runGit(sourceRoot, ["add", "docs/typechange.md", "notes/staged-added.md"]);
  await fs.unlink(path.join(sourceRoot, "story", "delete-me.md"));
  await fs.writeFile(path.join(sourceRoot, ".npmrc"), "//registry.npmjs.org/:_authToken=DO_NOT_EXPORT_NPM_SECRET_SENTINEL\n");
  await writeFile(sourceRoot, "scratch/attachment.bin", Buffer.from([0, 255, 1, 2, 10]));
  await writeFile(sourceRoot, ".env", "DO_NOT_EXPORT_GIT_SECRET_SENTINEL=secret\n");
  await writeFile(sourceRoot, ".ssh/id_ed25519", "DO_NOT_EXPORT_SSH_PRIVATE_KEY_SENTINEL\n");
  await writeFile(sourceRoot, ".ssh/id_rsa", "DO_NOT_EXPORT_SSH_RSA_SECRET_SENTINEL\n");
  await writeFile(sourceRoot, ".git-credentials", "https://user:DO_NOT_EXPORT_GIT_CREDENTIAL_SENTINEL@example.invalid\n");
  await writeFile(sourceRoot, ".config/git/credentials", "https://user:DO_NOT_EXPORT_GIT_STORE_SENTINEL@example.invalid\n");
  await writeFile(sourceRoot, ".config/gh/hosts.yml", "github.com:\n    oauth_token: DO_NOT_EXPORT_GH_SECRET_SENTINEL\n");
  await writeFile(sourceRoot, "gcloud/credentials.db", "DO_NOT_EXPORT_GCLOUD_SECRET_SENTINEL\n");
  await writeFile(sourceRoot, ".config/gcloud/legacy_credentials/user/adc.json", "DO_NOT_EXPORT_GCLOUD_ADC_SENTINEL\n");
  await writeFile(sourceRoot, ".aws/credentials", "DO_NOT_EXPORT_AWS_SECRET_SENTINEL\n");
  await writeFile(sourceRoot, ".azure/accessTokens.json", "DO_NOT_EXPORT_AZURE_SECRET_SENTINEL\n");
  await writeFile(sourceRoot, ".docker/config.json", '{"auths":{"registry.invalid":"DO_NOT_EXPORT_DOCKER_SECRET_SENTINEL"}}\n');
  await writeFile(sourceRoot, ".kube/config", "token: DO_NOT_EXPORT_KUBE_SECRET_SENTINEL\n");
  runGit(sourceRoot, ["add", "-f", ".ssh/id_ed25519", ".ssh/id_rsa", ".git-credentials", ".config/git/credentials", ".config/gh/hosts.yml", "gcloud/credentials.db", ".config/gcloud/legacy_credentials/user/adc.json", ".aws/credentials", ".azure/accessTokens.json", ".docker/config.json", ".kube/config"]);
}

async function createProjectStores(sourceRoot: string, workspaceRoot: string): Promise<Buffer> {
  await writeFile(sourceRoot, "meta/speaker-corrections.jsonl", '{"id":"correction-1","entityId":"speaker-a","chosen":"speaker-b"}\n');
  await writeFile(sourceRoot, "meta/speaker-model.json", '{"version":1,"featureNames":["manual"],"weights":[0.5],"bias":0,"highProbabilityThreshold":0.7,"trainedAt":"2025-01-01T00:00:00.000Z","vendorExtension":{"preserve":true}}\n');
  await writeFile(sourceRoot, "meta/synonyms.yaml", "groups:\n  - canonical: lantern\n    variants: [lamp, light]\nlegacy-extension: keep-this-field\n");
  await writeFile(sourceRoot, "meta/candidate-ignore-list.yaml", "ignored:\n  - entity: protagonist\n    term: chosen-user-override\n");
  await writeFile(sourceRoot, "meta/contradiction-dismissals.jsonl", '{"id":"dismissal-1","candidateId":"candidate-1","reason":"author-reviewed"}\n');
  await writeFile(sourceRoot, "meta/publish-episodes.yaml", "episodes:\n  '1': scene-1\ncustom-key: preserve-me\n");
  await writeFile(sourceRoot, ".arcadia/llm-model-settings.json", '{"defaultPresetId":"selected-small-model","presets":[{"id":"selected-small-model","model":"local/model","label":"selected"}],"featurePresetIds":{"state":"selected-small-model"},"privateExtension":{"retain":7}}\n');
  await writeFile(sourceRoot, ".arcadia/nlp-feature-settings.json", '{"externalEnabled":{"summary":false,"synonym":true},"futureFlag":"keep"}\n');
  await writeFile(sourceRoot, ".arcadia/llm-usage.jsonl", '{"ts":"2025-01-01T00:00:00.000Z","feature":"summary","model":"local/model","promptVersion":"v1","inputTokens":12,"outputTokens":4,"cacheHit":false,"durationMs":50,"aborted":false}\n');
  await writeFile(sourceRoot, ".arcadia/cover.jpg", Buffer.from([255, 216, 255, 0, 17, 34, 255, 217]));
  await writeFile(sourceRoot, ".arcadia/speaker-eval-latest.json", '{"derived":true}\n');
  await writeFile(sourceRoot, "meta/speaker-rule-gates.json", '{"derived":true}\n');
  await writeFile(sourceRoot, ".arcadia/snapshots/scene-before.md", "scratch snapshot with author notes\n");
  await writeFile(sourceRoot, ".arcadia/snapshots/attachments/audio.bin", Buffer.from([0, 7, 255, 21]));
  await writeFile(sourceRoot, ".arcadia/change-sets/applied.json", JSON.stringify({ changeSet: { id: "stable-applied-id" }, status: "applied", unknownField: { preserve: true } }) + "\n");
  await writeFile(sourceRoot, ".arcadia/change-sets/pending.json", JSON.stringify({ changeSet: { id: "stable-pending-id" }, status: "proposed", ops: [{ path: "story/scene.md" }] }) + "\n");
  await writeFile(sourceRoot, ".arcadia/llm-cache/summary.json", '{"cache":"rebuild"}\n');
  await writeFile(sourceRoot, "meta/custom-extension.yaml", "vendor: stay-in-place\n");

  await writeFile(workspaceRoot, "app-state/projects.json", '[{"id":"old-project","clonePath":"/host/private/path"}]\n');
  await writeFile(workspaceRoot, "app-state/series.json", '[{"id":"series-1","projectId":"old-project"}]\n');
  await writeFile(workspaceRoot, "app-state/users.json", '[{"id":"user-1","passwordHash":"DO_NOT_EXPORT_USER_SECRET_SENTINEL"}]\n');
  const grant = {
    id: "share-1", ownerId: "owner-private", projectId: "old-project", scope: "sc-1", label: "reader",
    tokenHash: "b".repeat(64), tokenPrefix: "share_RAW_PREFIX", createdAt: "2025-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z", lastUsedAt: "2025-01-02T00:00:00.000Z",
  };
  await writeFile(workspaceRoot, "app-state/share-tokens.json", JSON.stringify([grant]) + "\n");
  await fs.symlink("app-state/share-tokens.json", path.join(workspaceRoot, "share-tokens.json"));
  const jobHistory = Buffer.from('{"jobs":[{"id":"private-job","result":{"text":"PRIVATE_JOB_RESULT_SENTINEL"}}],"inbox":[]}\n');
  await fs.writeFile(path.join(workspaceRoot, "app-state/jobs-state.json"), jobHistory, { mode: 0o600 });
  return jobHistory;
}

function operationContent(files: TargetFiles, target: string): string {
  const file = files.get(target);
  assert.ok(file, `expected target operation for ${target}`);
  return file.content;
}

test("legacy inspection preserves scoped data, both SQLite stores, and pending Git work without source writes", async (t) => {
  assert.equal(isSecretLegacyPath(".ssh/id_ed25519"), true);
  assert.equal(isSecretLegacyPath(".ssh/id_ed25519.pub"), false, "public SSH keys are not private credential files");
  assert.equal(isSecretLegacyPath("story/secret-ritual.md"), false, "ordinary manuscript paths are not scanned by body text");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-p04-test-"));
  const sourceRoot = path.join(temporary, "project");
  const workspaceRoot = path.join(temporary, "data");
  await seedGitHistory(sourceRoot);
  await fs.mkdir(path.join(sourceRoot, ".arcadia"), { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  const jobHistory = await createProjectStores(sourceRoot, workspaceRoot);
  const databases = await createDatabaseFixtures(sourceRoot, workspaceRoot);
  t.after(async () => {
    for (const db of databases) db.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const projectSidecars = await fs.readdir(path.join(sourceRoot, ".arcadia"));
  assert.ok(projectSidecars.includes("index.sqlite-wal"), "fixture must exercise a live WAL file");
  assert.ok(projectSidecars.includes("index.sqlite-shm"), "fixture must exercise the shared-memory sidecar");

  const files: TargetFiles = new Map([
    ["story/scene.md", { content: "remote scene\n", revision: digest("remote scene\n") }],
    ["story/delete-me.md", { content: "remote file to delete locally\n", revision: digest("remote file to delete locally\n") }],
    ["notes/reading.md", { content: "remote reading note\n", revision: digest("remote reading note\n") }],
  ]);
  const originalTarget = new Map(files);
  const beforeProject = await sourceTreeState(sourceRoot);
  const beforeWorkspace = await sourceTreeState(workspaceRoot);
  const inspection = await inspectLegacyProject({
    sourceRoot,
    workspaceDataRoot: workspaceRoot,
    workspaceProjectId: "old-project",
    target: targetReader(files),
  });

  assert.deepEqual(files, originalTarget, "inspection must return operations without mutating the target reader");
  assert.deepEqual(await sourceTreeState(sourceRoot), beforeProject, "project files, SQLite/WAL, Git objects and index metadata must remain unchanged");
  assert.deepEqual(await sourceTreeState(workspaceRoot), beforeWorkspace, "workspace files and external SQLite files must remain unchanged");
  assert.equal(inspection.pendingWorkspace.pendingCommitCount, 1);
  assert.ok(inspection.pendingWorkspace.stagedPaths.includes("story/scene.md"));
  assert.ok(inspection.pendingWorkspace.stagedPaths.includes("notes/staged-added.md"), "staged additions must be listed");
  assert.ok(inspection.pendingWorkspace.stagedPaths.includes("docs/typechange.md"), "staged type changes must be listed");
  assert.ok(inspection.pendingWorkspace.workingTreePaths.includes("story/delete-me.md"));
  const excludedGitCredentialPaths = [".npmrc", ".ssh/id_ed25519", ".ssh/id_rsa", ".git-credentials", ".config/git/credentials", ".config/gh/hosts.yml", "gcloud/credentials.db", ".config/gcloud/legacy_credentials/user/adc.json", ".aws/credentials", ".azure/accessTokens.json", ".docker/config.json", ".kube/config"];
  const pendingGitFiles = await createLegacySourceReader(sourceRoot).readGitPendingFiles(inspection.pendingWorkspace);
  for (const pathName of excludedGitCredentialPaths) {
    const file = pendingGitFiles.find(({ path: filePath }) => filePath === pathName);
    assert.equal(file?.excluded, "secret", `${pathName} should be classified by path before reading content`);
    assert.equal(file?.bytes, null, `${pathName} contents must not be read`);
    assert.ok(inspection.entries.some((entry) => entry.source === pathName && entry.category === "secret" && entry.disposition === "excluded"));
  }
  assert.deepEqual(await sourceTreeState(sourceRoot), beforeProject, "Git pending-file inspection must also leave the source tree unchanged");
  assert.deepEqual(await sourceTreeState(workspaceRoot), beforeWorkspace);

  const categories = new Set(inspection.entries.map(({ category }) => category));
  for (const category of ["authoritative", "provisional", "secret", "derived", "relocated"]) assert.ok(categories.has(category), `missing ${category} category`);
  const writes = inspection.operations.flatMap((operation) => operation.writes);
  const writePaths = new Set(writes.map(({ path: writePath }) => writePath));
  for (const pathName of excludedGitCredentialPaths) assert.ok(!writePaths.has(pathName), `${pathName} must not become a migration operation`);
  for (const expected of [
    "meta/scriptorium/modules/speaker/corrections.jsonl",
    "meta/scriptorium/modules/speaker/adopted-model.json",
    "meta/scriptorium/modules/nlp/synonyms.yaml",
    "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml",
    "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl",
    "meta/scriptorium/modules/publishing/episodes.yaml",
    "meta/scriptorium/modules/assistant/model-settings.json",
    "meta/scriptorium/modules/assistant/usage.jsonl",
    "meta/scriptorium/modules/publishing/assets/cover.jpg",
    "meta/scriptorium/modules/story/change-sets/applied.json",
    "meta/scriptorium/modules/story/local-snapshots/scene-before.md",
    "meta/scriptorium/modules/story/local-snapshots/attachments/audio.bin",
    "meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl",
    "meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/zukan_suggestions.jsonl",
    "meta/scriptorium/modules/story/legacy/sqlite/workspace-index/state_proposals.jsonl",
    "meta/scriptorium/modules/story/legacy/sqlite/workspace-index/zukan_suggestions.jsonl",
    "meta/scriptorium/modules/publishing/share-grants.jsonl",
    "story/scene.md",
    "story/delete-me.md",
    "docs/typechange.md",
    "notes/research.md",
    "notes/staged-added.md",
    "scratch/attachment.bin",
  ]) assert.ok(writePaths.has(expected), `missing planned import ${expected}`);

  assert.ok(inspection.entries.some((entry) => entry.source.endsWith("#scene_state_events") && entry.disposition === "rebuild"));
  assert.ok(inspection.entries.some((entry) => entry.source.endsWith("#private_tokens") && entry.category === "secret" && entry.disposition === "excluded"));
  assert.ok(inspection.entries.some((entry) => entry.source === "meta/custom-extension.yaml" && entry.category === "provisional" && entry.disposition === "planned"));
  assert.ok(inspection.entries.some((entry) => entry.source === "app-state/projects.json" && entry.disposition === "relocated"));
  const jobsEntry = inspection.entries.find((entry) => entry.source === "app-state/jobs-state.json");
  assert.equal(jobsEntry?.category, "authoritative");
  assert.equal(jobsEntry?.disposition, "relocated");
  assert.equal(jobsEntry?.target, `/history/jobs/legacy/${digest(jobHistory)}.json`);
  assert.match(jobsEntry?.detail ?? "", /API-owned legacy job import hook/u);
  assert.ok(!JSON.stringify(inspection).includes("PRIVATE_JOB_RESULT_SENTINEL"), "legacy job result bodies stay outside Core inspection output");
  assert.ok(inspection.entries.some((entry) => entry.source === ".env" && entry.category === "secret" && entry.disposition === "excluded"));
  assert.ok(inspection.entries.some((entry) => entry.source.endsWith("#state_proposals") && entry.category === "provisional" && entry.disposition === "deferred"));
  assert.ok(inspection.entries.some((entry) => entry.source.endsWith("#zukan_suggestions") && entry.category === "provisional" && entry.disposition === "deferred"));
  assert.ok(inspection.recovery.some((record) => record.content.includes("stable-pending-id")));

  const binaryWrites = writes.filter(({ path: writePath }) => writePath.endsWith("cover.jpg") || writePath.endsWith("audio.bin") || writePath.endsWith("attachment.bin"));
  assert.equal(binaryWrites.length, 3);
  assert.ok(binaryWrites.every((write) => write.encoding === "base64"));
  const operationFiles = new Map(writes.map((write) => [write.path, { content: write.content ?? "", revision: "" }]));
  const projectProposalRecords = operationContent(operationFiles, "meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl");
  const workspaceProposalRecords = operationContent(operationFiles, "meta/scriptorium/modules/story/legacy/sqlite/workspace-index/state_proposals.jsonl");
  const projectSuggestions = operationContent(operationFiles, "meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/zukan_suggestions.jsonl");
  const workspaceSuggestions = operationContent(operationFiles, "meta/scriptorium/modules/story/legacy/sqlite/workspace-index/zukan_suggestions.jsonl");
  assert.deepEqual(projectProposalRecords.trim().split("\n").map((line) => JSON.parse(line).id).sort(),
    ["identical-proposal", "project-approved", "project-pending", "shared-conflict"]);
  assert.deepEqual(workspaceProposalRecords.trim().split("\n").map((line) => JSON.parse(line).id).sort(),
    ["external-approved", "external-stale", "identical-proposal", "shared-conflict"]);
  assert.ok(projectProposalRecords.includes('"status":"proposed"'), "proposed workflow status must remain in the raw snapshot");
  assert.ok(workspaceProposalRecords.includes('"status":"stale"'), "stale workflow status must remain in the raw snapshot");
  assert.ok(projectProposalRecords.includes('"vendor_extension":"preserve-unknown-state-field"'));
  assert.ok(projectSuggestions.includes('"plugin_payload":"preserve-unknown-suggestion-field"'));
  assert.ok(projectProposalRecords.includes("shared-conflict") && workspaceProposalRecords.includes("shared-conflict"),
    "divergent IDs must remain distinct in their database-specific snapshots");
  assert.ok(projectSuggestions.includes("zukan-conflict") && workspaceSuggestions.includes("zukan-conflict"));
  assert.ok(projectSuggestions.includes('"status":"pending"'));
  assert.ok(workspaceSuggestions.includes('"status":"stale"'));
  for (const payload of [projectProposalRecords, workspaceProposalRecords, projectSuggestions, workspaceSuggestions]) {
    assert.ok(!payload.includes("api_token"));
    assert.ok(!payload.includes("DO_NOT_EXPORT_SQLITE_SECRET_SENTINEL"));
  }
  assert.ok(!writePaths.has("meta/scriptorium/modules/story/state-proposals.jsonl"));
  assert.ok(!writePaths.has("meta/scriptorium/modules/story/zukan-suggestions.jsonl"));
  assert.equal(writes.find(({ path: writePath }) => writePath.endsWith("speaker/adopted-model.json"))?.content,
    '{"version":1,"featureNames":["manual"],"weights":[0.5],"bias":0,"highProbabilityThreshold":0.7,"trainedAt":"2025-01-01T00:00:00.000Z","vendorExtension":{"preserve":true}}\n');
  assert.equal(writes.find(({ path: writePath }) => writePath.endsWith("nlp/synonyms.yaml"))?.content,
    "groups:\n  - canonical: lantern\n    variants: [lamp, light]\nlegacy-extension: keep-this-field\n");
  assert.equal(writes.find(({ path: writePath }) => writePath.endsWith("assistant/model-settings.json"))?.content,
    '{"defaultPresetId":"selected-small-model","presets":[{"id":"selected-small-model","model":"local/model","label":"selected"}],"featurePresetIds":{"state":"selected-small-model"},"privateExtension":{"retain":7}}\n');
  assert.equal(writes.find(({ path: writePath }) => writePath === "story/scene.md")?.content, "staged user override\n");
  assert.equal(writes.find(({ path: writePath }) => writePath === "notes/research.md")?.content, "historical note: the secret token is a story clue\n");
  const grantWrite = writes.find(({ path: writePath }) => writePath.endsWith("share-grants.jsonl"))!;
  assert.ok(grantWrite.content?.includes("tokenHash"));
  assert.ok(!grantWrite.content?.includes("owner-private"));
  assert.ok(!grantWrite.content?.includes("share_RAW_PREFIX"));
  const allInspectionData = JSON.stringify(inspection);
  assert.ok(!allInspectionData.includes("DO_NOT_EXPORT_TOKEN_SENTINEL"));
  assert.ok(!allInspectionData.includes("DO_NOT_EXPORT_USER_SECRET_SENTINEL"));
  assert.ok(!allInspectionData.includes("DO_NOT_EXPORT_GIT_SECRET_SENTINEL"));
  for (const secret of ["NPM_SECRET", "SSH_PRIVATE_KEY", "SSH_RSA_SECRET", "GIT_CREDENTIAL", "GIT_STORE", "GH_SECRET", "GCLOUD_SECRET", "GCLOUD_ADC", "AWS_SECRET", "AZURE_SECRET", "DOCKER_SECRET", "KUBE_SECRET"]) {
    assert.ok(!allInspectionData.includes(`DO_NOT_EXPORT_${secret}_SENTINEL`), `secret marker ${secret} leaked into the report`);
  }
  assert.ok(!allInspectionData.includes("DO_NOT_EXPORT_SQLITE_SECRET_SENTINEL"));
  assert.ok(!allInspectionData.includes('"subject":"left"'));
  assert.ok(!allInspectionData.includes('"subject":"right"'));
  for (const operation of inspection.operations) assertChangeOperation(operation);

  let proposeCalls = 0;
  const proposal = await proposeMigrationImport({
    async propose(projectId, value) {
      proposeCalls += 1;
      assert.equal(projectId, "new-project");
      return value;
    },
  }, "new-project", inspection);
  assert.equal(proposeCalls, 1);
  assert.equal(proposal.source, "author");

  applyOperations(files, inspection.operations);
  const repeated = await inspectLegacyProject({
    sourceRoot,
    workspaceDataRoot: workspaceRoot,
    workspaceProjectId: "old-project",
    target: targetReader(files),
  });
  assert.deepEqual(repeated.operations, [], "an applied import plan must be idempotent");
  assert.deepEqual(await sourceTreeState(sourceRoot), beforeProject);
  assert.deepEqual(await sourceTreeState(workspaceRoot), beforeWorkspace);

  const disabledFiles: TargetFiles = new Map([
    ["story/scene.md", { content: "remote scene\n", revision: digest("remote scene\n") }],
    ["story/delete-me.md", { content: "remote file to delete locally\n", revision: digest("remote file to delete locally\n") }],
  ]);
  const disabled = await inspectLegacyProject({
    sourceRoot,
    workspaceDataRoot: workspaceRoot,
    workspaceProjectId: "old-project",
    enabledModules: [],
    target: targetReader(disabledFiles),
  });
  const disabledWrites = disabled.operations.flatMap((operation) => operation.writes);
  assert.ok(disabledWrites.some(({ path: writePath }) => writePath === "meta/scriptorium/modules/speaker/legacy/files/meta/speaker-corrections.jsonl"));
  assert.ok(disabledWrites.some(({ path: writePath }) => writePath === "meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl"));
  assert.ok(disabledWrites.some(({ path: writePath }) => writePath === "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl"));
  assert.ok(disabled.entries.some((entry) => entry.source === "meta/speaker-corrections.jsonl" && entry.disposition === "preserved-unreadable"));
  assert.ok(disabled.entries.some((entry) => entry.source.endsWith("#state_proposals") && entry.disposition === "preserved-unreadable"));
  assert.ok(disabled.entries.some((entry) => entry.source === "app-state/share-tokens.json" && entry.disposition === "preserved-unreadable"));
  assert.ok(disabledWrites.every(({ path: writePath }) => !/^meta\/scriptorium\/modules\/(?:speaker|story|publishing)\/(?!legacy\/)/.test(writePath)), "disabled module records must not be written to canonical readable paths");
  applyOperations(disabledFiles, disabled.operations);
  const disabledAgain = await inspectLegacyProject({
    sourceRoot,
    workspaceDataRoot: workspaceRoot,
    workspaceProjectId: "old-project",
    enabledModules: [],
    target: targetReader(disabledFiles),
  });
  assert.deepEqual(disabledAgain.operations, [], "opaque disabled data must also be idempotent");
});
