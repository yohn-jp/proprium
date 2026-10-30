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
| H0 Host recovery extension | Current generic Host/WIT v1 | Paged/revision-scoped list/read, typed action registry, functional Host UI/navigation, ChangeSet review/apply, discovery/installation, artifact sink and deterministic errors |
| P0 Narrative | H0 + Scriptorium structure/reference code | Signed `proprium.narrative` installs, detects work, renders true Volume/Chapter/Scene tree, resumes/edits/recovers, creates/reorders via guarded proposal |
| P1 Knowledge | P0 stable identities + H0 UI | Bible, graph, world/reader state, threads and source-jump working |
| P1 Research | H0 paged snapshot (narrative labels optional) | Model-free lexical search, terms/aliases, safe navigation; can be implemented in parallel with Knowledge |
| P1 Paired Writing — FROZEN | H0 proposal/action + P0 scenes | Preserve existing MCP/context/ChangeSet requirements; paired-only delivery is frozen and remains uncertified |
| P1 Diagnostics | H0 + P0, optional Knowledge/Research | Structure/prose/continuity evidence, stale invalidation and lint proposal; baseline in parallel |
| P2 Speaker | P0 + Knowledge, optional Research/Diagnostics | Attribution/review queue, corrections, voice dashboard, eval reports |
| P2 Semantic | Research, optional Knowledge | Opt-in model/embedding/rerank/contradiction enhancement with no-model fallback |
| Early portability / P2 Publishing | P0 hierarchy and Host artifact download | Actual EPUB/plaintext/vertical-print output, reviewed episode map, honest sharing availability |
| C Active seven-plugin recovery | H0 + P0 + active P1/P2 lanes | Independently distributed signed active plugins, active author jobs in inventory demonstrable, Core zero-plugin PASS and all applicable non-frozen acceptance rows passed; R09 remains visible as FROZEN |

Only required **new generic Host capabilities** are shared prerequisites; code from legacy modules should be ported rather than reimplemented without reason. Heavy model or offline-unsupported features should provide explicit unavailable states and never block P0/P1 local writing.

### Parallel work allocation

1. **Shared Host lane (one owner):** WIT/capability negotiation, paged immutable snapshot read, typed action dispatch, UI registry render/navigation, single-writer proposals/receipts, plugin registry builder generalization. Define the schema before plugin lanes branch.
2. **Narrative lane:** hierarchy parser, exact IDs/manuscript links, continue and navigation, structure semantic operations, v1 writer plugin + fixtures. Deliver P0 vertical slice as soon as H0 is viable.
3. **Knowledge lane:** pure domain graph/threads/world/reader/series + story Bible UI descriptors. It may port/compile pure algorithms before Host H0 completes; integration awaits Narrative IDs.
4. **Research/Diagnostics lane:** lexical index and terminology as one plugin; diagnostics separate plugin with shared optional capabilities. Index and rule fixtures run independently.
5. **Paired/MCP lane:** FROZEN. Preserve the existing plugin and its contracts. Keep shared MCP/Gateway verification active under its own acceptance gates.
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
| R06 | Semantic structure edits | Create/edit/reorder chapter/scene and semantic metadata through reviewed multi-file preconditions, preserve unrelated YAML/frontmatter |
| R07 | Story Knowledge | Bible/notes/character/relationships/threads/map/timeline/reader state linked and rendered, author-approved updates |
| R08 | Search/NLP/Diagnostics | Model-free search, terms/alias ambiguity, findings with evidence, source jump, stale invalidation, lint changes as proposals |
| R09 **FROZEN** | MCP-first paired writing | Explicit repository ID -> context/manifest -> typed proposal -> diff/evidence -> selective author approval -> apply -> same editing location, no external self-approval |
| R10 | Speaker and heavy semantics | Human corrections and eval, optional embeddings and contradictions; no-model fallback, no cross-repo leakage |
| R11 | Publishing | Export actual UTF-8/EPUB/vertical print data, episode metadata, honest service-conditional sharing; no implicit publish |
| R12 | Isolation/security | Signature/ABI/capability/path validation, no arbitrary JS/DOM/credentials, cancellation, worker failure and stale results do not change Git |
| R13 | Integration distribution | Desktop Chromium, Mobile WebKit, real Host install/enable/author UI/reload; all relevant Go/Host/plugin/registry workflows green at SAME release SHA |
| R14 | Provenance/migration | Scriptorium parity and Loom backfill explicitly recorded per inventory row, no deleted author metadata or private fixture leaks |

For every R-ID record `PASS / FAIL / BLOCKED / NOT_CHECKED / FROZEN`. Executed checks record fixture, test command, SHA, workflow URL/artifact, browser/platform and exact input/output. A FROZEN row records its pre-freeze result and evidence; no new feature run is implied. `FROZEN` is a lifecycle disposition, never a pass. R09 retains its former MCP-first workflow definition but is frozen as a Paired Writing-specific product gate. This means seven-plugin recovery does not wait for R09; it does not certify any Paired Writing feature. The Paired-specific gates `accept-pw-01` through `accept-pw-11` and `accept-pw-21` are also FROZEN, with their last recorded outcomes preserved. Shared Host proposal, security, registry, MCP and mobile checks continue under H0 and applicable R02/R03/R06/R12/R13 gates. Tests passing for a subset are not `R13 PASS`; real iOS/Android/device or live Cloudflare claims require separate physical/prod evidence. CI results belong in execution evidence, not static canon prose.

| Legacy gate | Current treatment | Scope kept active |
| --- | --- | --- |
| R09 — MCP-first paired writing | `FROZEN`; retained under the same ID, not PASS | Shared Host proposal/review, MCP/Gateway security, registry and browser distribution remain under H0, R02, R12 and R13. |
| `accept-pw-01`–`accept-pw-11`, `accept-pw-21` | `FROZEN`; plugin-specific requirements retained | Independently owned Narrative, Knowledge, Research, Diagnostics, Speaker, Semantic, Host and Gateway acceptance remains active; no paired-only Host work is authorized. |

## Regression/non-goals

- No demotion of generic Git to a novel-only product; no mandatory novel plugin or schema; no restoration of Scriptorium's Node/Fastify/OCI profile just to reuse algorithms.
- No false-green from an installed placeholder, panels that only list names, generic JSON output, `compute-sum`, demos, WIT declarations, copied source or a green Gateway run.
- No direct Git mutation by plugin, no auto-approved change, no auto-commit/publish, no unreviewed LLM ingestion/remote egress, no stale result applied after a different scene/draft, no clearing browser storage as a repair technique.
- No sweeping "today restored" claim without meeting every applicable R-ID and plugin gate. R09 is explicitly FROZEN, so the seven-plugin result may not be summarized as all R01–R14 PASS. Freeze does not hide Paired Writing's incomplete or unchecked state.

## Completion evidence format

An implementation report supplies one record per feature ID: owning canon/acceptance IDs, source revision, synthetic fixture, signed artifact and registry digests, test command, browser/device class, actual input/output/receipt and `PASS|FAIL|BLOCKED|NOT_CHECKED|FROZEN`. A frozen row also carries its last pre-freeze status and evidence; `FROZEN` never substitutes for the underlying `FAIL` or `NOT_CHECKED` result. Every claimed complete active plugin must have immutable proof for every applicable feature, desktop/mobile author flow and migration/no-loss condition. Reports live in CI artifacts; this canon contains no changing deployment-status table. [Inventory](RECOVERY-INVENTORY.md) retains the original coverage obligation even if topology later evolves.

## Canon acceptance versus implementation acceptance

**Canon certification** verifies a complete decision contract: every recovered source action/UI/data/helper has one owner and feature row, every row links a local executable scenario specification, schemas and errors are concrete, all links/source paths resolve, required dependency graph is acyclic, and no target is described as implemented. `node scripts/verify-authoring-canon.mjs --sources /home/sophia/src` checks the structural portion. The eight plugin ledgers refine the inventory; their detailed local acceptance IDs are mandatory in addition to R01–R14. Source tests listed there are legacy evidence, not Proprium browser certification. Canon completion does not mark the implementation matrix PASS.

**Implementation certification** executes active local feature scenarios and applicable R-ID gates against signed installed artifacts and the adopted v2 schema. Frozen Paired Writing scenarios remain recorded as `FROZEN`, not executed as current acceptance. For each active feature row, test its visible success result plus the applicable failure dimensions below. Record waived dimensions as `not_applicable` with the canon rule explaining why; no silent omission. Runtime reports stay in CI artifacts, not dated updates to this canon.

| Dimension | Required procedure and visible pass result |
| --- | --- |
| Pinned read / stale | Pause before result/apply, edit one read-set file or switch branch; result becomes stale, no newer text is replaced, refresh produces new snapshot. |
| Competing writer / conflict | Prepare two proposals for the same revision; apply first, second fails revision check with inspectable diff and no partial unreported write. |
| Unsaved draft / IME | Compose Japanese text, open panel, invoke read/proposal/export, navigate/return; composition and undo survive; draft inclusion is explicit; apply cannot overwrite dirty buffer. |
| Offline / missing bytes | Disable network after caching, repeat local task; it works on local bytes. Missing artifact/file/provider has a distinct unavailable error and retry path without hidden Gateway requirement. |
| Corrupt/missing source | Remove referenced manuscript, duplicate entity ID, malformed UTF-8/YAML, unknown fields; visible path-specific diagnostics, unknown bytes preserved and no implicit repair. |
| Repeat / lost receipt | Resubmit same idempotency key with same/different payload; same returns original receipt, different is rejected. Drop response during apply and recover receipt before retry, with no duplicate log append or scene. |
| Disable / trap / timeout | Disable producer during work, inject trap and expired deadline; Worker/assets release, late results ignored, proposal/draft/author files survive and plain editor remains usable. |
| Mobile / accessibility | Mobile WebKit touch+keyboard, portrait/landscape and virtual keyboard; sheet choices and non-drag alternatives work; close/back restores same document/caret/selection/scroll. Physical device claims need their own run. |
| Recovery / storage quota | Fail staging/journal/cache/artifact writes and reload mid-unit; show actual receipt or storage_unknown, block unsafe mutation and retain original bytes. Derived cache eviction rebuilds without rewriting source. |
| Scope / privacy | Same IDs on two repositories/branches, cross-work denial, external payload preview, secret redaction; never leak content, bearer or credential into another result/transcript/cache. |

### H0 implementation scenarios

- **H0-READ:** list 300+ scenes over >256 files and >2 MiB, read 130 KiB+ UTF-8 with split multibyte chunks, validate exact hashes/CRLF and cursor scope; memory/page bounds hold without whole-repo import.
- **H0-ACTION:** same schema-valid UI/MCP call returns equivalent domain value at the same scope/snapshot; unknown fields, caller spoofing, nested recursion and missing grants are rejected before guest side effects.
- **H0-UI:** a signed artifact contributes an operable outline, form, evidence jump and review link in recovered Desktop/Mobile shells. Keyboard/touch invoke actual typed actions; empty/error/stale states remain distinguishable.
- **H0-WRITER:** compile a mixed manuscript/entity/scene/state/thread fixture in source order through read-only owner compilers and ephemeral staging, verify original-base read union and same-path collapse, then prove no worktree write occurs before review; reviewed dependency-closed units apply through one writer; failure injected after every staged operation/reload produces recoverable receipts. No auto-commit/push, stale/dirty apply rejected, reject changes no bytes.
- **H0-INSTALL:** discover each official plugin from signed index, preview capabilities/transitive pins/sizes, install disabled, enable-idle without Worker/model; first demand activates; offline admitted cache and missing bytes are distinguished; invalid signature/version/cycle fails closed.
- **H0-ARTIFACT:** stream/seal/download text/EPUB above normal RPC cap, verify hash and selected snapshot, overflow/cancel removes incomplete bytes; safe print has no HTML execution and returns to draft.
- **H0-CONSENT:** load Git consent/model metadata and verify zero grants; deny optional provider and cross-work access, accept only explicit Host-selected scope/request; secrets never enter guest/MCP result; ambiguous paid request never automatically retries.

### First usable slice and full recovery

P0 is usable only when H0 and Narrative local scenarios plus R03–R06 pass with signed discovery/install, actual chapter/scene creation/reorder and recovery; a build alone is insufficient. Active seven-plugin recovery certifies the long-work loop under R07–R08 and R10–R11 with optional providers absent and available; R09 stays FROZEN until an explicit Paired Writing resume decision. Basic text/EPUB export is scheduled immediately after Narrative as data portability, independent of Reader/sharing service. The eight-plugin canon can be reported as seven active products plus one frozen, uncertified product; it must not be reported as complete eight-plugin recovery. Independent high-memory Semantic unavailability on unsupported devices must match its explicit supported-platform contract, never block local writing.

## Source delta and UI parity

The [Scriptorium source delta](SCRIPTORIUM-LATEST-DELTA.md) adds DELTA-01 through DELTA-06 to the Host, Narrative and Research implementation gates, including page lifecycle recovery and mobile editor-byte fidelity.

All 42 registered legacy UI contribution IDs listed in `traceability.json.source_ui_contributions` must map to a specific owning plugin feature. The source-aware validator checks that none has been added, omitted or renamed. User-facing acceptance additionally requires an interactive Host UI and a real action result; a module label alone does not count.
