# Core 64 status and recent-activity measurements

Run date: 2026-10-21. The raw JSON files in this directory are byte-identical to the campaign copies under `/data/core64-status.8Z29QzLB/`. SHA-256 values and source/runtime identity are in [manifest.json](manifest.json).

The probes imported G0's frozen compiled API from `/data/scriptorium-core64-worktrees/g0`. That worktree is at `80ab121ad08b2c5f5957e3405eed511762fb1747`, clean, and its tracked `packages/` tree matches runtime SHA `a1587e784788fa87d86c0eb7ab175d7a28a3209f`. Runtime was Node 24.21.0 on Linux x64, kernel 6.18.52. Temporary data used `/data/g3stmp/c64-status.1t2iYRIK`; the JSON records include runtime root, full runtime SHA, and Node/platform/kernel details.

## C41 — `VERIFIED_EXISTING`

The signed local status probe completed 20 requests against each synthetic fixture (1 and 100 persistence rows) and one 100-row revision-race control. Each stable request made exactly two observations, pinned the reader to the first commit, listed once, and read the expected rows. The controlled second-observation mismatch returned `persistence.state = "unknown"` while the reader remained pinned to the first commit.

| Synthetic rows | Requests | Wall p50 | Wall p95 | Wall max |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 1.51 ms | 5.70 ms | 31.53 ms |
| 100 | 20 | 1.58 ms | 2.35 ms | 6.38 ms |

Verdict: retain the existing paired authority check and unknown-on-race behavior. These are local fake-store request times, not hosted status or GitHub latency. Hosted status, GitHub call counts, k3s probe/reconcile, and timeout rates are **NOT_CHECKED** because no authorized hosted fixture was supplied. Three API shutdown warnings said local checkpoint state could not be determined by the synthetic fixture; requests and assertions passed, and the warnings occurred outside the timed request loop.

## C42 — `DECLINED` production persistence change

The existing durable `RecentActivityStore.upsert` ran 10 repeats for each workload. Operation latency aggregates include 1,000 individual calls for each 100-write burst; batch latency is across 10 batches.

| Workload | Batch wall p50 / p95 | Operation p50 / p95 | Median final state |
| --- | ---: | ---: | ---: |
| One fresh upsert | 4.82 / 8.65 ms | 4.80 / 8.59 ms | 507 B |
| 100 writes, one author, alternating devices | 488 / 542 ms | 249 / 471 ms | 633 B |
| 100 writes, 100 authors | 549 / 576 ms | 266 / 518 ms | 46,665 B |

Across a 100-write batch, median cumulative file-sync and directory-sync durations were 79.0 ms and 112.1 ms for one author, and 83.2 ms and 112.0 ms for 100 authors. Median state-read bytes were about 62.5 KiB and 2.31 MiB respectively. The values include in-process instrumentation and describe a synthetic burst on this host; they do not establish a production workload gain. Owner scoping, both device cursors, and unrelated-author emptiness assertions passed after reopening the store.

The recovery fixture injected a 259-byte write of an intended 518-byte temporary record, then sent SIGKILL before sync or rename. A fresh store retained the previously committed cursor, and a subsequent upsert succeeded. The isolated incomplete temporary file remained. This is a controlled partial-temp-write test, not a random-kill or multi-process-writer test.

Verdict: decline a production storage change. The burst shows measurable serialized-write and sync cost, but no alternative that preserves bounded parsing, owner/repository isolation, atomic replacement, and crash recovery was tested or shown safe. Keep the existing durable primitive; claim no improvement. Multi-process writer behavior remains **NOT_CHECKED**.

## Focused verification and run notes

The following precompiled G0 tests passed without rebuilding:

```sh
# From /data/scriptorium-core64-worktrees/g0/packages/api
node --test --test-name-pattern='binds hosted API access and signed lifecycle controls|keeps a quiesce census unverified' dist/server.test.js
# 2 passed, 0 failed
node --test --test-name-pattern='keeps per-device cursors private, owner/repository scoped, and durable' dist/recent-activity-store.test.js
# 1 passed, 0 failed
```

The successful bounded probe commands were:

```sh
TMPDIR=/data/g3stmp/c64-status.1t2iYRIK node scripts/performance/core64-status-authority.mjs /data/core64-status.8Z29QzLB/authority.json 20 --runtime-root /data/scriptorium-core64-worktrees/g0
TMPDIR=/data/g3stmp/c64-status.1t2iYRIK C64_STATUS_REPEATS=10 node scripts/performance/core64-status-store.mjs bench /data/core64-status.8Z29QzLB/store.json --runtime-root /data/scriptorium-core64-worktrees/g0
TMPDIR=/data/g3stmp/c64-status.1t2iYRIK node scripts/performance/core64-status-store.mjs crash /data/core64-status.8Z29QzLB/crash-recovery.json --runtime-root /data/scriptorium-core64-worktrees/g0
```

An initial C42 benchmark attempt produced no result because the probe's `open` instrumentation failed to return the wrapped `FileHandle`; it exited at `handle.sync`. The wrapper was corrected to return the handle, syntax-checked, and the successful 10-repeat run above was executed. No production source changed. The crash child emitted Node's unsettled-top-level-await warning while intentionally waiting to be killed; the parent observed SIGKILL and all recovery assertions passed. No install, build, full test suite, audit, or other workload was run in this leaf.
