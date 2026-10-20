# Core 64 read and status overhead probe

This bounded G2 probe covers C20, C25, C26 and C29 from the canonical [Core 64 goal](CORE-64-GOAL.md). It compares `readSceneSnapshot` with `readSceneViews`, counts per-request Git commands and registry reads/bytes, records project-lock wait separately from Git child time, and exercises `status()` against an unchanged and advanced local bare remote.

The probe uses the existing Core performance instrumentation and one existing synthetic fixture. It does not add a cache, change the read lock boundary, or suppress remote freshness checks. The contention phase pauses a real approved checkpoint immediately before `createCommit`, queues a reader pinned to the remote commit and a second approved writer based on the same old document revision, then checks that the pinned reader still returns the old remote content and the stale writer receives `operation_precondition_conflict` without moving `refs/scriptorium/checkpoint-head`.

## Preparation

Branch: `perf/c64-read-overhead`, prepared from `53099848caa237a69c098c6f83bad00d9368184d`. The probe loads the accepted compiled Core runtime from `/home/sophia/src/scriptorium-c64-derived`, commit `f633da0b3f133ad812953c284aab35a4956d2507`; it refuses to run unless `packages/core/dist/index.js` has SHA-256 `a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`. This binds measurements to the accepted production artifact without rebuilding Core. The G2 plan and source-of-truth candidate descriptions are [CORE-64-G2-PLAN.md](CORE-64-G2-PLAN.md) and [CORE-64-GOAL.md](CORE-64-GOAL.md#c20--readtreereadersearch等もmutation-file-lockを取得).

The probe runs only against the existing `medium` synthetic dataset (1,000 tracked files, 493 scenes). It records 20 `readSceneSnapshot` and 20 `readSceneViews` requests with one registered project, then repeats that cohort with five registered projects. It then records 20 unchanged `status()` requests, advances a separate local bare remote by one synthetic commit, captures the first changed-head `status()` request, and records 20 post-fetch requests. The changed-head sample must report `behind: 1` and fetch the advertised commit. At the default repeat count this is 124 timed API calls: 80 scene reads, 41 status calls and 3 contention requests. Setup, proposal/approval, warmup and postcondition reads are outside that timed cohort.

The contention phase uses the same fixture, one project, a 250 ms controlled pause during an approved checkpoint, a pinned remote reader, and an approved stale writer with the original file revision. Lock queue/acquisition wait is measured around the existing `withLock` call. Git child wall time and command names are attributed to the active request with benchmark-only process instrumentation. Per-request registry byte counts use the stable `projects.json` size and direct `readRegistry` call count. The run is pinned to CPUs 4-7; the probe checks Linux's effective CPU set and records it. Contention call wall times overlap by design, so they are observations of queue behavior, not independent latency samples.

After the parent grants the exclusive measurement lease, run the bounded probe with new paths. The accepted derived runtime is already built, so this does not install dependencies or start another build:

```sh
taskset -c 4-7 node scripts/performance/core64-read-overhead.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/medium \
  /data/scriptorium-core64-read-overhead-<run-id> \
  docs/performance/results/core64-read-overhead/medium.json \
  /home/sophia/src/scriptorium-c64-derived 20
```

The script refuses to reuse an existing work directory or overwrite its result. It retains only the compact JSON report in the repository; generated clones and Core state stay under the unique `/data` work directory.

## Results and decision

The bounded run completed all 124 timed API calls with `status: complete`. Its raw JSON is [medium-cpu4-7-20261021-01.json](results/core64-read-overhead/medium-cpu4-7-20261021-01.json). The report records the probe source commit and script SHA, accepted runtime commit and compiled artifact SHA, effective CPU affinity 4-7, and synthetic dataset commit. No production source changed.

Across both project counts, `readSceneSnapshot` used 9 Git child processes and one registry read per request. With one project its p50/p95 were 61.28/74.97 ms and registry bytes were 648; with five projects they were 54.33/58.26 ms and 3,228 bytes. Each request read `refs/remotes/origin/main` twice, `refs/scriptorium/checkpoint-head` once and `HEAD` once. `readSceneViews` used a median 17 Git child processes and three registry reads per request. Its p50/p95 were 120.30/134.57 ms at one project and 102.41/124.61 ms at five projects. It read 1,944 and 9,684 registry bytes per request, respectively. Its occasional cold reconciliation samples reached 24 Git children. These paired API timings show the cost of selecting both views on this fixture; they do not imply that a single-view call can replace the two-view API.

Unchanged `status()` used 7 Git child processes per request, including two `ls-remote` calls, and one registry read. Its p50/p95 were 89.61/102.27 ms before the remote advance and 91.75/104.11 ms after fetch. The changed-head call reported `behind: 1`, performed a fetch, and moved the tracked ref to the advertised commit. The fixture is a local bare remote, so the latency is local Git work and does not represent hosted-network latency or bytes.

In the contention scenario, the controlled checkpoint pause was 250 ms. The pinned read waited 1,151 ms for its lock and then took 65 ms in its lock action; the stale writer returned `operation_precondition_conflict`. All recorded invariants passed: the successful checkpoint committed, the reader retained the original remote commit and content, the stale writer did not move the checkpoint head, and the successful checkpoint remained the current checkpoint view. These calls overlapped, so their wall times are observations of lock queue behavior, not independent latency samples.

The existing performance instrumentation's shared 1,000-command history filled during the cohort; its `commandLogComplete: false` flags and `gitCommandLogDropped` values describe that bounded global history. The probe's request-local Git command arrays still match process counts for every serial scene-read and status sample. For overlapping contention requests, shared process-counter deltas cannot be assigned to individual calls; the saved per-request command arrays and timing remain observational.

The measured `readSceneViews` overhead is material: roughly 2x p50 latency, eight more median Git children and two more registry reads than `readSceneSnapshot`. A safe request-local reuse is not recommended from this cohort. In [Core's implementation](../../packages/core/src/index.ts), `readSceneViews` selects the pinned remote and current checkpoint separately, calls `reconcileUnlocked` for the checkpoint, and compares their snapshot keys, returning `snapshot_changed` if the remote identity/commit changed between selections. `requireReadObservation` also checks the current local remote-tracking ref on each selection. Skipping or reusing that second selection would bypass the changed-snapshot guard; a request-local registry-record cache has no isolated latency result here and could also hide a concurrent registry update. The extra reads and ref checks should remain until a narrower change can preserve those invariants and demonstrate an A/B benefit. Similarly, `statusUnlocked` calls `fetchRemoteUnlocked`; the unchanged remote probe and changed-head fetch are part of its freshness behavior and should not be cached.

The historical G0 `read-medium.json` result (p50 46.00 ms, p95 53.90 ms, 7 Git processes) is retained only as context. It used a different frozen runtime and did not pin this cohort's CPU affinity, so it is not an apples-to-apples performance comparison with the accepted f633 runtime measured here.
