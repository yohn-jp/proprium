# Core C01–C64 results

Canonical contract: [CORE-64-GOAL.md](CORE-64-GOAL.md), frozen at `a1587e784788fa87d86c0eb7ab175d7a28a3209f`. Initial main and origin/main both resolve to that SHA (2026-10-20 JST).

Goal status: **in progress; 0/64 final dispositions recorded**. Existing W0/W1 changes remain accepted history; this count describes the new final ledger, not the number of implemented optimizations. Pending candidates are not completed rows. No pending verification is PASS.

## Execution ownership

Sol coordinates, reviews and serially integrates/pushes main. Each Luna Max worker uses its own branch/worktree from the frozen initial SHA; subsequent implementation leaves receive the current integrated base. No PR, Actions, Inari or external Plugin Platform work is authorized.

| Gate / fixed IDs | Worker / branch | Exclusive production ownership | Current bounded unit |
| --- | --- | --- | --- |
| G0 C58 baseline | Luna Max / `perf/c64-g0` | Existing harness; changes require coordination | One post-W1 environment/fixture/verification baseline |
| G1 C01–C19 | Luna Max / `perf/c64-g1` | `SharedApplication.tsx`, editor, journal | Reuse W1 evidence; propose measured leaf boundaries |
| G2 C20–C36, C54; linked C63 | Luna Max / `perf/c64-g2` | `packages/core/src/index.ts` | Identify pinned-read/batching/cache evidence and leaves |
| G3 C38–C47; linked C64 | Luna Max / `perf/c64-g3` | `packages/api/src/server.ts`, API tests | API/network evidence and leaves; request G1 edits through owner |
| G4 C37, C48–C53, C55–C57 | Luna Max / `perf/c64-g4` | No product changes allocated | Preliminary contract/necessity evidence, finalized after consumer gates |
| G5 C59–C62; C58/C63 shared evidence | Luna Max / `perf/c64-g5` | Vite/entrypoints, root build scripts/package, Dockerfile | Build/OCI preflight and experiment boundaries |

G0 precedes implementation comparisons. Independent G1/G2/G3/G5 investigations run concurrently. G4 decisions use the consumers established by prior gates. Shared contracts C30/C31/C63, C46/C47, C48/C57, C21/C22/C35/C54 and C32/C33/C36 each use one implementation/evidence source. File ownership prevents concurrent edits; cross-owner changes must be sequenced.

G0 initially holds the exclusive heavy benchmark/full verification lease. Other workers inspect existing code/evidence only. Measurements and full checks are scheduled sequentially when they compete for CPU, memory or fixtures. `/data` has a separate filesystem with about 104 GiB available at preflight; root has about 2 GiB. Synthetic datasets/raw evidence go to unique campaign paths under `/data`; unrelated worktrees/artifacts are preserved.

## Final dispositions

Completed evidence-backed rows will be appended after review. Each row must include ID, gate, decision, baseline/head SHA, changed paths, comparison scenario, actual before/after values, semantic regression, verification commands/results, relative evidence links, and residual risk/reconsideration conditions. `BLOCKED` remains incomplete. Native IME, unavailable external GitHub proof and long idle are reported separately as `NOT_CHECKED` when applicable.
