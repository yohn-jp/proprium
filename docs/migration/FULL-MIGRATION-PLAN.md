# Full migration — coverage and execution plan

Authority: Epic #7 and [FULL-MIGRATION](../architecture/FULL-MIGRATION.md). This is a fixed complete campaign, not an instruction to discover an unlimited backlog. Dispatch prompt: [SOL-GOAL](SOL-GOAL.md).

## 1. Current truth and evidence limits

| Repository | Inspected main | Role |
| --- | --- | --- |
| `yohn-jp/scriptorium` | `01403182e9f73dec29d04954e3091c235cd1aac0` | Existing public MVP; preserve working behavior except explicit new contracts |
| `yohn-jp/arcadia-loom` | `edc033c2c9466274a334299dadfa426661d957d9` | Private read-only source |

Target Epic #1 and #4/#5/#6 were open when inspected; #2 and PR #3 were closed/merged. Do not infer missing implementation from those open Issues or close them as part of this campaign. `docs/verification/ACCEPTANCE.md` records prior MVP checks; those are historical evidence, not fresh certification by this planning review.

The planning review read the target Core/save/sync and browser paths, source route registration, source package boundaries and representative NLP/training paths. It did not rerun the applications. Direct container network checkout failed due to unavailable proxy resolution; the GitHub connector supplied the inspected source. No runtime result is claimed by this documentation PR.

Primary pinned evidence:

- [Target Core](https://github.com/yohn-jp/scriptorium/blob/01403182e9f73dec29d04954e3091c235cd1aac0/packages/core/src/index.ts): `saveManuscript`, `syncStatus`, `syncProject`, project identity, locks and path guards.
- [Target browser](https://github.com/yohn-jp/scriptorium/blob/01403182e9f73dec29d04954e3091c235cd1aac0/app/src/main.ts): checkpoint clears drafts; periodic status is not a fetch.
- [Source route catalogue](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/packages/api/src/routes/index.ts): 48 registrations below.
- [Source product](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/PRODUCT.md), [UI manifest](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/app/package.json), [Core exports](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/packages/core/src/exports.ts).
- [Speaker retraining](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/packages/core/src/speakerRetrainRunner.ts): existing TypeScript model training. Remove private corpus-specific defaults from public code; preserve the algorithm with synthetic/project-supplied examples.
- [Retraining job](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/packages/api/src/speakerRetrainJob.ts): a source-path CLI default names `cli/speakerTrainEval.ts`, absent from the inspected CLI directory. This is a deployment preflight hazard, not a claim that every current execution path failed. Port compiled worker entry points and prove the invoked path.
- Source commit #568 records partial MCP migration. Restore the canonical approval boundary rather than transplanting remaining direct-write tools.

## 2. Source API coverage — no unowned registrations

Source paths below are relative to `packages/api/src/`. These are **registration owners**, not a claim that every handler is already implemented or working. Each owning task expands its assigned registrations into methods/actions and attaches target tests; it cannot silently narrow the list. Split domain and transport where a route currently combines them.

| ID | Source | Target owner / disposition |
| --- | --- | --- |
| R01 | `routes/system.ts` | API/Core lifecycle and runtime metadata |
| R02 | `versionRoute.ts` | API version/build/module metadata |
| R03 | `routes/llmHealth.ts` | assistant; never Core readiness prerequisite |
| R04 | `routes/llmQueueStatus.ts` | assistant jobs, backed by shared bounded execution |
| R05 | `routes/tree.ts` | Core hierarchy |
| R06 | `routes/entities.ts` | story domain + Core mutation boundary |
| R07 | `routes/zukanSuggestions.ts` | assistant proposal generation; story operations |
| R08 | `routes/scenes.ts` | Core scene/hierarchy operations; story metadata extension |
| R09 | `routes/worldState.ts` | story |
| R10 | `routes/stateProposals.ts` | story proposal operations; Core approval |
| R11 | `routes/changeSets.ts` | Core generic ChangeSet/approval/apply/history |
| R12 | `routes/readerModel.ts` | story reader/character knowledge; assistant only for generated reactions |
| R13 | `routes/search.ts` | Core bounded literal/basic search; semantic enhanced search |
| R14 | `routes/summaries.ts` | assistant generation and source freshness |
| R15 | `routes/threads.ts` | story |
| R16 | `routes/characters.ts` | story roster; speaker dialogue/voice contributions |
| R17 | `routes/tags.ts` | story |
| R18 | `routes/graph.ts` | story graph/relationship/map projections |
| R19 | `routes/timeline.ts` | story chronology |
| R20 | `routes/inspection.ts` | shared inspection host; domains supply typed evidence |
| R21 | `routes/diagnostics.ts` | diagnostics aggregator; optional module contributions |
| R22 | `routes/manuscript.ts` | Core documents/checkpoint/publish/history |
| R23 | `routes/export.ts` | publishing |
| R24 | `routes/publishEpisodes.ts` | publishing |
| R25 | `routes/candidates.ts` | diagnostics lexical candidates; semantic clustering extension |
| R26 | `routes/analysis.ts` | diagnostics and nlp capability |
| R27 | `routes/lint.ts` | diagnostics; fixes use approved Core operations |
| R28 | `routes/synonyms.ts` | diagnostics dictionaries; assistant external suggestions |
| R29 | `routes/writingStats.ts` | Core basic counts; diagnostics richer metrics |
| R30 | `routes/llmUsage.ts` | assistant historical usage records, explicitly classified durability |
| R31 | `routes/llmModelSettings.ts` | assistant preferences and secret references |
| R32 | `routes/nlpFeatures.ts` | module availability/locality projection; old external-send consent preserved |
| R33 | `streaming/demoRoute.ts` | Explicitly excluded production demo; retain necessary transport tests, not a public demo endpoint |
| R34 | `routes/qa.ts` | assistant setting QA and citations |
| R35 | `routes/continuationOptions.ts` | assistant |
| R36 | `routes/speakers.ts` | speaker inference/corrections/evaluation/training |
| R37 | `routes/aspectReview.ts` | assistant |
| R38 | `routes/jobs.ts` | module-runtime shared jobs, domain-specific tasks owned by modules |
| R39 | `routes/workspace.ts` | Core Git operations/recovery |
| R40 | `routes/projects.ts` | Core repository registration/reconstruction |
| R41 | `routes/series.ts` | story multi-work bible overlay |
| R42 | `routes/identity.ts` | Preserve owner access/credential connection through adapters; Platform user/OAuth/session authority is explicitly relocated, not cloned into Core |
| R43 | `routes/me.ts` | Same single-owner access projection; hosted account administration belongs to Platform |
| R44 | `routes/reviewQueue.ts` | shared review host; speaker/story/assistant queue contributions |
| R45 | `routes/scratch.ts` | Core writing scratch/checkpoints and browser recovery |
| R46 | `routes/dialogueSketch.ts` | assistant dialogue topics/lines with story/speaker context |
| R47 | `routes/share.ts` | publishing read-only, scope/expiry/revocation checked against persisted grant metadata |
| R48 | `routes/mcp.ts` | mcp HTTP transport; same actions as stdio package |

R42/R43 relocation is not permission to break standalone owner login or credential-based MCP access. Those remain required. A full Platform implementation is not part of Scriptorium's completion claim.

## 3. Non-router capability and data ledger

The source product cannot be migrated by counting API files alone. P00 seeds a machine-readable ledger from this table and the route table; workers record source symbols, target exports/paths, storage disposition and proof IDs. Every entry ends as `verified` or an explicitly listed exclusion/relocation with rationale. No `todo`, placeholder button, mock-only success or unexplained deleted export satisfies completion.

| Group | Source starting points | Required retained behavior |
| --- | --- | --- |
| Writing | `app/src/features/editor`, editor typography, draft hooks; Core loader/snapshots/scratch | Editing/navigation; vertical preview/reading/print, ruby, 400-character conversion, zen/focus behavior, snapshots/scratch, mobile access and safe recovery |
| Story | source schema/core-shared; graph, timeline, worldState, readerKnowledge, seriesOverlay | Entity CRUD/reference validation, nested notes, appearances/backlinks, tags, shared-series reads, thread lifecycle, maps/relationships/chronology, world and knowledge state |
| Diagnostics | linter, textAnalysis, sentimentArc, tone, proseBalance, phraseMining, plot, voice/style services | Rules, evidence, severity, rhythm/tone/style/plot diagnostics, context-sensitive wording suggestions; current-source behavior not invented new heuristics |
| NLP | tokenizer/analyze, candidate discovery, synonyms/term variants | Japanese token/sentence spans, analysis primitives and dictionary hooks |
| Semantic | embedding, search/reranker, term clustering, contradiction | Embedding/hybrid/expression search, corpus similarity, reranking, candidate/evidence freshness; optional standalone capability |
| Speaker | attribution/clustering/count/group labeling/corrections/eval/retrain/reranker/style fingerprints | Attribution confidence, corrections and grouping, character dialogue/voice comparison, evaluation, gated model adoption and repeatable training |
| Assistant | nlp/llm, qa, rewrite, continuationContext, dialogueSketch, zukanSuggestions | Implemented provider integrations, model routing/sampling, queue/streaming/usage/privacy, cited QA/rewrite/summaries/continuation/review/proposals; none required by Core |
| Changes and context | narrativeChangeSetApply, mutationSafety, source action registry/writingContext/contextManifest | Shared approvals/partial results/restore, source identity, selection context, bounded manifests and truthful errors |
| MCP | `packages/mcp-server` plus HTTP mcp routes | Both transports, discovery/search/context/diagnostics/history/proposal/status; no external tool self-approval/direct persistent bypass |
| Publishing | epubExport/plaintextExport/publishEpisodeMap, share, print UI | Text/EPUB/vertical export, episode mappings, bounded read-only share access |
| UX system | `app/src/components`, contexts, query, dock, panelHost, designTokens, styles and guards | One coherent responsive shell, themes, accessibility, loading/empty/error states; do not port whole source navigation sprawl |
| Legacy durable state | workspace persistence stores, `.arcadia` files, index-db/schema definitions, model/correction/config/receipt stores | Explicit classification/import of author decisions, settings, approvals, history and grants; derived indexes rebuilt only from retained inputs |

Source roadmap-only universal Story Lens completion, blank Dock modes and a new general LLM platform are not required. Existing implemented panels/actions remain required even if a newer planned replacement was unfinished. Existing provider SDKs may survive only inside the optional assistant module; migration does not require the source's uncompleted provider-retirement roadmap.

For source endpoints/files found to be unreachable or dead, record concrete callers/registration evidence before removal. Do not infer dead code from a name, an unindexed search, an import failure or absent tests.

## 4. Fixed producer contracts before parallel work

P00 creates actual minimal interfaces in `packages/contracts`, then freezes their first version before consumers start. No broad SDK is needed:

- `RepositoryIdentity`: provider/numeric repo ID/default branch/owner scope.
- `SnapshotId`: repo, branch, remote commit and explicit optional local overlay identity.
- `ChangeOperation`: stable ID, effect, bounded payload, declared read/write preconditions and recovery representation.
- `CheckpointReceipt` / `PublishReceipt`: operation IDs, edit generation, local/remote commits, known/unknown confirmation state.
- `SnapshotReader`: immutable structured/file reads; materialized paths only for declared read-only worker input.
- `MutationCoordinator`: validate/propose/approve/checkpoint/reconcile/publish; owns all Git writes.
- `ModuleDefinition` / `ModuleContext`: pure metadata, explicit entry points/capabilities and owned cache namespace; no unrestricted Core object.
- `JobRequest` / result: bounded input, snapshot/version/model identity, cancellation/deadline and error.
- `UiContribution` and availability projection: editor/dock/inspection/review/settings slots shared by browser, API and MCP.

Concrete producer seams are checked at every join: exported symbol/schema shape, snapshot identity, credential ownership, state lifetime, cancellation, and ordering. A worker consumes committed producers, not another worker's uncommitted tree. Cross-owner changes return to the coordinator.

## 5. Execution graph and ownership

Waves denote dependency layers, not arbitrary batches or mandatory human checkpoints. Run a task as soon as its listed producer artifacts are accepted. Unlimited subagents are permitted, but each writable area has one active owner. Independent reviewers are read-only and never double as the worker approving its own output.

Root manifests/lockfile, package export maps, shared contracts, build profiles and integration metadata have one coordinator writer. Workers propose dependency edits for that writer; they do not independently rewrite the lockfile. Code subworkers may split an owned task further only into disjoint areas without changing its contract.

| Task | Dependencies | Exclusive implementation ownership | Deliverable |
| --- | --- | --- | --- |
| P00 | none | shared contracts, ledger, root build/dependency coordination | Recorded base, real baseline check, frozen contracts and exact scoped source inventory |
| P01 | P00 | `packages/core/src/{repository,sync,changes,documents}` and focused tests | Refactored Core, immutable snapshots, checkpoint/reconcile/publish and recovery receipts |
| P02 | P00 | `app/src/{shell,editor,storage,api}` and UI primitives | React shell and durable IndexedDB journal with explicit state transitions |
| P03 | P00 | `packages/module-runtime`, profile build tooling; profile data via coordinator | Dependency/activation lifecycle, child-process supervision, selective production closure |
| P04 | P00 | `packages/migration` | Read-only legacy inspection, categorized import plan, generic approved import boundary |
| P05 | P01,P02,P03,P04 | `modules/story` including own UI/tests/migrations | Story/entity/graph/knowledge/series capabilities |
| P06 | P01,P02,P03 | `modules/nlp`, `modules/diagnostics` including own UI/tests/migrations | Shared tokenizer capability and rule/statistical analysis; separable from Core |
| P07 | P01,P02,P03,P04 | `modules/publishing` including own UI/tests/migrations | Export/episode/share with durable metadata and read-only public access |
| P08 | P01,P02,P03 | `packages/api` composition; `modules/mcp`; application settings wiring | Expanded transport/action host, both MCP transports, provider-none path and runtime contract |
| P09 | P05,P06 | `modules/semantic` | Embedding/search/reranker/contradiction with snapshot-scoped worker/index lifecycle |
| P10 | P05,P06 | `modules/speaker` | Attribution/corrections/evaluation/training, compiled worker entry points and model gates |
| P11 | P05,P06,P08,P09,P10 | `modules/assistant` | Optional provider execution and all implemented assisted writing/proposal flows |
| P12 | P04,P05,P06,P07,P08,P09,P10,P11 | final importer composition, migration fixtures/ledger, integration tests | Complete semantic-data and feature preservation on the composed tree |
| P13 | P01–P12 | Docker/profile integration, root verify entry, acceptance/docs via coordinator | Core/full images, model/browser/Git acceptance, dependency/runtime measurements and final read-only review |

Practical parallel layers: P00; then P01–P04; then P05–P08; then P09/P10; then P11; then P12/P13 completion. P13 may prepare packaging and acceptance tooling earlier against frozen interfaces, but cannot certify a not-yet-composed product. Do not stop after one layer: the dispatched goal is the entire listed graph.

## 6. Task acceptance and verification

### P00 — baseline and seams

Refresh target/source HEADs, compare against pinned evidence, and incorporate only relevant deltas. Inspect actual scripts and run the target's current `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm audit:core` once. Run baseline browser/image checks when the local environment supports them. Record failures; repair a proven shared baseline once before final acceptance, not once per worker. Old source-wide red tests are not imported as arbitrary debt, but failures in migrated paths need real fixes.

Generate ledger entries for the 48 registrations plus non-router groups. Record each actual handler/tool/UI entry and authoritative storage reader/writer within those scoped source trees. Freeze ownership and public contracts. No placeholder interface counts as a tested producer.

### P01 — Git and transaction correctness

Prove: actual remote update while active; clean fast-forward; pending checkpoint versus disjoint remote update; same-file conflict; default-branch change; non-fast-forward push race; unknown push result after remote success; recovery after clone loss; no duplicate operation after replay; several checkpoints/files with only some acknowledged; rejected hooks/protection never reported saved; preservation of unknown YAML/staged files and path guards. Verify a pushed commit can be an ancestor of current remote HEAD. No auto-force, unapproved prose merge or dependency on an ephemeral receipt DB.

### P02 — browser correctness and full writing UX

Use real IndexedDB in browser acceptance. Check quota/write failure feedback, stable repo/document recovery keys, multiple pending documents, navigation/reload, new typing during older save response, stale conflict responses, checkpoint retention until publication and replay into a new container at the same origin. Validate Japanese ruby/vertical/reading/scratch/history and mobile/keyboard flows from actual source contracts. Do not retain two competing save implementations while porting React.

### P03 — add-on isolation

Prove Core-only production closure excludes optional packages/native models; no module source/barrel import from Core; dependency resolution/cycle/version failures; installed-disabled module starts no job/timer/worker/model and exposes no hidden write endpoint; enabled-idle allocates no heavy model; disable drains and releases its resources without deleting author data. Enabling an absent package reports redeployment required. Validate capabilities shared by two consumers do not double-load the same model. Inspect actual built imports/processes, not regex names alone.

### P04/P12 — semantic migration

Create synthetic legacy repositories and corresponding `.arcadia` state with representatives of every authoritative/provisional category. Import as reviewable operations, preserve file formats and stable identities, and prove idempotent reruns. Verify unsupported module data remains untouched while disabled and becomes readable on re-enable. Imported corrections, notes, user overrides, custom dictionaries, selected models/settings, proposals and publication metadata must survive confirmed push plus complete container data-root deletion. Preserve pending legacy local commits rather than assuming everything was pushed. Report secrets/foreign licensed data as excluded, never copy them into fixtures.

### P05–P11 — actual feature preservation

Each module proves its ledger entries through its public server/action/UI surface and a persistence/rebuild round trip. Port only tests proving those contracts and relevant regressions. Every generated result carries snapshot/model identity. When a source helper writes files directly, adapt it to the Core operation boundary rather than keeping two authorities.

NLP, semantic and speaker acceptance executes the existing actual supported CPU engines/models, not only stubs. Synthetic small corpora exercise token offsets, retrieval ordering, attribution/correction, training/adoption and model reload. Port privacy and external-transmission controls; explicit provider `none` keeps writing/context/MCP/review functioning. Model unavailable, missing credentials or unsupported host is BLOCKED/NOT_CHECKED, not a passing model test. Complete unaffected work, save all code, and identify the smallest external unblock without re-expanding the campaign.

For assistant flows, validate schema/context/prompt/streaming and proposed changes locally, then a configured real provider for the reference end-to-end flow. Do not trigger unbounded billable model evaluation; use the smallest required bounded calls. Where the environment does not authorize a real provider call, report that gate honestly instead of silently calling it complete.

### P08 — security and shared mutation

Verify authenticated UI/REST/MCP paths, project isolation, exact effect classes, cancellation and machine errors. Both MCP transports can read/propose/query status but cannot grant author approval to their own proposal. Fix source residual persistent-tool bypasses. Standalone owner login and MCP authentication work without implementing Platform OAuth. Producer metadata reports actual auth/runtime/module contracts, not old Loom constants.

### P13 — composed delivery

Implement a real root verification command (for example `pnpm verify`) that runs the required checks; do not claim a new command exists before adding it. Final evidence must correspond to the exact submitted runtime tree and immutable image digest. Include:

- frozen install, formatting/static boundaries, types, focused/integrated tests and production build;
- Core-only and full build profiles, single OCI container startup, module metadata, auth, probes and shutdown;
- real GitHub disposable fixture round trip with no private manuscript or credential recorded;
- browser Draft -> Checkpoint -> Publish, external update/conflict, container destruction/recreation and recovery;
- full-profile UI/API/MCP actions and actual model/worker flows;
- Core image closure versus full-image closure; observed RSS/process count/event-loop responsiveness before activation, during inference, after disable and after replacement;
- every migrated feature and author-data ledger entry linked to its proof; no placeholder/stub counted as migration;
- independent read-only reviews of persistence/concurrency, module/data ownership and UX/coverage; owning implementers fix accepted defects and rerun affected checks.

Do not demand an arbitrary image-size target or claim an in-process model was freed just because a JavaScript reference was dropped. Compare measured results to the current MVP baseline and identify intentional framework/full-profile cost separately from unintended regressions.

## 7. Publication and stopping rule

The current planning change is a documentation PR, not product implementation. The subsequent owner-dispatched Sol campaign may integrate its accepted documents and commit/push directly to Scriptorium main using the previously authorized single-coordinator policy. No per-leaf PR is mandatory. Workers commit in isolated work areas and send exact commit/verification evidence to Sol; no worker races main.

Update repository instructions and documentation to the accepted new scope when implementation starts. Do not allow an obsolete Core-only exclusion or main prohibition to override the explicit campaign authorization. Do not change other repositories or import the source's agent rules wholesale.

No CI/GitHub Actions or organization-template synchronization/addition/execution; no Inari; no history rewrite, force push, source changes, production deployment or registry publication. Local container/model/browser tests are required and are not CI.

Commit/push meaningful progress continuously, including truthful incomplete work at a genuine external blocker. Do not wait for all certification to save code. Distinguish implementation, local verification, independent review and integrated delivery.

Stop successfully only when P00–P13 and Epic #7's in-scope acceptance are satisfied, the migration ledger is closed with evidence, and the verified implementation is on main. Do not stop merely after creating Issues, scaffolding plugins, porting backend-only functions, or finishing another minimal Core. If a required external gate truly remains blocked, publish the complete available implementation and report an incomplete goal with exact blocker/evidence; do not fabricate success or endlessly rediscover the same blocker.
