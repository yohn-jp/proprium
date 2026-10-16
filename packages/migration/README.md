# `@scriptorium/migration`

This package inspects an explicitly selected legacy project and workspace data root, then returns a deterministic, reviewable `ChangeOperation[]`. Inspection does not write to the legacy project, Git history, SQLite databases, or target snapshot. The returned operations are proposals for the normal author review flow; they do not approve, checkpoint, or publish changes.

## Public API

```ts
import {
  inspectLegacyProject,
  proposeMigrationImport,
} from "@scriptorium/migration";

const inspection = await inspectLegacyProject({
  sourceRoot: "/data/legacy/project",
  workspaceDataRoot: "/data/legacy-workspace", // optional and explicit
  workspaceProjectId: "legacy-project-id",     // selects project-owned workspace records
  legacyRepositoryMappings: {
    "legacy-project-id": (await coordinator.observe("target-project")).snapshot.repository,
  }, // only host-verified legacy ID -> repository mappings
  target: await coordinator.reader("target-project"),
  enabledModules: ["story", "speaker", "nlp"], // omitted means all contract modules
});

// Display `entries`, `recovery`, and the proposed writes for author review.
await proposeMigrationImport(coordinator, "target-project", inspection);
// Approval, checkpoint and publication stay in the host's normal author flow.
```

`inspectLegacyProject` returns the base snapshot, categorized `entries`, guarded operations, provisional `recovery` records, and pending Git state. A target path that already contains different content is reported as a conflict rather than overwritten. Generic SQLite preservation keeps each database's recognized Story rows in a separate opaque snapshot; the Story migration producer owns ID reconciliation and semantic conversion.

Modules can register domain-owned migration producers when composing the generic registry. The host resolves mappings from explicit legacy project URLs to already registered repository identities; import inspection never guesses a local project UUID or fetches a repository with credentials.

```ts
import {
  createMigrationProducerRegistry,
  registerMigrationProducer,
} from "@scriptorium/migration";

const registry = createMigrationProducerRegistry();
registerMigrationProducer(registry, {
  id: "story-v1",
  moduleId: "story",
  async inspect(context) {
    // Read only through context.source / context.target and return operations.
    return { entries: [], operations: [], recovery: [] };
  },
});

const inspection = await inspectLegacyProject({
  sourceRoot: "/data/legacy/project",
  target: await coordinator.reader("target-project"),
  registry,
});
```

The producer owns its source classification and must preserve stable IDs and unknown data. A disabled module's generic records are copied under `meta/scriptorium/modules/<module-id>/legacy/` with disposition `preserved-unreadable`; they are not imported to the module's canonical readable paths. The owning module migration must consume that namespace when enabled. This generic package does not claim semantic conversion of every module's opaque legacy records; final composition belongs to P12.

## Generic source coverage

| Legacy source | Classification and target |
| --- | --- |
| `meta/speaker-corrections.jsonl`, `meta/speaker-model.json` | Authoritative speaker inputs, including human corrections and adopted model parameters. |
| `meta/synonyms.yaml`, `meta/candidate-ignore-list.yaml` | Authoritative NLP dictionary and user overrides. Exact bytes are retained, including unknown YAML fields. |
| `meta/contradiction-dismissals.jsonl` | Authoritative author dismissals. |
| `meta/publish-episodes.yaml`, `.arcadia/cover.jpg` | Authoritative publication metadata and cover bytes. |
| `.arcadia/llm-model-settings.json`, `.arcadia/nlp-feature-settings.json`, `.arcadia/llm-usage.jsonl` | Non-secret model selection, feature privacy settings, and historical usage. Secret-like files and credentials are excluded. |
| `.arcadia/change-sets/*.json` | Applied, partially applied, and rejected stable-ID history is retained. Pending records stay in same-origin recovery; disabled story records are also preserved opaquely. |
| `.arcadia/snapshots/**` | Local scratch snapshots and attachments retain relative paths and bytes. Binary payloads use the contract's base64 encoding. |
| `.arcadia/index.sqlite` and `<workspaceDataRoot>/index/<project-basename>/index.sqlite` | Both stores are inspected read-only. Every non-secret `state_proposals` and `zukan_suggestions` row, including every workflow status and unknown non-secret column, is copied to `meta/scriptorium/modules/story/legacy/sqlite/{project-arcadia,workspace-index}/<table>.jsonl`. The generic producer reports semantic conversion as deferred and writes no canonical Story records; the registered Story producer owns status interpretation, ID reconciliation, and author review of divergent IDs. Credential-like columns are redacted and named in the report without exposing values. |
| SQLite derived tables such as `entities`, `links`, `scene_state_events`, `reader_knowledge_events`, embeddings, and fingerprints | Reported as derived/rebuild-only; row contents are not imported. Tables with secret-like names or columns are excluded without reading rows. Unknown tables are reported unclassified and left untouched. |
| Pending Git commits and worktree changes | Final file contents/deletions are represented as provisional guarded operations; credential-like paths are excluded. Git history and the old checkout remain intact. |
| Explicit workspace `app-state` stores | Share grant descriptors are selected by the supplied legacy project ID; only hashed, non-owner descriptors are migrated. Story owns `app-state/series.json` and its root alias using the verified mapping; host project/user/session/token records remain host-owned or excluded. |

All roots are caller-supplied; the package never scans the user's home directory or infers a data root from environment variables. Filesystem symlinks are not followed or copied. Git credential filtering is path-only and runs before reading file contents; it covers common SSH private-key names, `.npmrc`, Git credential files, and conventional AWS, gcloud, GitHub CLI, Azure, Docker, and Kubernetes credential stores. Manuscript and note bodies are not scanned for secret-like text. SQLite databases and any WAL/SHM sidecars are copied to a temporary directory and opened read-only there. Git status disables optional index refreshes so the source checkout metadata remains unchanged.

The migration package uses the Node 24 built-in `node:sqlite` API and the host Git executable. It adds no SQLite or Git library dependency.

## Real Core persistence-boundary check

Build the packages and run the integration test with:

```sh
pnpm --filter @scriptorium/contracts build
pnpm --filter @scriptorium/core build
pnpm --filter @scriptorium/migration build
node --test packages/migration/tests/import-recovery.mjs
```

This test creates synthetic legacy Git, SQLite, workspace, settings, dictionary, scratch, binary-asset, and grant data. It inspects through the producer registry, submits the plan to `CoreStore`, approves and checkpoints the operations, pushes to a real local bare Git remote, deletes the full Core data directory, and verifies the imported bytes and stable IDs from a fresh clone. It also verifies source-tree metadata and bytes remain unchanged and that a repeated import produces no writes. The generic SQLite copy is physical record preservation only; final module semantics and recovery-journal composition remain P12 work. Target paths that Core refuses to read safely (including a symlink replacement) stay explicitly blocked for author review while unrelated Git changes remain importable.
