# Core derived scans and hierarchy (C32/C33/C34/C36)

**Decision:** accept the measured operation-local lookup reuse for Core search and writing statistics, and the one-pass hierarchy grouping map. Decline a resident/general derived index for this unit. Core and optional Search retain separate owners. The implementation uses the existing 4,096-entry `snapshotTreeLookup` only within each pinned operation; the hierarchy map exists only while `hierarchySnapshot` assembles one tree.

## C32 and C33: pinned search and statistics

Five fresh workers ran Core search and writing statistics sequentially against the same 1,000-file fixture commit and same pinned snapshot in each worker. Before and after had five complete workers. Search result hashes and statistics hashes match exactly before and after; every worker returned the pinned remote commit.

| Operation | Before p50 | Before p95 (max, n=5) | After p50 | After p95 (max, n=5) |
| --- | ---: | ---: | ---: | ---: |
| Search | 30.89 s | 37.88 s | 10.19 s | 11.41 s |
| Writing statistics | 33.80 s | 39.88 s | 10.26 s | 12.73 s |
| Sequential pair | 67.91 s | 77.75 s | 21.17 s | 24.15 s |

The paired median fell 68.8%, Node CPU fell from 25.60 s to 8.74 s, and summed Git processes fell from 12,987 to 4,079 (68.6%). `ls-tree` launches fell from 10,977 to 2,069 (81.2%); blob reads stayed at 1,994. The cumulative operation RSS sample p50 fell from 218.9 MiB to 206.1 MiB.

The pair still reads 986 manuscript/scratch documents and 6,318,080 body bytes per worker, or 493 documents and 3,159,040 bytes per operation. Metadata reads remain 1,008 per pair. This change reduces repeated Git path-segment lookup, not the full scan or body decoding. It does not add a blob-count cache or full-text index. The observed reduction supports the existing bounded lookup as the smallest useful C32/C33 change; optional Search remains independent.

The 1,000-file p95 and p99 are each the maximum of five workers, not a formal service percentile. The 10,000-file combined scan was not completed: the before worker reached its 180-second cap while search was pending, and the candidate-after scan was not run. Both large scan states are `NOT_CHECKED`; no 10,000-file search or statistics latency is inferred.

## C34: one-pass hierarchy grouping

Cold tree profiles used five fresh workers each at 1,000 and 10,000 files. Tree hashes match exactly before and after at both sizes. The 10-file G0 fixture also produced exact tree parity against the candidate: SHA-256 `188d597fd606e4de07abc7caa052f6a5c8b86c5dd7ee160be3647e094cb9fc6b`. That 10-file check was semantic-only; it makes no new timing or CPU claim.

The direct `hierarchySnapshot` method wall p50, which includes both `readHierarchyYaml` and post-read assembly, was 101.69 ms before and 99.24 ms after at 1,000 files, and 558.23 ms before and 526.42 ms after at 10,000 files. This timer starts after the benchmark wrapper's `Profiler.start` request and ends when the original method returns, before the wrapper awaits `Profiler.stop`. The post-`readHierarchyYaml` grouping/assembly wall residual is calculated by subtracting the separately timed YAML read: it was 3.93 ms before and 3.57 ms after at 1,000 files, and fell from 70.10 ms to 21.57 ms (69.2%) at 10,000 files. This residual supports the grouping attribution. The 10,000-file `readHierarchyYaml` p50 was 487.50 ms before and 503.12 ms after. The separately measured outer profiled cold-tree p50 was 897.93 ms before and 599.65 ms after, with a before p95/max of 1,820.21 ms; it includes cold-read wrapper and profiler start/stop overhead, and its delta is not attributed entirely to grouping.

A representative baseline V8 profile sampled the compiled per-chapter `files.filter(...)` frame at 39.1 ms; that frame was absent from the candidate's top frames, where `addHierarchyChild` was 2.11 ms in the representative worker. The CPU profile also sampled `node:inspector` stop overhead, so its sample totals are attribution hints, not an exact CPU census. The repeated path scan and the five-worker post-read wall residual support the local parent-to-children map. Existing first-seen order, title/order sorting, duplicate checks, and missing volume/chapter metadata fallbacks remain in place.

The 100,000-file candidate profile was not run. The existing G0 100,000-file cold-tree sample is a separate single observation and is not a matched before/after comparison.

## C36 decision and preserved behavior

C36's resident or general shared index is declined for this unit. The matched pair shows duplicate immutable body reads across search and statistics, but the measured candidate addresses the dominant repeated path lookup without adding store-wide state. Body reads and bytes remain unchanged, and no separate cross-operation content-cache candidate was measured. No optional module import, timer, worker, or default index was added.

Focused Core regressions cover UTF-16 search offsets after an astral character, exact title and scratch results, result scope, pinned results across a manuscript rename and deleted old path, checkpoint-only versus remote results/statistics, missing hierarchy metadata fallback, ordering, and malformed YAML rejection. Existing checkpoint/reorder and remote-observation transaction tests also pass.

## Validation

- Frozen offline install completed before the code edit with zero downloads; the lockfile is unchanged.
- `pnpm typecheck` — pass.
- `pnpm test` — pass; Core 77/77, with one existing opt-in Semantic CPU case skipped in the workspace suite.
- `SCRIPTORIUM_PROFILE=core pnpm build` — pass; Vite emitted its existing large-chunk warning.
- Stock `pnpm audit:core` could not locate `node_modules/.pnpm` because the frozen install uses the external `/data` virtual store. The same audit script passed against a hardlinked view of that exact store, scanning 128 production dependency versions across Core/API/app output.
- Focused Chromium 155 Core-profile acceptance — pass 3/3: pinned history/tree observation, multi-document Draft/Checkpoint/GitHub workflow, and Core-only workspace authoring.

The full-profile browser matrix, WebKit, and OCI acceptance remain central G5 checks and were not run in this bounded unit. Detailed measurements, command logs, and checksums are in [the results record](results/core64-derived/RESULTS.md) and [artifact manifest](results/core64-derived/SHA256SUMS.txt).
