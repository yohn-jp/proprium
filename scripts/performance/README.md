# Core benchmark harness

Run from the repository root. This uses existing Core/API builds, the normal
production desktop bundle and real IndexedDB. It never imports an optional plugin
or changes production source, dependencies, authentication or writer guarantees.

```sh
pnpm install --frozen-lockfile
SCRIPTORIUM_PROFILE=core pnpm build
# On hosts needing a system browser, export SCRIPTORIUM_E2E_CHROMIUM first.
node --test scripts/performance/*.test.mjs
node scripts/performance/run.mjs /tmp/scriptorium-benchmark
node scripts/performance/summarize.mjs /tmp/scriptorium-benchmark/results
```

The output root must not exist. Every worker uses a fresh process, Core store and
bare remote cloned from an immutable generated seed. Publish writes only to that
worker's local synthetic remote. Sizes run sequentially to avoid competing load.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BENCH_SIZES` | `small,medium,large,stress` | Dataset tiers to run |
| `BENCH_REPEATS` | `20` | Read/input/switch repetitions; mutation has at most five |
| `BENCH_TIMEOUT_MS` | `180000` | Entire worker time budget |
| `BENCH_IDLE_MS` | `35000` | Visible/available hidden idle window |
| `SCRIPTORIUM_E2E_CHROMIUM` | Playwright default | Optional system executable |

Workers have a time budget, retain completed result snapshots atomically, and
terminate their process tree on timeout, including detached Chromium children.
Remaining operations are `NOT_CHECKED`; the budget is not a completed latency or
proof that the scale is unsupported. Other workers continue. Raw execution status,
errors, worker source commit/checksum, native Git traces and partial browser CPU
profiles preserve the distinction. Do not combine superseded diagnostics with
corrected primary measurements.

## Fixtures and focused runs

Synthetic tiers contain exactly 10/1,000/10,000/100,000 tracked files, varied
volume/chapter hierarchies and fixed paragraph manuscripts of 1 KiB, 100 KiB and
1 MiB. Other manuscripts are 4 KiB at medium and 1 KiB otherwise. Large/stress
include a deliberately compressible 10 MiB binary. Stress has 100 deterministic
metadata commits. Manifests record actual counts, bytes and seed SHA; Git integrity
and history counts are checked. Fixture construction disables automatic Git
maintenance; measured Core Git execution retains its existing settings.

```sh
node scripts/performance/dataset.mjs /tmp/new-fixture small
node scripts/performance/core.mjs /tmp/new-fixture /tmp/read.json 20 read
node scripts/performance/browser.mjs /tmp/new-fixture /tmp/browser.json 20 35000
```

Core workloads are `read`, `mutation`, `revisions`, `search` and `stats`.
`mutation` times the public propose → approve → checkpoint → publish pipeline,
preparing a revision-bound operation with `readSceneSnapshot`. The optional
`legacy` workload separately measures `saveScene`; do not present that convenience
path's metadata scan as the current UI checkpoint. Search uses an absent needle
to exercise the full Core scan, independently of optional search plugins.

A ten-file short-document control is separate from the input-size
matrix. Generate it with:

```sh
node scripts/performance/dataset.mjs /tmp/new-small-short small short
```

All three control manuscripts are 1 KiB. Run the same five Core workloads and the
browser against this fixture. Name results `read-small-short.json`, etc., and copy
its manifest to `dataset-small-short.json` before summarizing. Scene IDs distinguish
equally sized browser phases. Run all tiers for a baseline, not just a smoke case.
No user repository/manuscript is read; generated fixtures remain outside Git.

## Interpretation

- Quantiles use nearest rank and retain `n`. With n=1 all percentiles are the same
  observation; with n=20 p99 is the maximum. These are not stable tail estimates.
  Successive mutation samples evolve Git history rather than independent starts.
- Per-operation Node wall time, CPU microseconds, current RSS, process-lifetime
  peak RSS and `/proc/self/io` are captured. CPU excludes child Git processes.
  Character I/O includes pipes/cache; kernel read/write bytes are storage
  accounting. Linux [proc I/O](https://man7.org/linux/man-pages/man5/proc_pid_io.5.html) also includes reaped child activity; this differs from the Node-only CPU/RSS fields. Diagnostic proc reads add overhead. Async readFile counts are not
  a syscall census. Process memory includes retained probes.
- Core-issued execFile/spawn counts differ from all OS executions. Native Git
  traces include nested invocations and setup. In-memory command samples cap at
  1,000; `gitCommandLogDropped` counts omitted argument vectors, not missing process
  counts. Capped and uncapped command logs have different memory costs and are not directly comparable.
- Input is keydown/beforeinput-to-next-rAF, a frame-opportunity proxy rather than
  OS input-to-pixel latency. Typing waits two animation frames after each key.
  Longer delays extend the phase and allow more 350 ms autosaves between keys;
  counts are not fixed-rate human typing. Arrows follow as a burst, then undo/redo,
  synthetic Japanese composition and paste. Synthetic composition does not exercise native OS IME.
- Scene switches include automation/readiness and reset the cursor to verify the
  synthetic header. Scoped scene/editor selectors avoid whole-page accessibility
  scans across 50,000 buttons. Actions/assertions allow 60 seconds; the worker
  budget still bounds the scenario. A readiness failure is not a finished latency.
- A DevTools hook counts real production React commits and traverses committed
  fibers. Flagged fibers are not component render counts. Component durations and
  allocated bytes are unavailable. No profiling React build is substituted.
- Long Tasks, CDP renderer metrics, V8 CPU profiles, completed encoded HTTP bytes,
  request starts and request-to-finish server times are retained. Server timings
  include async waits. Browser CPU/RSS are sampled at phase boundaries; summed RSS
  double-counts shared pages and is neither PSS nor a continuous peak.
- IDB store/index read calls and result counts include the journal documentKey
  index. Transactions retain their actual durability/mode and completion/abort
  status. Pending/aborted transactions are not successful writes. Origin storage
  estimates are approximate, not journal-only bytes or physical fsync counts.
- UI checkpoint/publish waits for actual successful receipts. Idle starts after
  finite requests and the cursor debounce settle. The persistent jobs/events fetch
  stream stays open and counted; global networkidle is unsuitable. Completed
  response timings/transfer totals exclude open-stream duration/body bytes. Its
  CPU/RSS cost remains in the idle window.
- Hidden idle runs only if Chromium actually reports hidden after another tab is
  foregrounded. The probe tab is then closed. No visibility override fabricates
  this result. Playwright disables some background throttling; this differs from
  a daily-use browser. Short idle windows do not certify hourly/24-hour behavior.
- All probes add overhead: wrappers, fiber traversal, IPC snapshots, trace output
  and V8 sampling are opt-in benchmark work. There are no production timers,
  services or hooks. Compare revisions with identical probes, hardware, toolchain
  and fixtures; these are not uninstrumented production timings.

`summarize.mjs` emits operation CPU/I/O/RSS/Git distributions, browser input/IDB/
HTTP/idle metrics in `summary.json` and readable `tables.md`. Raw results remain
authoritative. OCI, hosted GitHub traffic, crash/multi-tab loads, physical IME
and long-duration soak require their own measured workloads; never fill missing
observations. Keep output outside the checkout or under ignored `artifacts/`.

The [performance guide](../../docs/performance/README.md) describes comparison
requirements. Immutable runtime/artifact identities required by specialized
probes are retained under `evidence/performance/`.
