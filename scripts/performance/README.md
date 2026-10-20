# Wave 0 benchmark harness

Run from the repository root after `pnpm install --frozen-lockfile` and
`SCRIPTORIUM_PROFILE=core pnpm build`. No optional module is configured or
instrumented. Production sources and dependencies are unchanged.

```sh
node --test scripts/performance/performance.test.mjs
# Set SCRIPTORIUM_E2E_CHROMIUM if the Playwright browser cannot run on this host.
node scripts/performance/run.mjs /tmp/scriptorium-wave0-fresh
```

The output directory must not exist. This guards against reusing changed Git
fixtures. `BENCH_SIZES=small,medium,large,stress`, `BENCH_REPEATS=20`,
`BENCH_TIMEOUT_MS=180000`, and `BENCH_IDLE_MS=35000` configure the run.
All sizes run sequentially to avoid self-induced competing benchmark load.
Each read/mutation/revisions/search/stats/browser worker has a separate process,
Core store and bare remote cloned from the immutable generated seed. Publication
writes only to that worker's disposable local remote. No GitHub fixture is used.

A worker timeout kills its process group and retains completed samples. Remaining
operations are `NOT_CHECKED`; a timeout is not a latency sample. Other workers
continue. Browser failures retain completed phases and observed metrics. Results
are written after each operation/phase. `execution` records the actual terminal
child status. Review failures before interpreting any results.

Use `dataset.mjs /tmp/new-dataset small` to generate one fixture, then
`core.mjs /tmp/new-dataset /tmp/result.json 20 read` or
`browser.mjs /tmp/new-dataset /tmp/browser.json 20 35000` for focused runs.
Core workloads: `read`, `mutation`, `revisions`, `search`, `stats`.
Run all four dataset sizes for a baseline, not just the smoke scenario.

Datasets have exactly 10/1,000/10,000/100,000 tracked files, deterministic Git
commit identities, varied volume/chapter hierarchies, and 1 KiB/100 KiB/1 MiB
paragraph documents. Other documents are 4 KiB at medium and 1 KiB otherwise.
Large/stress include a synthetic 10 MiB binary; stress has 100 deterministic
commits. Dataset manifests record actual tree bytes and counts. No real user data
is read. Generated Git fixtures/results stay outside the repository.

Measurements and limits:

- Nearest-rank p50/p95/p99 preserve sample count. With n=1 these are the same
  observation; with n=20 p99 is the maximum. They are not reliable tail estimates.
  Checkpoint/publish have up to five consecutive samples, on evolving history.
- Core per-operation wall time, Node CPU user/system microseconds, current RSS,
  process-lifetime peak RSS, and Linux `/proc/self/io` deltas. Node CPU excludes
  Git child CPU. I/O `rchar/wchar` includes pipes/cache; `read_bytes/write_bytes`
  is kernel storage accounting, not bytes read from Git objects. Diagnostic proc
  reads themselves add small syscall/read overhead. FS counters cover async
  `readFile` only; they are not a syscall census.
- Git wrappers count Core-initiated execFile/spawn calls and record commands;
  native `GIT_TRACE2_EVENT` also records nested Git invocations. Fixture creation
  and remote cloning are outside operation samples. Do not equate top-level
  counts with every OS exec. Git trace timing is not Git process CPU time.
- Browser loads the normal production desktop build. Input keydown/beforeinput
  to next requestAnimationFrame is a frame-opportunity proxy, not pixel paint or
  native event latency. Automation times for file switches include Playwright
  and document-ready assertions. Input, arrows, paste, undo/redo and CDP Japanese
  composition are exercised. Native OS IME remains `NOT_CHECKED`.
- React DevTools hook counts real production commits and traverses the committed
  fiber tree. Flagged fibers are not a component render census. Production
  component durations are unavailable. No React profiling build is substituted.
- Long Tasks, CDP renderer metrics and V8 CPU profile, encoded HTTP transfer,
  method/path request counts and server request-to-finish times. Server processing
  includes async waits. Linux process RSS and Chromium cumulative CPU time are
  sampled at phase boundaries; summed RSS double-counts shared pages (not PSS).
- IndexedDB transaction start-to-complete/abort, mode and unchanged durability,
  read API calls/result counts, plus origin `storage.estimate()` (not journal-only
  bytes, nor a count of physical fsync operations). Pending/aborted transactions
  must not be classified as successful writes.
- Visible idle is a measured short window; hourly request rates, if calculated,
  are extrapolations. Hidden idle runs only if Chromium actually reports hidden.
  Playwright disables several background throttling features: record this before
  comparing with a daily-use browser. A missing hidden window is `NOT_CHECKED`.
- All probes add overhead. The benchmark Node wrappers, browser fiber traversal,
  IPC snapshots, Git trace output and CDP CPU sampling are opt-in. There are no
  production timers/services/hooks. Compare revisions using identical probes,
  toolchain, hardware and datasets; do not claim these are uninstrumented timings.

`docs/performance/BASELINE.md` records the checked-in run, environmental gaps,
64-candidate mapping and proposed Wave 1 work. OCI, hosted GitHub networking,
crash recovery, actual hidden idle and 24-hour soak require separate environments
when unavailable; never fill those observations with estimates.

After every worker is terminal, run
`node scripts/performance/summarize.mjs /tmp/scriptorium-wave0-fresh/results`.
It writes `summary.json` (including operation CPU, I/O, RSS, Git counts, browser
input/IDB/HTTP/idle metrics) and `tables.md`. Raw results remain authoritative.
UI checkpoint/publish measurements await their actual successful HTTP receipts.
The idle window starts after those foreground requests and their refreshes settle.

Search uses an absent synthetic needle to measure the full Core scan rather than
stopping after 20 matching documents. It does not invoke an optional search module.
Each worker records its script checksum and source commit when started; raw run
metadata also records the coordinator's starting revision. If a harness correction
requires a rerun, preserve the original result as diagnostic evidence and identify
the corrected result explicitly in the baseline.

`mutation` times the current public `propose`, `approve`, `checkpoint` and
`publish` methods separately, with a revision-bound manuscript operation prepared
from `readSceneSnapshot`. The optional `legacy` workload measures the older
`saveScene` convenience path, which scans scene metadata. Never present its
latency as the current UI's checkpoint latency.
