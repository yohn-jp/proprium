# Core C01–C64 results

Canonical contract: [CORE-64-GOAL.md](CORE-64-GOAL.md), frozen at `a1587e784788fa87d86c0eb7ab175d7a28a3209f`. Initial main and origin/main both resolve to that SHA (2026-10-20 JST).

Goal status: **in progress; 7/64 final dispositions recorded**. Existing W0/W1 changes remain accepted history; this count describes the new final ledger, not the number of implemented optimizations. Pending candidates are not completed rows. No pending verification is PASS.

## Execution ownership

Sol coordinates, reviews and serially integrates/pushes main. Each Luna Max worker uses its own branch/worktree from the frozen initial SHA; subsequent implementation leaves receive the current integrated base. No PR, Actions, Inari or external Plugin Platform work is authorized.

| Gate / fixed IDs | Worker / branch | Exclusive production ownership | Current bounded unit |
| --- | --- | --- | --- |
| G0 C58 baseline | Luna Max / `perf/c64-g0` | Existing harness; changes require coordination | One post-W1 environment/fixture/verification baseline |
| G1 C01–C19 | Luna Max / `perf/c64-g1`, `perf/c64-render`, `perf/c64-journal` | Editor C02/C05: g1; `SharedApplication.tsx`/Workspace/SceneEditor: render; `storage/journal.ts`: journal | Cursor, render residual and C14–C16 probes prepared independently |
| G2 C20–C36, C54; linked C63 | Luna Max / `perf/c64-g2` | `packages/core/src/index.ts` | Identify pinned-read/batching/cache evidence and leaves |
| G3 C38–C47; linked C64 | Luna Max / `perf/c64-g3`, `perf/c64-static`, read-only network/status probes | Resume hook: g3; `packages/api/src/server.ts`: static | Polling candidate, static/idle/bootstrap/status probes; SharedApplication wiring through render owner |
| G4 C37, C48–C53, C55–C57 | Luna Max / `perf/c64-g4` | No product changes allocated | Preliminary contract/necessity evidence, finalized after consumer gates |
| G5 C59–C62; C58/C63 shared evidence | Luna Max / `perf/c64-g5`, `perf/c64-build`, `perf/c64-oci` | Vite/active `launcher.tsx`: g5; root build/package: build; Dockerfile/OCI: oci | Initial closure and Core build candidates prepared; isolated Podman info PASS |

G0 precedes implementation comparisons. Independent G1/G2/G3/G5 investigations run concurrently. G4 decisions use the consumers established by prior gates. Shared contracts C30/C31/C63, C46/C47, C48/C57, C21/C22/C35/C54 and C32/C33/C36 each use one implementation/evidence source. File ownership prevents concurrent edits; cross-owner changes must be sequenced.

G0 completed the single four-tier baseline at `80ab121a`; see [executed conditions and limits](G0-CORE-64-BASELINE.md). Install, typecheck, workspace tests, Core/Full builds and Core audit passed. Large/stress timeouts and editor-readiness failure remain NOT_CHECKED. G0 initially held the exclusive heavy benchmark/full verification lease. Other workers inspect existing code/evidence only. Measurements and full checks are scheduled sequentially when they compete for CPU, memory or fixtures. `/data` has a separate filesystem with about 104 GiB available at preflight; root has about 2 GiB. Synthetic datasets/raw evidence go to unique campaign paths under `/data`; unrelated worktrees/artifacts are preserved.

## Bounded work queue

Every fixed candidate has one result owner; shared contracts reuse the same evidence. These are assignments, not completed result rows. The four-tier G0 pass is complete. Individual measurement/build slots are serialized when resource contention can affect comparisons; source preparation and cheap syntax/semantic checks remain independent. Performance comparisons run without concurrent heavy tests/builds. Required final verification may run in a separate resource-controlled batch once measurements stop.

| Fixed IDs | Luna Max unit / branch | Boundary |
| --- | --- | --- |
| C01–C03, C05 | `perf/c64-g1` | C02 first; input/materialization residual next, same editor owner |
| C04, C06–C08, C11 | `perf/c64-render` | SharedApplication/Workspace/SceneEditor render chain |
| C09 | `perf/c64-resize` | Probe only; Workspace edits wait for render ownership handoff |
| C10, C12–C13, C17–C19 | `perf/c64-durability` | Probe only; reuse strict recovery tests |
| C14–C16 | `perf/c64-journal` | Real IndexedDB journal scaling/bytes |
| C20, C25–C26, C29 | `perf/c64-read-overhead` | Probe only; Core product edits through g2 owner |
| C21–C22, C35, C54 | `perf/c64-g2` | Pinned reader/bulk capability; sole Core index writer |
| C23, C27–C28 | `perf/c64-writer` | Probe only; checkpoint/publish/census |
| C24 | Coordinator, G2 source evidence | No class decomposition required |
| C30–C31, C63 | `perf/c64-memory` | One output/cache pressure evidence bundle; no second governor |
| C32–C34, C36 | `perf/c64-derived` | Probe only; derived scans/path grouping |
| C37, C50, C53 | `perf/c64-g4` | Generalization necessity review complete |
| C38, C43–C44, C49, C64 | `perf/c64-network` | Probe only; remote freshness/SSE/startup/attribution |
| C39–C40 | `perf/c64-g3` | Recent-activity hook and direct acceptance |
| C41–C42, C45 | `perf/c64-status` | Probe only; authoritative status/durable upsert |
| C46–C47 | `perf/c64-static` | Static server owner; Vite changes wait for g5 handoff |
| C48, C57 | `perf/c64-g4` | Real API/Core bounded payload probe |
| C51–C52, C55–C56 | `perf/c64-lifecycle` | Invariant/lifecycle proof; reuse G0 suite evidence |
| C58 | `perf/c64-g0` | Single shared post-W1 baseline |
| C59–C60 | `perf/c64-g5` | Launcher and CSS experiments, separately compared |
| C61 | `perf/c64-build` | Existing selective build graph, default/explicit Core and Full |
| C62 | `perf/c64-oci` | Isolated Core/Full OCI acceptance and resource metrics |

## Final dispositions

Completed evidence-backed rows will be appended after review. Each row must include ID, gate, decision, baseline/head SHA, changed paths, comparison scenario, actual before/after values, semantic regression, verification commands/results, relative evidence links, and residual risk/reconsideration conditions. `BLOCKED` remains incomplete. Native IME, unavailable external GitHub proof and long idle are reported separately as `NOT_CHECKED` when applicable.


| ID | Gate | Owner | Decision | Baseline / head | Changed paths | Comparison scenario | Before → after | Semantic regression | Commands / result | Evidence | Residual risk / reconsideration |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C37 | G4 | Luna Max G4 / Sol | DECLINED | `a1587e78` / `915585e4` (runtime unchanged) | None | Current generic File/Snapshot storage versus proposed general hierarchy | Generic safe-path read/list and multi-file writes already available; no new consumer requiring a hierarchy rewrite. Latency A/B not applicable: no runtime change or performance claim. | Existing scene adapters retained; generic Markdown/binary round-trip test inspected. | Source/consumer review PASS; `git diff --check` PASS. Runtime cases not rerun for documentation-only decline; no unexecuted test called PASS. | [G4 C37](CORE-64-G4-EVIDENCE.md#c37--generic-file-access-already-sits-below-the-scene-hierarchy), [G2 consumers](CORE-64-G2-PLAN.md) | Reconsider only for a named consumer with a measured missing capability; general file-browser UX remains outside this change. |
| C50 | G4 | Luna Max G4 / Sol | DECLINED | `a1587e78` / `915585e4` (runtime unchanged) | None | Existing path/revision operation contracts and scene adapters versus type redesign | `FileChange`, `ChangeOperation`, `SnapshotReader` and `DocumentSource` already serve generic paths. No accepted consumer requires a new type layer. No latency A/B or gain claimed. | Existing read/write/checkpoint/history adapters unchanged; binary checkpoint/publish/replacement test inspected. | Source/consumer review PASS; `git diff --check` PASS. No new runtime verification required for unchanged code; referenced test execution awaits G0 log evidence. | [G4 C50](CORE-64-G4-EVIDENCE.md#c50--generic-operation-types-already-coexist-with-scene-adapters) | Reconsider a minimal adapter for a demonstrated consumer gap; external SDK/platform remains out of scope. |
| C53 | G4 | Luna Max G4 / Sol | DECLINED | `a1587e78` / `915585e4` (runtime unchanged) | None | Nine built-in module ID catalogs versus dynamic manifest generalization | Explicit catalogs confirmed in type, validator and generator. No accepted module addition is blocked; redesign has no demonstrated performance gain. A/B not applicable. | No catalog/profile/import/activation behavior changed. | Source/consumer review PASS; `git diff --check` PASS. Module-addition effort/runtime cost NOT_CHECKED; no measurement inferred. | [G4 C53](CORE-64-G4-EVIDENCE.md#c53--nine-hard-coded-module-ids-have-no-measured-maintenance-bottleneck) | Reconsider when an in-scope module addition exposes registry inconsistency or repeated correctness failures. |
| C24 | G2 | Luna Max G2 / Sol | DECLINED | `a1587e78` / `53099848` (runtime unchanged) | None | CoreStore decomposition versus selected pinned-reader leaf | Current project/reader/mutation/transport methods already expose the call boundaries needed by the scoped probes. Splitting their class does not remove the measured Git/FS calls; no selected leaf requires a class-wide extraction. No execution-time gain claimed; A/B not applicable. | Public API, coordination and dependency direction unchanged. | Source and leaf-boundary review PASS; `git diff --check` PASS. No runtime suite rerun for documentation-only decline. | [G2 C24 and leaf boundaries](CORE-64-G2-PLAN.md#candidate-evidence-and-smallest-next-unit) | Reconsider a small extraction only if an accepted measured hot-path change requires it or a concrete dependency/testability defect blocks that change. |
| C14 | G1 | Luna Max Journal / Sol | DECLINED | `a1587e78` (runtime body, G0 `80ab121a`) / `0fef186a` (runtime unchanged) | Probe/report only; production/schema none | Chromium155 native IDB; 100KiB/1MiB fields; n20 | Logical fields 307,200/3,145,728 UTF8 bytes; JSON 308,892/3,147,428. Restore p50/p95/p99 2.9/7.4/10.2 and 19.6/20.4/29.4ms. No after cohort because rewrite declined. | Exact text/base/write restore PASS. No schema change; migration/crash/physical record bytes NOT_CHECKED. | Frozen-runtime Vite/Chromium probe complete PASS; Node syntax and diff checks PASS. Common unchanged production tree has [G0 checks](G0-CORE-64-BASELINE.md#verification-and-reusable-runtime); no new full suite for probe-only decline. | [C14 evidence](CORE-64-JOURNAL.md#c14--duplicated-journal-payload-and-restore), [raw](results/core64-journal/raw.json) | Origin estimate unchanged at73,728, not physical bytes. Retain full recovery inputs; reconsider if measured storage/restore pressure justifies versioning plus old-schema/failure proof. |
| C15 | G1 | Luna Max Journal / Sol | DECLINED | `a1587e78` / `0fef186a` (runtime unchanged) | Probe/report only | Same-document protected checkpoint history1/100/1k; n20; newer draft strict transaction | p50/p95/p99 1.8/2.3/2.5, 8.4/10.0/10.8, 76.5/82.8/84.4ms. One strict readwrite transaction and one documentKey getAll returning1/100/1000 rows. No alternative index adopted or after value inferred. | Stale/equal-generation different-operation denied; foreign-author high generation preserved and did not block owner PASS. | Actual native-IDB probe PASS; syntax/diff PASS; unchanged runtime covered by G0 suite. Concurrent tabs, quota/crash and migration NOT_CHECKED in this probe. | [C15 evidence](CORE-64-JOURNAL.md#c15--strict-putlatestdraft-scaling-and-generation-isolation), [summary](results/core64-journal/summary.json) | 1k occupancy has real cost; no alternative gain/migration proof. Reconsider for representative retained-history pressure with atomic index migration and before/after evidence. |
| C16 | G1 | Luna Max Journal / Sol | DECLINED | `a1587e78` / `0fef186a` (runtime unchanged) | Probe/report only | 1k entries and1k proposals across10 repos, n20; separate same-repo author challenge | Full inventory p50/p95/p99 entries80.5/86.7/86.8ms, proposals66.5/79.3/101.8ms; JSON2,245,143/1,451,124 bytes. Existing repo index reduces scoped reads; supplement fetched3 selected-repo rows and returned2 owner rows. No runtime change or new index. | Global inventory purpose retained. Supplement excludes same-repo guest and other-repo owner for both stores PASS; original timing fixture tested repo isolation only. | Global Chromium probe and scoped-only semantic proof complete PASS; syntax/artifact/diff checks PASS. G0 covers unchanged production tree; startup TTI, interrupted schema migration NOT_CHECKED. | [C16 evidence](CORE-64-JOURNAL.md#c16--full-and-repository-scoped-inventory), [author proof](results/core64-journal/scoped-author-proof.json) | Preserve full reconciliation inventory and existing scoped APIs. Reconsider only for measured user-visible startup/inventory bottleneck requiring a new query; no generalized schema rewrite now. |
