# Scriptorium — Full migration architecture

Status: accepted execution contract for Epic #7 by the owner’s 2026-10-17 campaign dispatch. Implementation and acceptance progress are tracked separately in `docs/migration/CAMPAIGN.json`; this architecture alone claims no runtime verification. The latest explicit owner instructions take precedence.

Companion: [execution and coverage plan](../migration/FULL-MIGRATION-PLAN.md).

## 1. Baseline and scope

Inspected target: `01403182e9f73dec29d04954e3091c235cd1aac0`.
Inspected source: `yohn-jp/arcadia-loom@edc033c2c9466274a334299dadfa426661d957d9`.

The target currently has a compact TypeScript Core, Node HTTP API and vanilla browser app. `saveScene` creates a local commit; `sync` fetches and pushes separately. `status`/`statusUnlocked` use cached remote-tracking refs rather than fetching. The browser removes an acknowledged draft after local saving while preserving newer typing. These are MVP semantics, not proof of the new durability/freshness contract.

The source already contains React UI, resource routers, story models, local NLP, ONNX inference, TypeScript speaker training, export and two MCP transports. Its latest merge explicitly records incomplete MCP mutation migration and later planned UI work. A source declaration, menu, placeholder or old passing test is not proof of a functioning capability.

Full migration means every implemented, reachable writing capability has a target owner, a data disposition and executable acceptance evidence. It does not mean copying the old monolith or implementing everything mentioned in its roadmap. Only the explicit exclusions in the coverage plan are excluded. Broken glue for an otherwise implemented capability is repaired within its owning migration task, not used as an excuse to discard the capability.

Arcadia Loom and Arcadia Platform remain read-only sources. No private manuscripts, corpus-specific defaults, Git ancestry, credentials, model cache or unlicensed assets enter this public repository.

## 2. Selected implementation structure

Retain TypeScript and Node 24 with the target pnpm toolchain/lockfile. Reuse existing algorithms and safety primitives. Do not introduce Python, Go or Rust merely because a subsystem is called NLP. The source speaker retraining runner is TypeScript; existing inference already uses native/WASM engines. No new language is required by the inspected capabilities.

Restore the source's React/Vite UI approach selectively instead of rewriting its feature components into the MVP's vanilla DOM shell. Keep a single final UI, not two parallel applications. Carry Japanese manuscript typography, ruby, reading/vertical modes, draft safety and accessible mobile paths into it. Source graph, model and provider packages must not become unconditional browser dependencies.

Use the existing source Fastify approach for the expanded HTTP composition layer, while retaining Scriptorium's hardened Git/file services. Extract reusable handlers, not the old global `ApiDeps`/`ArcadiaCore` wiring. This is an explicit change from the MVP transport structure; preserve current authentication, error, path and save tests through the transition. Framework restoration does not mean restoring a model-heavy Core.

Proposed ownership directories (no empty future packages):

- `packages/contracts/src/`: transport-neutral revision, operation, snapshot, module and result schemas. No React, filesystem, model or provider imports.
- `packages/core/src/repository/`: GitHub repository identity/default branch, constrained Git execution, clone and immutable snapshot access.
- `packages/core/src/sync/`: remote observation, checkpoint reconciliation and publish acknowledgement.
- `packages/core/src/changes/`: validated multi-file operations, author approval and project mutation coordination.
- `packages/core/src/documents/`: manuscript/hierarchy reading and preservation of unknown metadata.
- `packages/module-runtime/src/`: trusted installed-module composition, capabilities, lifecycle and bounded worker supervision.
- `packages/api/src/`: authentication adapters, common HTTP/streaming transport and composition root, not feature implementations.
- `app/src/`: React shell, editor, IndexedDB recovery, shared accessible primitives and contribution hosts.
- `modules/{story,diagnostics,nlp,semantic,speaker,assistant,publishing,mcp}/`: independent workspace packages with explicit browser/server/worker entry points as needed.
- `profiles/`: bounded `core` and `full` composition manifests; generated build entry points and production dependency closure.

Module code imports public contracts/capability ports, not `packages/core/src/*`. Runtime composition alone selects implementations. No circular dependency between module host and individual modules. Story-domain schemas belong to story; Core does not import every possible narrative entity merely to make optional plugins compile.

## 3. Three distinct durability states

The UI uses distinct labels: Draft, Checkpoint (local commit), and Saved to GitHub (confirmed push). Neither a successful file write nor a local commit implies durable remote saving.

### Browser recovery journal

Before a checkpoint request, persist an IndexedDB transaction containing:

- version, operation ID, client edit generation and author identity scope;
- GitHub repository numeric identity, default branch and stable document identity/path;
- base remote commit and per-file preconditions;
- complete recoverable payload for all affected files/metadata, including create/delete operations and small binary assets;
- checkpoint receipt when available, publication batch ID and acknowledgement state.

Keys must not depend on a container ID or the MVP's randomly regenerated project registry ID. The stable application origin is required for the same browser to recover its storage. Server-side code does not pretend a newly assigned origin can access old IndexedDB.

A journal transaction failure/quota error is visible. Never label an unjournaled local checkpoint as browser-recoverable. Request persistent browser storage where available, but do not describe it as guaranteed backup. No independent offline product is added: GitHub availability is the normal operating assumption, with honest failed/unknown outcomes for transient requests.

Local commit acknowledgement retains the journal. Push acknowledgement clears only the exact acknowledged operation IDs/edit generations; later typing survives an older response. Closed tabs and container replacement must not erase previously journaled unsaved work. Unaccepted AI suggestions are provisional browser records, not remotely saved author text.

### Checkpoint

Validate the operation under the repository writer coordinator and create a local Git commit. Return operation ID, local commit identity, remote base identity and resulting file revisions. The operation ID is stable through replay; a rebuilt checkpoint may have a different commit SHA. No per-container branch is created on GitHub.

All author-approved writes, including plugin edits to settings, overrides, scene structure and dictionaries, use this same checkpoint path. A plugin cannot save irreversible project state through its own filesystem or database writer.

### Publish

The explicit Save-to-GitHub action publishes the selected project checkpoint queue as a bounded batch. It fetches, validates/reconciles, performs a normal non-force push, and verifies the pushed commit is reachable from the freshly fetched remote branch. HEAD equality alone is wrong when a later legitimate commit already followed ours.

Use stable operation IDs in commit metadata and retain the acknowledged batch receipt in the browser. After a lost response, inspect the remote's reachable operation IDs and commit/file identities before replaying. A local receipt database is not sufficient across container replacement. An ambiguous result remains `publication_unknown`, not success and not permission for a duplicate write. Bound automatic retry; keep all unresolved changes recoverable.

Successful confirmation means the commit was present in remote history at confirmation time. It cannot promise survival of a later administrator force-push/deletion. The application itself never force-pushes.

## 4. Remote-first synchronization without losing checkpoints

Use the repository's actual default branch, not a hard-coded `main`. Expose no container-branch creation/switching/merge UI. Existing non-default registrations are inspected during migration; never silently retarget their pending commits. A changed/deleted default branch pauses mutations until a safe rebind is explicit.

Fetch at project entry, foreground/reconnect, before checkpoints/publication, and every 15 seconds while a project is actively viewed. The interval is an observation cadence, not an instantaneous freshness guarantee. Coalesce fetches per repository; expose observed SHA/time and failed/unknown state. A local ahead/behind calculation is not remote observation.

Separate `remoteHead` from `checkpointHead` and `browserBase`. Read models, indexes and diagnostics carry a `SnapshotId` composed of repository, branch, commit and optional checkpoint overlay identity. A response assembled across different snapshots is invalid.

- With no pending checkpoints, fast-forward the clone to the fetched remote and refresh clean UI state.
- With pending work, always fetch and advance the canonical remote view. Do not run a blind pull/reset over the checkpoint checkout. Keep the original commits and browser journal intact.
- Reads of the canonical view use the pinned remote commit. Algorithms requiring files may receive a disposable detached snapshot worktree/materialization from the same clone. This is not a user-visible branch or an additional GitHub branch.
- If remote changes do not intersect an operation's declared read/write preconditions, replay that explicit operation on the new base during reconciliation. Preserve its original receipt and journal until publish is confirmed. Never silently run Git's prose merge algorithm.
- If preconditions changed, retain draft/checkpoints, show the latest canonical version and a conflict. The author may inspect the diff, explicitly rebase the intended operation onto the current revision, or discard it. Do not block clean unrelated read views behind stale local files.
- A push racing another writer is rejected by normal Git rules; fetch again, revalidate and retry a bounded number of times. Conflict does not authorize force push or a synthetic successful response.

Within an instance one coordinator serializes repository writes, checkout/index transitions and publish. Readers use pinned snapshots rather than mutable paths. Across containers Git's non-fast-forward protection and operation preconditions remain required; this campaign does not introduce CRDT editing or a distributed lock service.

## 5. Persistence classification

Container replaceability is a data contract, not an excuse to treat `/data` as disposable before migration is complete.

| State | Durable owner | Disposal/recovery |
| --- | --- | --- |
| Manuscripts, hierarchy, bible, plot, author notes | Existing Git work layout | Fetch/clone |
| Corrections, approved overrides, ignored candidates, custom dictionaries, module settings, adopted small statistical model parameters | Versioned `meta/scriptorium/modules/<module-id>/` files, preserving existing authoritative YAML fields | Same checkpoint/publish protocol; deterministic import from legacy stores |
| Accepted proposal effects and operation identity | Work commits and versioned metadata where needed | Reconstruct from confirmed Git history |
| Unaccepted proposals, temporary snapshots, pending multi-file edits | Browser recovery journal | Same browser/origin restores; explicit publish required for remote durability |
| Full-text/vector indexes, mention graphs, derived diagnostics, downloaded model weights | Ephemeral cache keyed by snapshot/model/version | Rebuild/download; may use optional reusable cache volume, never sole source of author decisions |
| Project bindings, image selection, deployment-level enabled modules | Host-supplied instance configuration; standalone browser can re-register repositories | Reissued on startup; container registry is only a cache |
| GitHub/LLM credentials, signing keys and author access authority | Host secret injection or external authority | Never Git or browser assets; credentials must be reissued/injected after replacement |
| Non-secret per-work model routing, budget preferences, desired feature settings | Versioned work settings | Restored from Git, clamped by host capability/policy |
| Usage/cost events already presented as historical records | Versioned private work metadata with event IDs, or an explicitly host-owned store | Never silently relabel historical records as a disposable cache |
| Share grants/episode mapping | Publishing module; episode map and hashed grant descriptors are versioned work metadata | Share activation requires confirmed push; bearer values are never committed; revocation is checked against current remote state |

The installed image is trusted code. A repository may request only allowlisted installed module IDs and bounded settings; it cannot supply an npm URL, executable, arbitrary entry point, secret, mount or network rule.

Before importing legacy `.arcadia` data or SQLite tables, enumerate their semantic records and label each as authoritative, provisional, secret, derived or relocated. Human corrections in a SQLite table are authoritative even when vectors in the same database are disposable. The importer produces a dry-run report and a reviewable ChangeSet; it leaves the source volume untouched. Source-specific real scene IDs/evaluation defaults become explicit project settings, not public fixture data.

Old local commits/drafts are not wiped during upgrade. Migration detects pending local commits, exports/re-journals their complete recoverable operations, and requests explicit publication or retention before switching to replaceable workspace mode. Generic repo read/write compatibility does not prove semantic-data migration.

## 6. Actual module separation

A bounded manifest declares ID/version, contract version, dependencies/capabilities, browser/server/worker entry points, state schemas and resource/locality metadata. Resolve it without importing module code. Reject unknown IDs, dependency cycles, incompatible contracts and unavailable required capabilities.

Distinguish:

1. Not included: no package, native library, UI bundle or model in the Core production closure.
2. Included but disabled: no module import/initialization, route/tool/action registration, timers, jobs, index migrations, worker or model load.
3. Enabled but idle: entry points and declared surfaces available; heavy resources remain unallocated.
4. Active: bounded jobs/resources allocated on demand; cancellation, drain and shutdown are explicit.

No runtime `npm install`. Both `core` and `full` are reproducible build profiles of one application image/repository, each deployment still running one container. A deployment manifest records exact included module versions separately from per-work activation. Adding a missing module requires deploying a compatible image, not pretending an enable toggle installed code.

UI contributions use the common editor, navigation, context dock, inspection and review hosts. Do not recreate one disconnected global overlay per feature. Browser/server/MCP derive availability from the same resolved capability set. Disabled routes must not remain callable through hidden API/MCP paths.

Official first-party modules are trusted. Typed permissions document and constrain host APIs; they are not a sandbox preventing arbitrary trusted JavaScript from accessing its own process. Third-party untrusted plugin execution is outside scope.

## 7. Computation placement and language

Story metadata, lightweight lint and export assembly stay in-process where bounded. NLP/model inference, speaker evaluation/training and expensive corpus analysis use on-demand supervised child processes in the same container. A shared capability provider owns one model/tokenizer allocation per compatible configuration; different feature modules do not independently load the same model.

Worker messages carry snapshot ID, job ID, deadline and bounded input/output; logging uses stderr, protocol uses its dedicated channel. Workers have no Git write authority or inherited provider credentials they do not need. Jobs return results/proposals to the canonical coordinator. Cancellation and last-consumer release terminate/drain the relevant process; an optional-module failure must not take basic writing offline.

Do not claim V8 worker-thread heap limits cap native model allocations. Child processes provide a clearer lifetime boundary; they are not separate security tenants or automatically separate cgroups. Measure event-loop responsiveness and process/model memory before and after activation, cancellation and shutdown.

Keep current tested TS/WASM/ONNX implementations. Reuse TypeScript speaker training rather than adding a Python environment. A later language change requires a concrete unsupported backend or measured bottleneck, API-equivalent fixtures and a bounded replacement; it is not a prerequisite for this migration. No new models are invented.

Use a pinned Node 24 Debian-slim/glibc base for both profiles to avoid making the full native dependency set depend on the MVP Alpine choice. Confirm the actual selected native packages in the built image; do not infer compatibility from a successful TypeScript build. Linux/amd64 CPU is the required reference image; claim other platforms/accelerators only with evidence.

## 8. Shared actions, MCP and providers

UI, HTTP and both source MCP transports use shared Read / Propose / Apply contracts. The generic ChangeSet/approval/revision boundary belongs to Core; module schemas implement domain operations. External MCP calls may propose persistent changes, but cannot approve themselves or bypass the browser/author acceptance boundary. Residual source direct-write tools must be migrated, not preserved as compatibility backdoors.

Read-only MCP and context manifests must function with no embedded model provider. Source embedded-provider features are preserved as optional compatibility surfaces in `assistant`, with provider SDKs confined there and external transmission explicitly allowed per feature/project. This deliberately separates implemented provider functionality from the source's longer-term retirement roadmap; Core does not depend on it.

Machine-generated diagnostics/proposals retain source snapshot identity and evidence. Stale positional results are hidden/remapped only when valid; stale proposals fail application rather than replacing newer prose. Source partial-approval/idempotency semantics are retained without claiming filesystem operations are an atomic distributed transaction.

## 9. Platform seam and non-goals

This campaign implements the Scriptorium producer contract only. Document/version the actual port, health, readiness, build/module metadata, auth mode, ephemeral workspace recovery inputs, pending-publication/drain state and shutdown semantics. Platform owns users, logical instances, placement, image selection and routing. Do not implement or rename Platform here.

Standalone single-owner access remains usable. Preserve application credential verification and MCP access through adapters; do not import the old multi-user OAuth/session authority into Core. Platform-issued-grant compatibility is a separate explicit adapter contract, not a claim that the current Platform already works.

Cooperative shutdown stops new mutations, drains bounded in-flight work and reports pending local checkpoints. A successful shutdown is not proof of push. Abrupt replacement must still recover journaled work; do not make indefinite retention of the old container the only safeguard. No automatic unapproved publish on shutdown.

## 10. Technical references

Repository evidence is pinned in the execution plan. External semantics informing this design:

- Git [fetch](https://git-scm.com/docs/git-fetch), [merge](https://git-scm.com/docs/git-merge), [push](https://git-scm.com/docs/git-push): fetch and checkout integration are different; ff-only refuses divergence; non-force push protects remote history.
- [Storage Standard](https://storage.spec.whatwg.org/): origin/storage-key scoped storage, best-effort versus persistent storage and eviction constraints.
- [Node 24 worker threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html): worker heap/resource controls are not an overall native-process memory limit.
- [pnpm deploy](https://pnpm.io/cli/deploy): production workspace closure can be assembled independently from the entire development workspace. Validate options against the repository's pinned pnpm version.
- [ONNX Runtime Node binding](https://onnxruntime.ai/docs/get-started/with-javascript/node.html): native inference is already callable from Node; platform/backend support requires actual artifact validation.
