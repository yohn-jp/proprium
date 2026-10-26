# Recovery Certification, Priorities and Integration Plan

**Status: normative exit gate.** A complete canon is the artifact of this documentation change, not a claim that the eight products have already been implemented or released. Recovery is delivered as signed, installed, actual author-usable plugin products; generic Git Core never regresses.

## Freeze and implementation branches

- Pinned source snapshots: Proprium, Scriptorium, Arcadia Loom commits in [the index](README.md). Preserve the currently functioning generic Host and Gateway while porting.
- Work from latest `main` in **one authoritative integration branch/worktree** (or on main if explicitly directed). Delegate independent work to subagents using nonoverlapping ownership and sequenced integration; never let parallel sessions race on the same branch or active files.
- Keep small, testable increments; early green for a subset is not completion. Never block on draft PRs, human review or undocumented manual approval, but do not lower admission/approval/security checks.
- Changes to WIT protocol or Host semantics are centrally coordinated. Plugin teams implement against a pinned versioned schema. Do not invent per-team ad hoc APIs or quietly duplicate the single Git writer.

## Critical path with independently executable slices

| Gate | Prerequisite | Required demonstrable output |
| --- | --- | --- |
| H0 Host recovery extension | Current generic Host/WIT v1 | Paged/revision-scoped list/read, typed action registry, host-owned functional UI contribution and guarded navigation, ChangeSet review/apply broker, deterministic errors |
| P0 Narrative | H0 + Scriptorium structure/reference code | Signed `proprium.narrative` installs, detects work, renders true Volume/Chapter/Scene tree, resumes/edits/recovers, creates/reorders via guarded proposal |
| P1 Knowledge | P0 stable identities + H0 UI | Bible, graph, world/reader state, threads and source-jump working |
| P1 Research | H0 paged snapshot (narrative labels optional) | Model-free lexical search, terms/aliases, safe navigation; can be implemented in parallel with Knowledge |
| P1 Paired Writing | H0 proposal/action + P0 scenes | MCP scoped context, ChangeSet diff, partial approval and return-to-editor; can proceed parallel with Knowledge/Research |
| P1 Diagnostics | H0 + P0, optional Knowledge/Research | Structure/prose/continuity evidence, stale invalidation and lint proposal; baseline in parallel |
| P2 Speaker | P0 + Knowledge, optional Research/Diagnostics | Attribution/review queue, corrections, voice dashboard, eval reports |
| P2 Semantic | Research, optional Knowledge | Opt-in model/embedding/rerank/contradiction enhancement with no-model fallback |
| P2 Publishing | P0 hierarchy and Host artifact download | Actual EPUB/plaintext/vertical-print output, reviewed episode map, honest sharing availability |
| C Complete product | H0 + P0 + P1 + P2 | Independently distributed signed plugins, all author jobs in inventory demonstrable, Core zero-plugin PASS and acceptance matrix below PASS |

Only required **new generic Host capabilities** are shared prerequisites; code from legacy modules should be ported rather than reimplemented without reason. Heavy model or offline-unsupported features should provide explicit unavailable states and never block P0/P1 local writing.

### Parallel work allocation

1. **Shared Host lane (one owner):** WIT/capability negotiation, paged immutable snapshot read, typed action dispatch, UI registry render/navigation, single-writer proposals/receipts, plugin registry builder generalization. Define the schema before plugin lanes branch.
2. **Narrative lane:** hierarchy parser, exact IDs/manuscript links, continue and navigation, structure semantic operations, v1 writer plugin + fixtures. Deliver P0 vertical slice as soon as H0 is viable.
3. **Knowledge lane:** pure domain graph/threads/world/reader/series + story Bible UI descriptors. It may port/compile pure algorithms before Host H0 completes; integration awaits Narrative IDs.
4. **Research/Diagnostics lane:** lexical index and terminology as one plugin; diagnostics separate plugin with shared optional capabilities. Index and rule fixtures run independently.
5. **Paired/MCP lane:** translate Scriptorium+Loom ChangeSet/Context concepts to Host action/proposal broker; do not modify Gateway tool visibility/auth contracts.
6. **Speaker/Semantic/Publishing lanes:** import tested algorithms, build independent signed artifacts, wait only on their typed API prerequisites. Publishing outputs can be tested against a synthetic Narrative reader early.
7. **Integration/certification lane:** owns acceptance fixtures and anti-false-green gates, source parity inventory, install/distribution and desktop/mobile workflow. It does not fabricate PASS from code review.

## Required synthetic fixtures

Use no private books, real access credentials or unlicensed model weights. At minimum:
- Two immutable GitHub repository IDs, same scene IDs in different works, two branches, and last-opened/recovery records bound to author/repo.
- A >300-scene, >256-file multi-volume work exceeding the v1 2 MiB eager snapshot boundary; varied explicit `manuscript` paths, 130 KiB+ file, non-ASCII/YAML unknown fields, ruby `|漢字《かんじ》`, CRLF, unsaved draft, edits during asynchronous read.
- Duplicate IDs, missing YAML, bad manuscript path, stale scene, missing relation, mixed reader/character knowledge, planted/advanced/resolved threads and series overlay conflicts.
- Ambiguous term aliases, normalized Japanese text with preserved UTF-16 spans, source revision changes, index corruption, model unavailable and worker trap.
- Dialogue with high/low/none attribution evidence, grouped corrections, author override, stale correction and a calibration fixture.
- Proposed multi-file/partial ChangeSet with evidence, stale revision, lost response, duplicate IDs, changed latest draft, reject and retry; full chain through active Browser Host MCP, not just mock payload.
- Missing/disabled/uninstalled/revoked official plugin, incompatible WIT version, signature corruption, cached offline install/activation, rollback.
- Real selected scope EPUB/text/print and episode mapping; sharing with absent and explicitly available service.

## Acceptance matrix (all mandatory where applicable)

| ID | Executable end-to-end job | Required proof |
| --- | --- | --- |
| R01 | Core-only generic Git edit/commit/publish | Works with zero plugins, no Node server/Gateway needed for local edit; no story schema assumption |
| R02 | Official signed plugin registry | Build every plugin independently from compute-sum, attest hash/signature and dependencies, preview/install/enable/reload/update/disable/rollback; no Host rebuild |
| R03 | Writer open/resume | Select work, Volume/Chapter/Scene, open correct manuscript, resume last recoverable scene, no other repo's draft |
| R04 | Japanese manuscript continuity | Desktop + Mobile: IME, undo, caret, selection, scroll, reading position, ruby/vertical typography survive panel switching |
| R05 | Draft/Git storage fidelity | Draft, local commit, remote published, conflict and unknown publication remain distinct, failure/restart/recovery protect text |
| R06 | Semantic structure edits | Create/edit/move/reorder scene and metadata through reviewed multi-file preconditions, preserve unrelated YAML/frontmatter |
| R07 | Story Knowledge | Bible/notes/character/relationships/threads/map/timeline/reader state linked and rendered, author-approved updates |
| R08 | Search/NLP/Diagnostics | Model-free search, terms/alias ambiguity, findings with evidence, source jump, stale invalidation, lint changes as proposals |
| R09 | MCP-first paired writing | Explicit repository ID -> context/manifest -> typed proposal -> diff/evidence -> selective author approval -> apply -> same editing location, no external self-approval |
| R10 | Speaker and heavy semantics | Human corrections and eval, optional embeddings and contradictions; no-model fallback, no cross-repo leakage |
| R11 | Publishing | Export actual UTF-8/EPUB/vertical print data, episode metadata, honest service-conditional sharing; no implicit publish |
| R12 | Isolation/security | Signature/ABI/capability/path validation, no arbitrary JS/DOM/credentials, cancellation, worker failure and stale results do not change Git |
| R13 | Integration distribution | Desktop Chromium, Mobile WebKit, real Host install/enable/author UI/reload; all relevant Go/Host/plugin/registry workflows green at SAME release SHA |
| R14 | Provenance/migration | Scriptorium parity and Loom backfill explicitly recorded per inventory row, no deleted author metadata or private fixture leaks |

For every R-ID record `PASS / FAIL / BLOCKED / NOT_CHECKED` and fixture, test command, sha, workflow URL/artifact, browser/platform, exact input/output. Tests passing for a subset are not `R13 PASS`; real iOS/Android/device or live Cloudflare claims require separate physical/prod evidence. CI results belong in execution evidence, not static canon prose.

## Regression/non-goals

- No demotion of generic Git to a novel-only product; no mandatory novel plugin or schema; no restoration of Scriptorium's Node/Fastify/OCI profile just to reuse algorithms.
- No false-green from an installed placeholder, panels that only list names, generic JSON output, `compute-sum`, demos, WIT declarations, copied source or a green Gateway run.
- No direct Git mutation by plugin, no auto-approved change, no auto-commit/publish, no unreviewed LLM ingestion/remote egress, no stale result applied after a different scene/draft, no clearing browser storage as a repair technique.
- No sweeping "today restored" claim without meeting R01–R14. Priority is structured to get an actually usable writing loop first while parallelizing independent ports, not to hide unfinished functions.

## Completion reporting format

| Plugin | Canon | Signed artifact + registry ref | User-visible live workflow | Desktop/Mobile | Data parity + migration | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Narrative | [NARRATIVE](plugins/NARRATIVE.md) | pending until proven | pending | pending | pending | NOT_CHECKED |
| Knowledge | [KNOWLEDGE](plugins/KNOWLEDGE.md) | pending | pending | pending | pending | NOT_CHECKED |
| Research | [RESEARCH](plugins/RESEARCH.md) | pending | pending | pending | pending | NOT_CHECKED |
| Paired Writing | [PAIRED-WRITING](plugins/PAIRED-WRITING.md) | pending | pending | pending | pending | NOT_CHECKED |
| Diagnostics | [DIAGNOSTICS](plugins/DIAGNOSTICS.md) | pending | pending | pending | pending | NOT_CHECKED |
| Speaker | [SPEAKER](plugins/SPEAKER.md) | pending | pending | pending | pending | NOT_CHECKED |
| Semantic | [SEMANTIC](plugins/SEMANTIC.md) | pending | pending | pending | pending | NOT_CHECKED |
| Publishing | [PUBLISHING](plugins/PUBLISHING.md) | pending | pending | pending | pending | NOT_CHECKED |

This table is a template, not actual implementation telemetry. Every completed plugin must replace 'pending' with a concrete immutable build/test/source reference. [Inventory](RECOVERY-INVENTORY.md) retains the original coverage obligation even if plugin topology later evolves.
