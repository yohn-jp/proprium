import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createServer as createApiServer, importLegacyJobHistory, importLegacyRecentActivity } from "@scriptorium/api";
import { CoreStore } from "../../packages/core/dist/index.js";
import {
  createMigrationProducerRegistry,
  inspectLegacyProject,
  proposeMigrationImport,
  registerMigrationProducer,
} from "../../packages/migration/dist/index.js";
import { createStoryMigrationProducer } from "@scriptorium/module-story/migration";
import { createDiagnosticsMigrationProducer } from "@scriptorium/module-diagnostics/migration";
import { createNlpMigrationProducer } from "@scriptorium/module-nlp/migration";
import { createSemanticMigrationProducer } from "@scriptorium/module-semantic/migration";
import { createSpeakerMigrationProducer } from "@scriptorium/module-speaker/migration";
import { createAssistantMigrationProducer } from "@scriptorium/module-assistant/migration";
import { createPublishingMigrationProducer } from "@scriptorium/module-publishing/migration";
import { hashDialogueText } from "@scriptorium/module-speaker";

const ALL_MODULES = ["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"];
const SPEAKER_OVERRIDE_SCENE_PATH = "plot/volumes/volume-1/chapters/chapter-1/scenes/sc-speaker-override-stable.yaml";
const SPEAKER_OVERRIDE_MANUSCRIPT_PATH = "manuscript/v1/sc-speaker-override-stable.md";
const SPEAKER_OVERRIDE_DIALOGUE = "『俺が行く。』";
const SPEAKER_OVERRIDE_SCENE = [
  "id: sc-speaker-override-stable",
  "type: scene",
  "name: Synthetic manual speaker override",
  "volume: volume-1",
  "chapter: chapter-1",
  "appears: [char-hero]",
  "speakerCount: 1",
  `manuscript: ${SPEAKER_OVERRIDE_MANUSCRIPT_PATH}`,
  "speakerOverrides:",
  "  - sentenceIndex: 1",
  `    textHash: ${hashDialogueText(SPEAKER_OVERRIDE_DIALOGUE)}`,
  `    dialogueText: "${SPEAKER_OVERRIDE_DIALOGUE}"`,
  "    speakerEntityId: char-hero",
  "    source: direct",
  "unknown-scene-field: retain exactly",
  "",
].join("\n");
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: FIXTURE_GIT_ENV,
  }).trim();
}

async function writeFile(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, value);
}

async function treeState(root) {
  const state = [];
  const rootInfo = await fs.lstat(root, { bigint: true });
  state.push({ path: ".", type: "directory", mode: rootInfo.mode.toString(), size: rootInfo.size.toString(), mtimeNs: rootInfo.mtimeNs.toString() });
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
  execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore", env: FIXTURE_GIT_ENV });
  git(seed, "config", "user.name", "Synthetic Author");
  git(seed, "config", "user.email", "author@example.invalid");
  await writeFile(seed, ".gitignore", ".arcadia/\n");
  await writeFile(seed, "meta/project.yaml", "id: legacy-project\ntitle: Synthetic Work\nunknown-project-field: keep\n");
  await writeFile(seed, "meta/scratch/idea-stable.md", "A synthetic published scratch note.\n");
  await writeFile(seed, "meta/scratch/files/idea-stable/diagram.bin", Buffer.from([7, 0, 249, 33]));
  await writeFile(seed, SPEAKER_OVERRIDE_SCENE_PATH, [
    "id: sc-speaker-override-stable",
    "type: scene",
    "name: Synthetic manual speaker override",
    "volume: volume-1",
    "chapter: chapter-1",
    "appears: [char-hero]",
    "speakerCount: 1",
    `manuscript: ${SPEAKER_OVERRIDE_MANUSCRIPT_PATH}`,
    "unknown-scene-field: retain exactly",
    "",
  ].join("\n"));
  await writeFile(seed, SPEAKER_OVERRIDE_MANUSCRIPT_PATH, `星野は灯りを見た。${SPEAKER_OVERRIDE_DIALOGUE}\n`);
  await writeFile(seed, "story/scene.md", "published scene\n");
  await writeFile(seed, "notes/author-note.md", "Synthetic author note, retained exactly.\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "synthetic legacy baseline");

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore", env: FIXTURE_GIT_ENV });
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--set-upstream", "origin", "main");
  execFileSync("git", ["clone", remote, sourceRoot], { stdio: "ignore", env: FIXTURE_GIT_ENV });
  git(sourceRoot, "config", "user.name", "Synthetic Author");
  git(sourceRoot, "config", "user.email", "author@example.invalid");

  await writeFile(sourceRoot, ".npmrc", "//registry.example.invalid/:_authToken=DO_NOT_EXPORT_SYNTHETIC_NPM_SECRET\n");
  await writeFile(sourceRoot, ".ssh/id_ed25519", "DO_NOT_EXPORT_SYNTHETIC_PRIVATE_KEY\n");
  git(sourceRoot, "add", ".npmrc", ".ssh/id_ed25519");

  await writeFile(sourceRoot, SPEAKER_OVERRIDE_SCENE_PATH, SPEAKER_OVERRIDE_SCENE);
  await writeFile(sourceRoot, "notes/from-unpublished-commit.md", "A committed local note that has not reached the remote.\n");
  git(sourceRoot, "add", "notes/from-unpublished-commit.md", SPEAKER_OVERRIDE_SCENE_PATH);
  git(sourceRoot, "commit", "-m", "unpublished author work");
  await writeFile(sourceRoot, "story/scene.md", "staged author version\n");
  git(sourceRoot, "add", "story/scene.md");
  await writeFile(sourceRoot, "notes/staged-add.md", "A staged local addition.\n");
  git(sourceRoot, "add", "notes/staged-add.md");
  await fs.unlink(path.join(sourceRoot, "notes/author-note.md"));
  git(sourceRoot, "add", "-u", "notes/author-note.md");
  await writeFile(sourceRoot, "notes/story-clue.md", "This fictional note uses the word secret as part of its plot.\n");
  return { remote, sourceRoot };
}

function insertStateProposal(database, { id, status, subject, token = null }) {
  database.prepare(`INSERT INTO state_proposals (
    id, scene_id, event_json, manuscript_hash, status, conflict_event_ids_json,
    duplicate_of_proposal_id, history_json, created_at, updated_at, api_token, vendor_extension
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, "scene-legacy", JSON.stringify({ kind: "move", subject, object: "library" }), "source-hash",
      status, "[]", null, "[{\"action\":\"created\"}]", "2025-01-01T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z", token, `unknown-state:${id}`);
}

function insertSuggestion(database, { id, status, text }) {
  database.prepare(`INSERT INTO zukan_suggestions (
    id, entity_id, block_path, proposed_text, evidence_json, status, source,
    kind, source_session_id, source_turn_range_json, confidence, created_at, updated_at, plugin_payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, "character-legacy", "facts/0", text, "[{\"quote\":\"author evidence\"}]", status,
      "manuscript", "fact", null, null, "high", "2025-02-01T00:00:00.000Z", "2025-02-02T00:00:00.000Z",
      `unknown-suggestion:${id}`);
}

function createLegacyDatabase(file, state, suggestions) {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  database.exec(`
    CREATE TABLE state_proposals (
      id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, event_json TEXT NOT NULL,
      manuscript_hash TEXT NOT NULL, status TEXT NOT NULL, conflict_event_ids_json TEXT NOT NULL,
      duplicate_of_proposal_id TEXT, history_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, api_token TEXT, vendor_extension TEXT
    );
    CREATE TABLE zukan_suggestions (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, block_path TEXT NOT NULL,
      proposed_text TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, kind TEXT, source_session_id TEXT, source_turn_range_json TEXT,
      confidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, plugin_payload TEXT
    );
    CREATE TABLE entities (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE scene_state_events (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE reader_knowledge_events (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE private_tokens (id TEXT, token_value TEXT);
  `);
  for (const row of state) insertStateProposal(database, row);
  for (const row of suggestions) insertSuggestion(database, row);
  database.prepare("INSERT INTO entities VALUES (?, ?)").run("derived-entity", "DO_NOT_PUBLISH_DERIVED_ENTITY");
  database.prepare("INSERT INTO scene_state_events VALUES (?, ?)").run("derived-state", "DO_NOT_PUBLISH_SCENE_EVENT");
  database.prepare("INSERT INTO reader_knowledge_events VALUES (?, ?)").run("derived-knowledge", "DO_NOT_PUBLISH_KNOWLEDGE_EVENT");
  database.prepare("INSERT INTO private_tokens VALUES (?, ?)").run("credential-row", "DO_NOT_EXPORT_SQLITE_SECRET");
  return database;
}

async function addLegacyDatabases(sourceRoot, workspaceRoot) {
  const projectPath = path.join(sourceRoot, ".arcadia/index.sqlite");
  const workspacePath = path.join(workspaceRoot, "index", path.basename(sourceRoot), "index.sqlite");
  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  const project = createLegacyDatabase(projectPath,
    [
      { id: "state-project-approved", status: "approved", subject: "accepted project state", token: "DO_NOT_EXPORT_SQLITE_SECRET" },
      { id: "state-divergent", status: "approved", subject: "project version" },
      { id: "state-project-pending", status: "proposed", subject: "project proposal" },
    ],
    [
      { id: "zukan-project-approved", status: "approved", text: "accepted project fact" },
      { id: "zukan-project-pending", status: "pending", text: "unaccepted project suggestion" },
      { id: "zukan-divergent", status: "approved", text: "project suggestion version" },
    ]);
  const workspace = createLegacyDatabase(workspacePath,
    [
      { id: "state-workspace-rejected", status: "rejected", subject: "rejected workspace state" },
      { id: "state-divergent", status: "approved", subject: "workspace version" },
      { id: "state-workspace-stale", status: "stale", subject: "stale workspace proposal" },
    ],
    [
      { id: "zukan-workspace-rejected", status: "rejected", text: "rejected workspace fact" },
      { id: "zukan-workspace-pending", status: "pending", text: "unaccepted workspace suggestion" },
      { id: "zukan-workspace-stale", status: "stale", text: "stale workspace suggestion" },
      { id: "zukan-divergent", status: "rejected", text: "workspace suggestion version" },
    ]);
  return [project, workspace];
}

async function addLegacyFiles(sourceRoot, workspaceRoot) {
  const textFiles = new Map([
    ["meta/speaker-corrections.jsonl", "{\"id\":\"speaker-correction-stable\",\"speakerId\":\"speaker-1\",\"label\":\"Mika\",\"extension\":{\"retain\":true}}\n"],
    ["meta/speaker-model.json", "{\"version\":1,\"featureNames\":[\"manual\"],\"weights\":[0.5],\"bias\":0,\"extension\":\"retain\"}\n"],
    ["meta/synonyms.yaml", "groups:\n  - canonical: lantern\n    variants: [lamp, light]\nunknown-extension: retain\n"],
    ["meta/candidate-ignore-list.yaml", "terms:\n  - keep-out\nunknown-extension: retain\n"],
    ["meta/contradiction-dismissals.jsonl", "{\"id\":\"dismissal-stable\",\"candidateId\":\"candidate-1\",\"reason\":\"author reviewed\"}\n"],
    ["meta/publish-episodes.yaml", "episodes:\n  - id: episode-stable\n    number: 1\n    title: First\n    scope: chapter\n    scopeId: chapter-1\n    sceneIds: [scene-legacy]\nunknown-extension: retain\n"],
    ["meta/lint-rules.yaml", "rules:\n  - id: rule-stable\n    expression: 'true'\nunknown-extension: retain\n"],
    ["meta/tone-lexicon.yaml", "terms:\n  - word: lantern\n    weight: 0.5\nunknown-extension: retain\n"],
    ["meta/plot-lexicon.yaml", "terms:\n  - word: promise\n    weight: 0.5\nunknown-extension: retain\n"],
    [".arcadia/llm-model-settings.json", "{\"defaultPresetId\":\"small-local\",\"presets\":[{\"id\":\"small-local\",\"model\":\"local/tiny\"}],\"extension\":{\"retain\":true}}\n"],
    [".arcadia/nlp-feature-settings.json", "{\"enabledFeatures\":[],\"privacy\":\"local-only\",\"extension\":7}\n"],
    [".arcadia/llm-usage.jsonl", "{\"id\":\"usage-stable\",\"model\":\"local/tiny\",\"tokens\":3}\n"],
    [".arcadia/change-sets/applied.json", "{\"changeSet\":{\"id\":\"applied-changeset-stable\"},\"status\":\"applied\",\"unknownField\":{\"retain\":true}}\n"],
    [".arcadia/change-sets/pending.json", "{\"changeSet\":{\"id\":\"pending-changeset-stable\"},\"status\":\"proposed\",\"operations\":[{\"path\":\"story/scene.md\"}]}\n"],
    [".arcadia/snapshots/scene-before.md", "---\nauthor_note: preserve\n---\nSynthetic local snapshot\n"],
    [".arcadia/llm-cache/summary.json", "{\"derived\":true}\n"],
  ]);
  for (const [relative, content] of textFiles) await writeFile(sourceRoot, relative, content);
  await writeFile(sourceRoot, ".arcadia/cover.jpg", Buffer.from([0, 255, 3, 10, 13, 128, 42]));
  await writeFile(sourceRoot, ".arcadia/snapshots/attachments/diagram.bin", Buffer.from([1, 2, 0, 254, 255, 9]));
  const grant = {
    id: "share-grant-stable",
    ownerId: "synthetic-private-owner",
    projectId: "legacy-project-id",
    scope: "ch-chapter-1",
    label: "Reader access",
    tokenHash: "b".repeat(64),
    tokenPrefix: "DO_NOT_EXPORT_BEARER_PREFIX",
    bearerToken: "DO_NOT_EXPORT_BEARER_VALUE",
    createdAt: "2025-03-01T00:00:00.000Z",
    expiresAt: "2026-03-01T00:00:00.000Z",
  };
  const foreignGrant = {
    ...grant,
    id: "foreign-share-grant",
    projectId: "some-other-project",
    tokenHash: "c".repeat(64),
  };
  await writeFile(workspaceRoot, "app-state/share-tokens.json", JSON.stringify([grant, foreignGrant]) + "\n");
  await writeFile(workspaceRoot, "app-state/projects.json", JSON.stringify([{ id: "legacy-project-id", url: "https://example.invalid/owner/work.git" }]) + "\n");
  await writeFile(workspaceRoot, "app-state/users.json", "DO_NOT_EXPORT_WORKSPACE_USER_SECRET\n");
  await writeFile(workspaceRoot, "app-state/series.json", JSON.stringify({
    series: [{ id: "series-stable", name: "Synthetic series", bibleProjectId: "legacy-project-id", memberProjectIds: ["legacy-project-id"], unknownField: "retain" }],
    bindings: [{ projectId: "legacy-project-id", role: "member", unknownBinding: true }],
  }, null, 2) + "\n");

  const jobsState = {
    jobs: [
      {
        id: "job-mapped-stable", type: "aspect-review", status: "done", progress: 1,
        result: { summary: "Synthetic author review", findings: [{ id: "finding-stable", text: "A mapped result." }] },
        error: null, projectKey: "legacy-project-id", userId: "legacy-user",
        createdAt: "2025-04-01T00:00:00.000Z", updatedAt: "2025-04-01T00:01:00.000Z", finishedAt: "2025-04-01T00:01:00.000Z",
      },
      {
        id: "job-unmapped-stable", type: "speaker-eval", status: "error", progress: 0.5,
        result: null, error: "Synthetic private unmapped failure", projectKey: "legacy-project-id", userId: null,
        createdAt: "2025-04-02T00:00:00.000Z", updatedAt: "2025-04-02T00:01:00.000Z", finishedAt: "2025-04-02T00:01:00.000Z",
      },
    ],
    inbox: [
      {
        id: "inbox-mapped-stable", kind: "job-complete", jobId: "job-mapped-stable", jobType: "aspect-review",
        title: "Synthetic review", body: "Mapped result details retained.", status: "done", read: false,
        userId: "legacy-user", projectKey: "legacy-project-id", createdAt: "2025-04-01T00:01:00.000Z",
      },
      {
        id: "inbox-unmapped-stable", kind: "job-complete", jobId: "job-unmapped-stable", jobType: "speaker-eval",
        title: "Synthetic private failure", body: "Unmapped details stay private.", status: "error", read: false,
        userId: null, projectKey: "legacy-project-id", createdAt: "2025-04-02T00:01:00.000Z",
      },
    ],
  };
  const jobsStateBytes = Buffer.from(`${JSON.stringify(jobsState)}\n`, "utf8");
  await writeFile(workspaceRoot, "app-state/jobs-state.json", jobsStateBytes);
  const recentActivity = {
    byKey: {
      "legacy-user:legacy-project-id": [
        {
          sceneId: "sc-cursor-desktop",
          sentenceOffset: 29,
          pageIndex: 4,
          deviceType: "desktop",
          updatedAt: "2025-04-03T10:00:00.000Z",
          extensionCursorField: "DO_NOT_PUBLISH_CURSOR_EXTENSION",
        },
        {
          sceneId: "sc-cursor-mobile",
          sentenceOffset: 11,
          pageIndex: 2,
          deviceType: "mobile",
          updatedAt: "2025-04-03T11:00:00.000Z",
        },
      ],
      "unmapped-user:legacy-project-id": [
        {
          sceneId: "sc-cursor-unmapped-user",
          sentenceOffset: 7,
          pageIndex: 1,
          deviceType: "mobile",
          updatedAt: "2025-04-03T12:00:00.000Z",
          extensionCursorField: "DO_NOT_PUBLISH_CURSOR_EXTENSION",
        },
      ],
      "legacy-user:foreign-project-id": [
        {
          sceneId: "sc-cursor-unmapped-project",
          sentenceOffset: 3,
          pageIndex: 0,
          deviceType: "desktop",
          updatedAt: "2025-04-03T13:00:00.000Z",
        },
      ],
    },
    extensionRecentActivityField: "DO_NOT_PUBLISH_RAW_CURSOR_EXTENSION",
  };
  const recentActivityBytes = Buffer.from(`${JSON.stringify(recentActivity)}\n`, "utf8");
  await writeFile(workspaceRoot, "app-state/recent-activity.json", recentActivityBytes);
  await fs.chmod(path.join(workspaceRoot, "app-state"), 0o700);
  await fs.chmod(path.join(workspaceRoot, "app-state/jobs-state.json"), 0o600);
  await fs.chmod(path.join(workspaceRoot, "app-state/recent-activity.json"), 0o600);
  await fs.chmod(workspaceRoot, 0o700);
  return { jobsStateBytes, recentActivityBytes };
}

function createComposedRegistry(observedModuleSets) {
  const registry = createMigrationProducerRegistry();
  for (const producer of [
    createStoryMigrationProducer(),
    createDiagnosticsMigrationProducer(),
    createNlpMigrationProducer(),
    createSemanticMigrationProducer(),
    createSpeakerMigrationProducer(),
    createAssistantMigrationProducer(),
    createPublishingMigrationProducer(),
  ]) registerMigrationProducer(registry, producer);
  registerMigrationProducer(registry, {
    id: "p12-module-set-probe",
    async inspect(context) {
      observedModuleSets.push([...context.enabledModules].sort());
      return { entries: [], operations: [], recovery: [] };
    },
  });
  return registry;
}

function writesOf(inspection) {
  return inspection.operations.flatMap((operation) => operation.writes);
}

function recoveryText(record) {
  return record.encoding === "base64"
    ? Buffer.from(record.content, "base64").toString("utf8")
    : record.content;
}

async function inspect(core, projectId, sourceRoot, workspaceRoot, registry, reader, enabledModules, identity) {
  return inspectLegacyProject({
    sourceRoot,
    workspaceDataRoot: workspaceRoot,
    workspaceProjectId: "legacy-project-id",
    legacyRepositoryMappings: { "legacy-project-id": identity },
    enabledModules,
    registry,
    target: reader,
  });
}

async function withOwnerApi(core, apiToken, staticDir, usageDirectory, callback) {
  const api = createApiServer({ store: core, authToken: apiToken, staticDir, usageDirectory });
  await new Promise((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ token: apiToken }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    return await callback({ api, base, headers: { Cookie: cookie } });
  } finally {
    await new Promise((resolveClose, rejectClose) => api.close((error) => error ? rejectClose(error) : resolveClose()));
  }
}

async function approveCheckpointPublish(core, projectId, inspection, batchId) {
  const writes = writesOf(inspection);
  assert.equal(new Set(writes.map(({ path: target }) => target)).size, writes.length,
    "the registry must withhold duplicate target writes before author review");
  const proposal = await proposeMigrationImport(core, projectId, inspection);
  await core.approve(projectId, {
    proposalId: proposal.id,
    operationIds: proposal.operations.map((operation) => operation.id),
    authorScope: "synthetic-migration-author",
  });
  for (const operation of proposal.operations) await core.checkpoint(projectId, operation);
  const publication = await core.publish(projectId, batchId);
  assert.equal(publication.state, "confirmed", "the actual bare remote must confirm the migration publication");
  assert.ok(publication.remoteCommit);
  const publishedReader = await core.reader(projectId);
  assert.equal(publishedReader.snapshot.remoteCommit, publication.remoteCommit,
    "the verification reader must be pinned to the confirmed publication");
  return publishedReader;
}

async function assertPublishedWrites(reader, writes) {
  for (const write of writes) {
    const recovered = await reader.read(write.path, write.encoding ?? "utf8");
    if (write.content === null) assert.equal(recovered, null, `published deletion must survive for ${write.path}`);
    else assert.equal(recovered?.content, write.content, `published bytes must survive for ${write.path}`);
  }
}

test("composed legacy import preserves disabled data and reactivates after a full Core data-root replacement", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-p12-migration-"));
  const sourceRoot = path.join(temporary, "legacy-project");
  const workspaceRoot = path.join(temporary, "legacy-data");
  const targetDataDir = path.join(temporary, "core-data");
  const databases = [];
  try {
    const { remote } = await makeLegacyRepository(temporary);
    await fs.mkdir(workspaceRoot, { recursive: true });
    databases.push(...await addLegacyDatabases(sourceRoot, workspaceRoot));
    const { jobsStateBytes, recentActivityBytes } = await addLegacyFiles(sourceRoot, workspaceRoot);

    const sourceBefore = await treeState(sourceRoot);
    const workspaceBefore = await treeState(workspaceRoot);
    const observedModuleSets = [];
    const registry = createComposedRegistry(observedModuleSets);
    const core = new CoreStore({ dataDir: targetDataDir, allowLocalRemotes: true });
    const project = await core.registerProject({ url: remote });
    const reader = await core.reader(project.id);
    const identity = reader.snapshot.repository;
    const disabled = await inspect(core, project.id, sourceRoot, workspaceRoot, registry, reader, [], identity);
    assert.deepEqual(observedModuleSets.at(-1), [], "the first pass keeps every module disabled");
    assert.equal(disabled.pendingWorkspace.pendingCommitCount, 1, "the local commit must be included in migration review");
    assert.ok(disabled.pendingWorkspace.stagedPaths.includes("story/scene.md"));
    assert.ok(disabled.pendingWorkspace.stagedPaths.includes("notes/staged-add.md"),
      "the staged Git addition must remain visible in the migration review");

    const disabledWrites = writesOf(disabled);
    const disabledByPath = new Map(disabledWrites.map((write) => [write.path, write]));
    assert.equal(disabledByPath.get("notes/from-unpublished-commit.md")?.content,
      "A committed local note that has not reached the remote.\n",
      "the unpublished local commit must become a reviewable file operation");
    assert.equal(disabledByPath.get("notes/staged-add.md")?.content, "A staged local addition.\n");
    assert.equal(disabledByPath.get("notes/author-note.md")?.content, null,
      "staged local deletions must be carried into the reviewed import");
    assert.equal(disabledByPath.get("story/scene.md")?.content, "staged author version\n");
    assert.equal(disabledByPath.get("notes/story-clue.md")?.content,
      "This fictional note uses the word secret as part of its plot.\n",
      "credential filtering must not scan manuscript or note bodies");
    assert.equal(disabledByPath.get(SPEAKER_OVERRIDE_SCENE_PATH)?.content, SPEAKER_OVERRIDE_SCENE,
      "the pending local commit must carry exact canonical YAML bytes containing the stable manual Speaker override");
    assert.ok(disabled.entries.some((entry) => entry.source === SPEAKER_OVERRIDE_SCENE_PATH &&
      entry.target === SPEAKER_OVERRIDE_SCENE_PATH && entry.category === "provisional" && entry.disposition === "planned"),
    "the existing pending-Git producer must expose the scene-level override as a reviewable operation");
    for (const target of [
      "meta/scriptorium/modules/speaker/legacy/files/meta/speaker-corrections.jsonl",
      "meta/scriptorium/modules/speaker/legacy/files/meta/speaker-model.json",
      "meta/scriptorium/modules/nlp/legacy/files/meta/synonyms.yaml",
      "meta/scriptorium/modules/semantic/legacy/files/meta/contradiction-dismissals.jsonl",
      "meta/scriptorium/modules/diagnostics/legacy/files/meta/lint-rules.yaml",
      "meta/scriptorium/modules/assistant/legacy/files/.arcadia/llm-model-settings.json",
      "meta/scriptorium/modules/story/legacy/files/.arcadia/change-sets/applied.json",
      "meta/scriptorium/modules/story/legacy/files/.arcadia/change-sets/pending.json",
      "meta/scriptorium/modules/story/legacy/files/.arcadia/snapshots/scene-before.md",
      "meta/scriptorium/modules/story/legacy/files/meta/scratch/idea-stable.md",
      "meta/scriptorium/modules/story/legacy/files/meta/scratch/files/idea-stable/diagram.bin",
      "meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl",
      "meta/scriptorium/modules/story/legacy/sqlite/workspace-index/zukan_suggestions.jsonl",
      "meta/scriptorium/modules/publishing/legacy/files/.arcadia/cover.jpg",
      "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl",
    ]) assert.ok(disabledByPath.has(target), `disabled modules must retain opaque state at ${target}`);

    for (const moduleOwnedSource of [
      "meta/synonyms.yaml",
      "meta/candidate-ignore-list.yaml",
      "meta/publish-episodes.yaml",
      "meta/lint-rules.yaml",
      "meta/tone-lexicon.yaml",
      "meta/plot-lexicon.yaml",
    ]) {
      assert.ok(!disabledByPath.has(`meta/scriptorium/modules/story/legacy/files/${moduleOwnedSource}`),
        `${moduleOwnedSource} must have one semantic module owner while Story is disabled`);
    }

    assert.ok(disabled.entries.some((entry) => entry.source === "meta/speaker-corrections.jsonl" && entry.disposition === "preserved-unreadable"));
    assert.ok(disabled.entries.some((entry) => entry.source === "app-state/share-tokens.json" && entry.disposition === "preserved-unreadable"));
    const legacyJobsEntry = disabled.entries.find((entry) => entry.source === "app-state/jobs-state.json");
    assert.equal(legacyJobsEntry?.category, "authoritative");
    assert.equal(legacyJobsEntry?.disposition, "relocated");
    assert.equal(legacyJobsEntry?.target, `/history/jobs/legacy/${hash(jobsStateBytes)}.json`);
    assert.match(legacyJobsEntry?.detail ?? "", /API-owned legacy job import hook/u,
      "the generic Core plan must distinguish private host history from data it actually preserves");
    const legacyRecentActivityEntry = disabled.entries.find((entry) => entry.source === "app-state/recent-activity.json");
    assert.equal(legacyRecentActivityEntry?.category, "authoritative");
    assert.equal(legacyRecentActivityEntry?.disposition, "relocated");
    assert.equal(legacyRecentActivityEntry?.target, `/history/recent-activity/legacy/${hash(recentActivityBytes)}.json`);
    assert.match(legacyRecentActivityEntry?.detail ?? "", /API-owned recent-activity import hook/u,
      "the Core review report must identify the explicit private archive import required before source removal");
    assert.ok(disabled.entries.some((entry) => entry.source === ".arcadia/index.sqlite#state_proposals" && entry.category === "provisional" && entry.disposition === "preserved-unreadable"));
    assert.ok(disabled.entries.some((entry) => entry.source === ".arcadia/llm-cache/summary.json" && entry.category === "derived" && entry.disposition === "rebuild"));
    assert.ok(disabled.entries.some((entry) => entry.source === ".npmrc" && entry.category === "secret" && entry.disposition === "excluded"));
    assert.ok(disabled.entries.some((entry) => entry.source === ".ssh/id_ed25519" && entry.category === "secret" && entry.disposition === "excluded"));
    assert.ok(disabled.recovery.some((record) => recoveryText(record).includes("pending-changeset-stable")));
    assert.ok(!disabledWrites.some((write) => /^meta\/scriptorium\/modules\/(?:story|diagnostics|nlp|semantic|speaker|assistant|publishing)\/(?!legacy\/)/u.test(write.path)),
      "disabled modules must not receive canonical state writes");
    assert.ok(!JSON.stringify(disabled).includes("DO_NOT_EXPORT_"), "secret and derived sentinel bytes must not enter the import plan");
    assert.ok(!JSON.stringify(disabled).includes("DO_NOT_PUBLISH_"), "derived index rows must never enter the import plan");
    assert.ok(!JSON.stringify(disabled).includes("sc-cursor-"), "private reader cursors must stay outside repository import operations");
    assert.ok(!JSON.stringify(disabled).includes("DO_NOT_PUBLISH_CURSOR_EXTENSION"),
      "unknown host cursor fields must stay outside repository import operations");
    assert.ok(!JSON.stringify(disabled).includes("DO_NOT_PUBLISH_RAW_CURSOR_EXTENSION"),
      "unknown host source fields must stay outside repository import operations");

    const projectRows = disabledByPath.get("meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl").content;
    const workspaceRows = disabledByPath.get("meta/scriptorium/modules/story/legacy/sqlite/workspace-index/state_proposals.jsonl").content;
    const disabledGrants = disabledByPath.get("meta/scriptorium/modules/publishing/legacy/share-grants.jsonl").content;
    assert.ok(!disabledGrants.includes("foreign-share-grant"), "grants for other projects are outside the explicit import scope");
    assert.ok(projectRows.includes("state-project-pending"));
    assert.ok(projectRows.includes('"vendor_extension":"unknown-state:state-project-approved"'));
    assert.ok(workspaceRows.includes("state-workspace-stale"));
    assert.ok(!projectRows.includes("api_token") && !projectRows.includes("DO_NOT_EXPORT_SQLITE_SECRET"));
    assert.ok(!workspaceRows.includes("DO_NOT_EXPORT_SQLITE_SECRET"));
    assert.ok(!JSON.stringify(disabled).includes("job-mapped-stable"), "private job results must stay outside repository operations");
    for (const binaryPath of [
      "meta/scriptorium/modules/story/legacy/files/.arcadia/snapshots/attachments/diagram.bin",
      "meta/scriptorium/modules/publishing/legacy/files/.arcadia/cover.jpg",
    ]) assert.equal(disabledByPath.get(binaryPath)?.encoding, "base64", `${binaryPath} must use the contract base64 encoding`);

    const repeatedDisabled = await inspect(core, project.id, sourceRoot, workspaceRoot, registry, reader, [], identity);
    assert.deepEqual(repeatedDisabled.operations.map((operation) => operation.id), disabled.operations.map((operation) => operation.id),
      "the disabled import plan must have stable operation identities");
    assert.deepEqual(await treeState(sourceRoot), sourceBefore, "read-only inspection must not change the legacy project or SQLite WAL files");
    assert.deepEqual(await treeState(workspaceRoot), workspaceBefore, "read-only inspection must not change workspace stores or SQLite WAL files");

    const disabledPublishedReader = await approveCheckpointPublish(core, project.id, disabled, "p12-disabled-legacy-preservation");
    await assertPublishedWrites(disabledPublishedReader, disabledWrites);
    assert.equal((await disabledPublishedReader.read(SPEAKER_OVERRIDE_SCENE_PATH))?.content, SPEAKER_OVERRIDE_SCENE,
      "the manual scene override must survive the first confirmed publication byte-for-byte");

    const usageDirectory = path.join(temporary, "host-history");
    const apiToken = "synthetic-p12-owner-token-with-32-bytes";
    const jobImport = await importLegacyJobHistory({
      workspaceDataRoot: workspaceRoot,
      usageDirectory,
      legacyRepositoryMappings: { "legacy-project-id": identity },
      legacyUserMappings: { "legacy-user": "owner" },
    });
    assert.equal(jobImport.sourceHash, hash(jobsStateBytes));
    assert.equal(jobImport.bytes, jobsStateBytes.byteLength);
    assert.equal(jobImport.archived, true);
    assert.equal(jobImport.adoptedJobs, 1);
    assert.equal(jobImport.adoptedInbox, 1);
    assert.deepEqual(jobImport.mappingRequired, [
      { projectKey: "legacy-project-id", userId: null, jobCount: 1, inboxCount: 1 },
    ]);
    assert.ok(!JSON.stringify(jobImport).includes("Synthetic private unmapped failure"));
    const privateJobArchive = path.join(usageDirectory, "jobs", "legacy", `${jobImport.sourceHash}.json`);
    assert.deepEqual(await fs.readFile(privateJobArchive), jobsStateBytes, "the exact source bytes must be retained in the host-private archive");
    assert.ok((await fs.readFile(privateJobArchive)).includes("Synthetic private unmapped failure"),
      "unmapped result/error and inbox content remains recoverable only in the private immutable archive");
    assert.equal((await fs.stat(privateJobArchive)).mode & 0o077, 0, "the private recovery archive must not be group/world accessible");
    for (const directory of [usageDirectory, path.join(usageDirectory, "jobs"), path.join(usageDirectory, "jobs", "legacy")]) {
      assert.equal((await fs.stat(directory)).mode & 0o077, 0, `${directory} must be private host storage`);
    }
    const repeatedJobImport = await importLegacyJobHistory({
      workspaceDataRoot: workspaceRoot,
      usageDirectory,
      legacyRepositoryMappings: { "legacy-project-id": identity },
      legacyUserMappings: { "legacy-user": "owner" },
    });
    assert.equal(repeatedJobImport.sourceHash, jobImport.sourceHash, "job archive import identity must be deterministic");
    assert.deepEqual(await fs.readFile(privateJobArchive), jobsStateBytes, "repeated job import must not overwrite the immutable archive");

    const recentActivityImport = await importLegacyRecentActivity({
      workspaceDataRoot: workspaceRoot,
      usageDirectory,
      legacyRepositoryMappings: { "legacy-project-id": identity },
      legacyUserMappings: { "legacy-user": "owner" },
    });
    assert.equal(recentActivityImport.sourceHash, hash(recentActivityBytes));
    assert.equal(recentActivityImport.bytes, recentActivityBytes.byteLength);
    assert.equal(recentActivityImport.archived, true);
    assert.equal(recentActivityImport.adoptedItems, 2, "both explicitly mapped device cursors should enter owner history");
    assert.equal(recentActivityImport.preservedNewerItems, 0);
    assert.ok(recentActivityImport.mappingRequired.some((row) => row.userId === "unmapped-user" && row.projectKey === "legacy-project-id" && row.itemCount === 1));
    assert.ok(recentActivityImport.mappingRequired.some((row) => row.userId === "legacy-user" && row.projectKey === "foreign-project-id" && row.itemCount === 1));
    assert.ok(!JSON.stringify(recentActivityImport).includes("sc-cursor-"), "the migration report must not expose cursor rows");
    assert.ok(!JSON.stringify(recentActivityImport).includes("DO_NOT_PUBLISH_CURSOR_EXTENSION"),
      "unknown legacy fields must stay in the private raw archive, not the report");
    assert.ok(!JSON.stringify(recentActivityImport).includes("DO_NOT_PUBLISH_RAW_CURSOR_EXTENSION"));
    const privateRecentActivityArchive = path.join(usageDirectory, "recent-activity", "legacy", `${recentActivityImport.sourceHash}.json`);
    const recentActivityArchiveBytes = await fs.readFile(privateRecentActivityArchive);
    assert.deepEqual(recentActivityArchiveBytes, recentActivityBytes,
      "the private host archive must preserve the exact source bytes including unknown fields and unmapped rows");
    assert.ok(recentActivityArchiveBytes.includes("DO_NOT_PUBLISH_CURSOR_EXTENSION"));
    assert.ok(recentActivityArchiveBytes.includes("DO_NOT_PUBLISH_RAW_CURSOR_EXTENSION"));
    assert.equal((await fs.stat(privateRecentActivityArchive)).mode & 0o077, 0, "the cursor archive must be private host storage");
    for (const directory of [usageDirectory, path.join(usageDirectory, "recent-activity"), path.join(usageDirectory, "recent-activity", "legacy")]) {
      assert.equal((await fs.stat(directory)).mode & 0o077, 0, `${directory} must be private host storage`);
    }
    const repeatedRecentActivityImport = await importLegacyRecentActivity({
      workspaceDataRoot: workspaceRoot,
      usageDirectory,
      legacyRepositoryMappings: { "legacy-project-id": identity },
      legacyUserMappings: { "legacy-user": "owner" },
    });
    assert.equal(repeatedRecentActivityImport.sourceHash, recentActivityImport.sourceHash,
      "recent activity archive identity must be deterministic");
    assert.deepEqual(await fs.readFile(privateRecentActivityArchive), recentActivityBytes,
      "repeated recent activity import must not overwrite the immutable source archive");
    assert.deepEqual(await treeState(workspaceRoot), workspaceBefore, "private host history imports must leave the source workspace untouched");

    for (const database of databases) database.close();
    databases.length = 0;

    await fs.rm(targetDataDir, { recursive: true, force: true });
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.mkdir(sourceRoot, { recursive: true });

    const replacement = new CoreStore({ dataDir: targetDataDir, allowLocalRemotes: true });
    const restoredProject = await replacement.registerProject({ url: remote });
    const restoredReader = await replacement.reader(restoredProject.id);
    const restoredIdentity = restoredReader.snapshot.repository;
    assert.equal(restoredIdentity.repositoryId, identity.repositoryId);
    assert.equal((await restoredReader.read(SPEAKER_OVERRIDE_SCENE_PATH))?.content, SPEAKER_OVERRIDE_SCENE,
      "the manual scene override must survive full Core data-root loss and a fresh clone");

    await withOwnerApi(replacement, apiToken, temporary, usageDirectory, async ({ base, headers }) => {
      const activityPath = `${base}/api/projects/${restoredProject.id}/recent-activity`;
      assert.equal((await fetch(activityPath)).status, 403, "recent activity must remain owner-cookie private");
      const response = await fetch(activityPath, { headers });
      assert.equal(response.status, 200);
      const activity = await response.json();
      assert.equal(activity.items.length, 2, "repeated import must not duplicate either device cursor");
      const byDevice = Object.fromEntries(activity.items.map((item) => [item.deviceType, item]));
      assert.deepEqual(Object.keys(byDevice).sort(), ["desktop", "mobile"],
        "the remapped owner/project sees only the two explicitly mapped device cursors");
      assert.deepEqual(
        { sceneId: byDevice.desktop.sceneId, sentenceOffset: byDevice.desktop.sentenceOffset, pageIndex: byDevice.desktop.pageIndex },
        { sceneId: "sc-cursor-desktop", sentenceOffset: 29, pageIndex: 4 },
      );
      assert.deepEqual(
        { sceneId: byDevice.mobile.sceneId, sentenceOffset: byDevice.mobile.sentenceOffset, pageIndex: byDevice.mobile.pageIndex },
        { sceneId: "sc-cursor-mobile", sentenceOffset: 11, pageIndex: 2 },
      );
      assert.ok(!JSON.stringify(activity).includes("unmapped-user"));
      assert.ok(!JSON.stringify(activity).includes("foreign-project-id"));
      assert.ok(!JSON.stringify(activity).includes("DO_NOT_PUBLISH_CURSOR_EXTENSION"),
        "the owner API must expose only validated cursor fields, not the raw legacy archive");
      assert.ok(!JSON.stringify(activity).includes("DO_NOT_PUBLISH_RAW_CURSOR_EXTENSION"));

      const liveUpdate = await fetch(activityPath, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ sceneId: "sc-cursor-desktop-live", sentenceOffset: 91, pageIndex: 8, deviceType: "desktop" }),
      });
      assert.equal(liveUpdate.status, 200);
      const liveBeforeReimport = await fetch(activityPath, { headers });
      const liveActivity = await liveBeforeReimport.json();
      const liveDesktop = liveActivity.items.find(({ deviceType }) => deviceType === "desktop");
      assert.equal(liveDesktop?.sceneId, "sc-cursor-desktop-live");

      const afterLiveImport = await importLegacyRecentActivity({
        workspaceDataRoot: workspaceRoot,
        usageDirectory,
        legacyRepositoryMappings: { "legacy-project-id": restoredIdentity },
        legacyUserMappings: { "legacy-user": "owner" },
      });
      assert.ok(afterLiveImport.preservedNewerItems >= 1,
        "re-import must report and preserve the newer live desktop cursor");
      assert.deepEqual(await fs.readFile(privateRecentActivityArchive), recentActivityBytes,
        "re-import after a newer live cursor must leave the raw archive immutable");
      assert.deepEqual(await treeState(workspaceRoot), workspaceBefore,
        "recent-activity import must never rewrite the source workspace file");
      const afterReimportResponse = await fetch(activityPath, { headers });
      assert.equal(afterReimportResponse.status, 200);
      const afterReimport = await afterReimportResponse.json();
      assert.equal(afterReimport.items.length, 2, "re-import after a newer live cursor must remain idempotent");
      const desktopAfterReimport = afterReimport.items.find(({ deviceType }) => deviceType === "desktop");
      const mobileAfterReimport = afterReimport.items.find(({ deviceType }) => deviceType === "mobile");
      assert.deepEqual(
        { sceneId: desktopAfterReimport?.sceneId, sentenceOffset: desktopAfterReimport?.sentenceOffset, pageIndex: desktopAfterReimport?.pageIndex },
        { sceneId: "sc-cursor-desktop-live", sentenceOffset: 91, pageIndex: 8 },
      );
      assert.equal(mobileAfterReimport?.sceneId, "sc-cursor-mobile");
    });

    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(workspaceRoot, { recursive: true });

    const enabled = await inspect(replacement, restoredProject.id, sourceRoot, workspaceRoot, registry, restoredReader, ALL_MODULES, restoredIdentity);
    assert.deepEqual(observedModuleSets.at(-1), ALL_MODULES.slice().sort(), "the second pass enables all eight installed modules");
    assert.equal((await restoredReader.read(SPEAKER_OVERRIDE_SCENE_PATH))?.content, SPEAKER_OVERRIDE_SCENE,
      "enabling modules must leave the canonical manual override unchanged");
    const enabledWrites = writesOf(enabled);
    const enabledByPath = new Map(enabledWrites.map((write) => [write.path, write]));
    for (const target of [
      "meta/scriptorium/modules/speaker/corrections.jsonl",
      "meta/scriptorium/modules/speaker/adopted-model.json",
      "meta/scriptorium/modules/nlp/synonyms.yaml",
      "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml",
      "meta/scriptorium/modules/nlp/feature-settings.json",
      "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl",
      "meta/scriptorium/modules/diagnostics/lint-rules.yaml",
      "meta/scriptorium/modules/diagnostics/tone-lexicon.yaml",
      "meta/scriptorium/modules/diagnostics/plot-lexicon.yaml",
      "meta/scriptorium/modules/assistant/model-settings.json",
      "meta/scriptorium/modules/assistant/usage.jsonl",
      "meta/scriptorium/modules/publishing/episodes.yaml",
      "meta/scriptorium/modules/publishing/share-grants.jsonl",
      "meta/scriptorium/modules/story/v1/series.json",
      "meta/scriptorium/modules/story/change-sets/applied.json",
      "meta/scriptorium/modules/story/local-snapshots/scene-before.md",
      "meta/scriptorium/modules/story/local-snapshots/attachments/diagram.bin",
      "meta/scriptorium/modules/story/state-proposals.jsonl",
      "meta/scriptorium/modules/story/zukan-suggestions.jsonl",
    ]) assert.ok(enabledByPath.has(target), `re-enabled module must produce reviewable canonical write ${target}`);
    for (const moduleOwnedSource of [
      "meta/synonyms.yaml",
      "meta/candidate-ignore-list.yaml",
      "meta/publish-episodes.yaml",
      "meta/lint-rules.yaml",
      "meta/tone-lexicon.yaml",
      "meta/plot-lexicon.yaml",
    ]) assert.ok(!enabledByPath.has(moduleOwnedSource), `${moduleOwnedSource} must not be re-imported as raw Story document data`);

    const stateProposals = enabledByPath.get("meta/scriptorium/modules/story/state-proposals.jsonl").content;
    const zukanSuggestions = enabledByPath.get("meta/scriptorium/modules/story/zukan-suggestions.jsonl").content;
    assert.ok(stateProposals.includes("state-project-approved") && stateProposals.includes("state-workspace-rejected"));
    assert.ok(stateProposals.includes("state-project-pending") && stateProposals.includes("state-workspace-stale"));
    assert.ok(stateProposals.includes('"vendor_extension":"unknown-state:state-project-approved"'));
    assert.ok(stateProposals.includes("project-arcadia") && stateProposals.includes("workspace-index"), "workflow rows retain database provenance");
    assert.ok(!stateProposals.includes("state-divergent"), "divergent workflow IDs must not be selected automatically");
    assert.ok(zukanSuggestions.includes("zukan-project-approved") && zukanSuggestions.includes("zukan-workspace-rejected"));
    assert.ok(zukanSuggestions.includes("zukan-project-pending") && zukanSuggestions.includes("zukan-workspace-stale"));
    assert.ok(zukanSuggestions.includes("project-arcadia") && zukanSuggestions.includes("workspace-index"), "suggestion rows retain database provenance");
    assert.ok(!zukanSuggestions.includes("zukan-divergent"), "divergent suggestion IDs must not be selected automatically");
    assert.ok(zukanSuggestions.includes('"plugin_payload":"unknown-suggestion:zukan-project-approved"'));
    assert.ok(!stateProposals.includes("api_token") && !stateProposals.includes("DO_NOT_EXPORT_SQLITE_SECRET"));
    assert.ok(!zukanSuggestions.includes("DO_NOT_EXPORT_SQLITE_SECRET"));
    assert.ok(enabled.recovery.some((record) => record.content.includes("state-divergent")), "divergent workflow versions remain available for review");
    assert.ok(enabled.recovery.some((record) => record.content.includes("zukan-divergent")), "divergent suggestion versions remain available for review");
    assert.ok(enabled.recovery.some((record) => recoveryText(record).includes("pending-changeset-stable")),
      "unaccepted ChangeSets remain recovery records after re-enable");
    assert.ok(!enabledByPath.has("meta/scriptorium/modules/story/change-sets/pending.json"), "pending ChangeSets must not become canonical Story history");

    for (const [target, expected] of [
      ["meta/scriptorium/modules/story/change-sets/applied.json", "{\"changeSet\":{\"id\":\"applied-changeset-stable\"},\"status\":\"applied\",\"unknownField\":{\"retain\":true}}\n"],
      ["meta/scriptorium/modules/story/local-snapshots/scene-before.md", "---\nauthor_note: preserve\n---\nSynthetic local snapshot\n"],
    ]) assert.equal(enabledByPath.get(target).content, expected, `Story recovery bytes must remain exact at ${target}`);
    assert.ok(enabled.entries.some((entry) =>
      entry.source === "meta/scriptorium/modules/story/legacy/files/meta/scratch/idea-stable.md" && entry.disposition === "unchanged"),
    "an exact scratch file already present in the remote must not produce a duplicate write");
    assert.equal(enabledByPath.get("meta/scriptorium/modules/story/local-snapshots/attachments/diagram.bin")?.encoding, "base64",
      "snapshot attachments must preserve binary encoding");

    const series = JSON.parse(enabledByPath.get("meta/scriptorium/modules/story/v1/series.json").content);
    assert.equal(series.series[0].bibleRepositoryId, restoredIdentity.repositoryId);
    assert.deepEqual(series.series[0].memberRepositoryIds, [restoredIdentity.repositoryId]);
    assert.equal(series.series[0].unknownField, "retain");
    assert.equal(series.bindings[0].repositoryId, restoredIdentity.repositoryId);
    assert.equal(series.bindings[0].unknownBinding, true);

    const grant = JSON.parse(enabledByPath.get("meta/scriptorium/modules/publishing/share-grants.jsonl").content.trim());
    assert.equal(grant.id, "share-grant-stable");
    assert.equal(grant.projectId, restoredIdentity.repositoryId);
    assert.equal(grant.tokenHash, "b".repeat(64));
    assert.ok(!JSON.stringify(grant).includes("synthetic-private-owner"));
    assert.ok(!JSON.stringify(grant).includes("DO_NOT_EXPORT_BEARER"));
    assert.ok(!enabledByPath.get("meta/scriptorium/modules/publishing/share-grants.jsonl").content.includes("foreign-share-grant"));
    assert.ok(!JSON.stringify(enabled).includes("DO_NOT_PUBLISH_"));

    const enabledPublishedReader = await approveCheckpointPublish(replacement, restoredProject.id, enabled, "p12-module-reactivation");
    await assertPublishedWrites(enabledPublishedReader, enabledWrites);
    assert.equal((await enabledPublishedReader.read(SPEAKER_OVERRIDE_SCENE_PATH))?.content, SPEAKER_OVERRIDE_SCENE,
      "the manual scene override must remain exact after the reactivation publication");
    const secondDataDir = targetDataDir;
    await fs.rm(secondDataDir, { recursive: true, force: true });
    const finalCore = new CoreStore({ dataDir: secondDataDir, allowLocalRemotes: true });
    const finalProject = await finalCore.registerProject({ url: remote });
    const finalReader = await finalCore.reader(finalProject.id);
    await assertPublishedWrites(finalReader, disabledWrites);
    await assertPublishedWrites(finalReader, enabledWrites);
    assert.equal((await finalReader.read(SPEAKER_OVERRIDE_SCENE_PATH))?.content, SPEAKER_OVERRIDE_SCENE,
      "the manual scene override must survive the second complete Core data-root replacement");
    const allPaths = await finalReader.list("");
    assert.ok(allPaths.includes("meta/scriptorium/modules/story/state-proposals.jsonl"));
    assert.ok(allPaths.includes("meta/scriptorium/modules/story/zukan-suggestions.jsonl"));
    assert.ok(allPaths.includes("meta/scriptorium/modules/story/change-sets/applied.json"));
    assert.ok(allPaths.includes("meta/scriptorium/modules/story/local-snapshots/attachments/diagram.bin"));
    assert.ok(allPaths.includes("meta/scratch/files/idea-stable/diagram.bin"));
    assert.ok(allPaths.includes("meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl"));
    assert.ok(allPaths.includes("notes/from-unpublished-commit.md"));
    assert.ok(allPaths.includes("notes/staged-add.md"));
    assert.ok(allPaths.includes("notes/story-clue.md"));
    assert.ok(!allPaths.includes("notes/author-note.md"));
    assert.ok(!allPaths.some((file) => /scene_state_events|reader_knowledge_events|private_tokens/u.test(file)));
    assert.ok(!allPaths.includes(".npmrc") && !allPaths.includes(".ssh/id_ed25519"));
    assert.ok(!allPaths.some((file) => /recent-activity|sc-cursor/u.test(file)),
      "private cross-device cursor state must never be published to repository Git");

    const finalState = (await finalReader.read("meta/scriptorium/modules/story/state-proposals.jsonl")).content;
    assert.equal(finalState, stateProposals, "canonical workflow IDs and rows survive a second complete Core data-root replacement");
    const finalGrant = (await finalReader.read("meta/scriptorium/modules/publishing/share-grants.jsonl")).content;
    assert.equal(finalGrant, enabledByPath.get("meta/scriptorium/modules/publishing/share-grants.jsonl").content);
    assert.equal((await finalReader.read("meta/scratch/idea-stable.md")).content, "A synthetic published scratch note.\n");
    assert.equal((await finalReader.read("meta/scratch/files/idea-stable/diagram.bin", "base64")).content,
      Buffer.from([7, 0, 249, 33]).toString("base64"));
    assert.equal((await finalReader.read("notes/from-unpublished-commit.md")).content,
      "A committed local note that has not reached the remote.\n");
    const afterRecovery = await inspect(finalCore, finalProject.id, sourceRoot, workspaceRoot, registry, finalReader, ALL_MODULES, finalReader.snapshot.repository);
    assert.deepEqual(afterRecovery.operations, [], "the enabled semantic migration is idempotent after clone recovery");

    const api = createApiServer({ store: finalCore, authToken: apiToken, staticDir: temporary, usageDirectory });
    await new Promise((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = api.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ token: apiToken }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const headers = { Cookie: cookie };
      const jobsResponse = await fetch(`${base}/api/jobs`, { headers });
      assert.equal(jobsResponse.status, 200);
      const jobs = await jobsResponse.json();
      assert.deepEqual(jobs.map(({ id }) => id), ["job-mapped-stable"], "only rows with both explicit source mappings are owner-readable");
      const jobResponse = await fetch(`${base}/api/jobs/job-mapped-stable`, { headers });
      assert.equal(jobResponse.status, 200);
      const mappedJob = await jobResponse.json();
      assert.deepEqual(mappedJob.result, { summary: "Synthetic author review", findings: [{ id: "finding-stable", text: "A mapped result." }] });
      assert.equal((await fetch(`${base}/api/jobs/job-unmapped-stable`, { headers })).status, 404);
      const inboxResponse = await fetch(`${base}/api/inbox`, { headers });
      assert.equal(inboxResponse.status, 200);
      const inbox = await inboxResponse.json();
      assert.deepEqual(inbox.items.map(({ id }) => id), ["inbox-mapped-stable"]);
      assert.equal(inbox.items[0].body, "Mapped result details retained.");
      assert.ok(!JSON.stringify({ jobs, inbox }).includes("Unmapped details stay private."));
      assert.deepEqual(await fs.readFile(privateJobArchive), jobsStateBytes, "owner-readable adoption must not alter the exact private source archive");

      const activityPath = `${base}/api/projects/${finalProject.id}/recent-activity`;
      assert.equal((await fetch(activityPath)).status, 403, "recent activity must remain owner-cookie private after the second clone");
      const activityResponse = await fetch(activityPath, { headers });
      assert.equal(activityResponse.status, 200);
      const activity = await activityResponse.json();
      const desktop = activity.items.find(({ deviceType }) => deviceType === "desktop");
      const mobile = activity.items.find(({ deviceType }) => deviceType === "mobile");
      assert.deepEqual(
        { sceneId: desktop?.sceneId, sentenceOffset: desktop?.sentenceOffset, pageIndex: desktop?.pageIndex },
        { sceneId: "sc-cursor-desktop-live", sentenceOffset: 91, pageIndex: 8 },
        "the host-private live cursor must survive the second full Core data-root replacement",
      );
      assert.deepEqual(
        { sceneId: mobile?.sceneId, sentenceOffset: mobile?.sentenceOffset, pageIndex: mobile?.pageIndex },
        { sceneId: "sc-cursor-mobile", sentenceOffset: 11, pageIndex: 2 },
      );
      assert.ok(!JSON.stringify(activity).includes("unmapped-user"));
      assert.ok(!JSON.stringify(activity).includes("foreign-project-id"));
      assert.ok(!JSON.stringify(activity).includes("DO_NOT_PUBLISH_CURSOR_EXTENSION"));
      assert.ok(!JSON.stringify(activity).includes("DO_NOT_PUBLISH_RAW_CURSOR_EXTENSION"));
      assert.deepEqual(await fs.readFile(privateRecentActivityArchive), recentActivityBytes,
        "the exact private source archive must survive both Core data-root replacements unchanged");
    } finally {
      await new Promise((resolveClose, rejectClose) => api.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  } finally {
    for (const database of databases) database.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
