# Core performance baseline — Wave 0

Measured 2026-10-20 on the unchanged Core runtime from `main@35902764b9ceb5380e333ab707560930efc718fa`. This is a reproducible, instrumented baseline, not an optimization or a performance-regression gate. No production source, dependency, recovery/authentication/Single Writer contract, optional plugin, CI workflow or migration ledger was changed. No Wave 1 implementation is included.

## Reproduction and provenance

Use the [harness instructions](../../scripts/performance/README.md). Install with `pnpm install --frozen-lockfile`, build with `SCRIPTORIUM_PROFILE=core pnpm build`, run the focused tests, then run the harness in a new external directory. Core workers use the built Core and API; the browser uses the normal production desktop bundle and real IndexedDB. Every workload gets its own process, store and disposable bare remote cloned from a fixed generated seed. Publish never contacts or writes a user repository.

Environment: NixOS Linux 6.18.52 x64, Intel Core i5-14600KF, 16 available logical CPUs, 50,994,450,432 bytes host RAM; Node 24.21.0, pnpm 12.10.1, system Chromium 155.0.8059.79, 1440×1000 headless desktop viewport. The downloaded Playwright Chromium cannot start on this host because `libglib-2.0.so.0` is unavailable; the system executable was used instead. This is a shared workstation, not a dedicated or hardware-normalized benchmark host. Filesystem/OS caches were not flushed; “cold” means a fresh Core process/cache. Native Git transport is local filesystem, not GitHub HTTP.

Worker time budgets are measurement guardrails, not proof that a scale is inherently unsupported. A NOT_CHECKED timeout means the requested series did not finish within the recorded budget; its completed samples remain observations and its unfinished operation has no invented latency.

The initial coordinator started at harness commit `842d94a` with `BENCH_REPEATS=20`, `BENCH_TIMEOUT_MS=120000`, `BENCH_IDLE_MS=35000`. Harness-only corrections during the campaign separated legacy saves from approved checkpoints, awaited actual UI receipts before idle, and recorded draft-phase storage estimates. The final primary browser workers use scoped selectors and finite-request settling (300 s worker cap, 60 s readiness limit); stress Core workers use a 180 s cap, while original large scan workers used 120 s. Each raw execution object records its exact cap. Worker checksums/source commits, raw results, diagnostics and replacement-run metadata distinguish these versions. Production sources remained identical throughout; superseded results are not silently combined with corrected observations.

Nearest-rank quantiles always retain `n`. At `n=1`, p50/p95/p99 are the same observation; at `n=20`, p99 is the maximum. These are descriptive observations, not stable tail estimates or statistical proof of a speed difference. Checkpoint/publish samples evolve local Git history, up to five successive operations; they are not independent cold starts. Browser input frame timings are keydown-to-next-rAF proxies, not OS input-to-pixel latency. File-switch timings include automation and readiness checks. Typing is closed-loop with two animation frames between keys. Large frame delays lengthen that phase and allow more 350 ms autosaves between keys; IDB counts are not a fixed-rate human-typing comparison. File-switch readiness resets the cursor to the top to verify the synthetic document header. All probes add overhead, including fiber traversal, strict-IDB listeners, Git trace output and V8 CPU sampling. Compare revisions only with the same harness, environment and datasets.

## Fixed synthetic datasets

The tracked file count includes project/volume/chapter/scene metadata, manuscripts, filler and attachments; `.git` and the external manifest are excluded. All data and history are synthetic. The small-short control has three 1 KiB manuscripts; the matrix variants use first manuscripts of exactly 1 KiB, 100 KiB and 1 MiB, with fixed ASCII paragraphs; keyboard ASCII, arrows, paste, undo/redo and CDP Japanese composition are exercised. A 10 MiB binary is deliberately compressible, not a representative photograph or entropy benchmark. Stress history has 100 deterministic metadata commits, not an arbitrary production history.

| Dataset | Files | Volumes / chapters / scenes | Tracked bytes | History commits | Seed SHA |
| --- | ---: | --- | ---: | ---: | --- |
| small-short | 10 | 1 / 1 / 3 | 3,549 | 1 | `7bc240abb70bd6c506a8645a66a3128fddd71842` |
| small | 10 | 1 / 1 / 3 | 1,152,477 | 1 | `e70bb509cc41b383451335e05af36d78f1cb31db` |
| medium | 1,000 | 1 / 10 / 493 | 3,216,993 | 1 | `773d4bb408f333e330e5359d74d43da8fe990554` |
| large | 10,000 | 10 / 100 / 4,944 | 17,306,597 | 1 | `1adbb44980a9ccee009c536c7593fb23503ed86c` |
| stress | 100,000 | 100 / 1000 / 49,449 | 68,743,498 | 100 | `86eb03604a68765553c4c89753af459f48c3950c` |

## Measurements

All values below are instrumented observations. `complete` means the requested worker finished; no latency target or speedup is implied. A NOT_CHECKED worker can contain valid completed samples, but its unfinished operation/series has no completed latency.

| Dataset | Reads | Approved mutation | Revisions | Search | Statistics | Browser |
| --- | --- | --- | --- | --- | --- | --- |
| small-short | complete | complete | complete | complete | complete | complete |
| small | complete | complete | complete | complete | complete | complete |
| medium | complete | complete | complete | complete | complete | complete |
| large | complete | complete | complete | NOT_CHECKED (120 s worker cap) | NOT_CHECKED (120 s worker cap) | complete |
| stress | NOT_CHECKED (180 s worker cap) | complete | NOT_CHECKED (180 s worker cap) | NOT_CHECKED (180 s worker cap) | NOT_CHECKED (180 s worker cap) | NOT_CHECKED (readiness/error; see raw result) |

Full operation quantiles, Node CPU/RSS, Git counts and browser/IDB measurements: [tables](results/2026-10-20/tables.md). Machine-readable CPU and I/O distributions, route timings/statuses, request counts, storage estimates and idle windows: [summary](results/2026-10-20/summary.json). [Artifact index and checksums](results/2026-10-20/INDEX.json) link the compressed raw results, CPU profiles and native Git traces. Diagnostics are retained under explicit names and excluded from primary summaries.

| Dataset | Scene read p50 / p95 / p99 ms | Approved checkpoint p50 / p95 / p99 ms | Publish p50 / p95 / p99 ms | Cold / warm revisions ms |
| --- | --- | --- | --- | --- |
| small-short | 41.33 / 46.23 / 48.97 (n=20) | 513.69 / 756.16 / 756.16 (n=5) | 846.28 / 1153.06 / 1153.06 (n=5) | 27.12 / 5.78 |
| small | 44.82 / 52.14 / 67.34 (n=20) | 524.26 / 754.75 / 754.75 (n=5) | 842.99 / 1151.62 / 1151.62 (n=5) | 30.61 / 6.19 |
| medium | 44.66 / 54.14 / 54.63 (n=20) | 549.29 / 733.51 / 733.51 (n=5) | 862.08 / 1137.78 / 1137.78 (n=5) | 2212.87 / 8.03 |
| large | 45.04 / 52.49 / 57.16 (n=20) | 645.36 / 887.08 / 887.08 (n=5) | 934.79 / 1306.90 / 1306.90 (n=5) | 24296.88 / 27.86 |
| stress | 10524.88 / 14838.03 / 14838.03 (n=7) | 1276.88 / 1461.20 / 1461.20 (n=5) | 1541.72 / 1844.36 / 1844.36 (n=5) | NOT_CHECKED / NOT_CHECKED |

Core I/O and resource examples use the first completed approved-checkpoint sample for each tier; they are neither whole-process totals nor child-Git CPU. Full distributions remain in the JSON.

| Dataset | Node CPU ms | Node RSS MiB | rchar / wchar bytes | Kernel read / write bytes | Async readFile calls | Top-level Git processes |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| small-short | 132.98 | 82.07 | 916,235 / 182,719 | 0 / 290,816 | 6 | 55 |
| small | 136.29 | 81.94 | 913,960 / 182,098 | 0 / 290,816 | 6 | 55 |
| medium | 140.97 | 87.21 | 5,044,700 / 1,072,547 | 0 / 1,175,552 | 6 | 55 |
| large | 137.45 | 129.03 | 6,583,087 / 9,210,285 | 0 / 9,297,920 | 6 | 55 |
| stress | 185.17 | 358.88 | 1,835,323 / 93,449,062 | 4,096 / 93,556,736 | 6 | 55 |

Browser input counts/quantiles and strict IDB transaction times are in the detailed table. Input phase commit/Long Task/read counts include arrows, composition, paste and undo/redo in that phase, not just the 20 letter keys.

| Dataset | Import→listen ms | File-switch p50 / p95 / p99 ms | Browser API request starts | Completed encoded HTTP bytes | Final origin usage bytes |
| --- | ---: | --- | ---: | ---: | ---: |
| small-short | 175.53 | 178.43 / 183.20 / 190.32 (n=20) | 89 | 1051442 | 81920 |
| small | 177.61 | 479.82 / 1959.89 / 2603.91 (n=20) | 101 | 35743048 | 81920 |
| medium | 176.37 | 503.42 / 2085.99 / 4297.83 (n=20) | 104 | 35891676 | 81920 |
| large | 171.96 | 757.54 / 5292.85 / 6924.16 (n=20) | 107 | 36158292 | 81920 |
| stress | 181.68 | NOT_CHECKED | 23 | 2977393 | NOT_CHECKED |

Encoded transfer counts cover completed HTTP transfers, exclude an open SSE body, and are not startup-only bytes. API request starts include streaming connections; response-time distributions include completed responses only. Final origin usage is after the workload; per-input origin estimates preserve draft-stage usage and are approximate, compressed browser storage rather than journal payload size.

| Dataset / idle | Actual window s | Requests / API paths | Node CPU ms | Node RSS MiB | Browser CPU s | Browser RSS sum MiB | Git processes |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| small-short / idle.visible | 35.008 | 6: GET /api/projects/:id/recent-activity × 2; GET /api/projects/:id/observation × 2; GET /api/projects/:id/proposals × 2 | 112.66 | 110.52 | 4.270 | 917.14 | 26 |
| small / idle.visible | 35.001 | 6: GET /api/projects/:id/recent-activity × 2; GET /api/projects/:id/observation × 2; GET /api/projects/:id/proposals × 2 | 169.72 | 145.43 | 5.410 | 1095.23 | 26 |
| medium / idle.visible | 35.001 | 9: GET /api/projects/:id/recent-activity × 3; GET /api/projects/:id/observation × 3; GET /api/projects/:id/proposals × 3 | 409.97 | 157.02 | 7.580 | 1097.60 | 39 |
| large / idle.visible | 35.001 | 6: GET /api/projects/:id/recent-activity × 2; GET /api/projects/:id/observation × 2; GET /api/projects/:id/proposals × 2 | 262.43 | 243.25 | 5.540 | 1134.21 | 26 |

These are observed short windows, not measured hourly rates or a 24-hour soak. Foreground receipts/refreshes and the cursor debounce settle before the window. The job-event stream remains open and counted; the temporary visibility-probe tab is closed before final resource snapshots. Hidden idle was not simulated.

| UI artifact | main.js bytes / gzip bytes | CSS bytes / gzip bytes |
| --- | --- | --- |
| launcher | 717,583 / 226,928 | 28,230 / 6,330 |
| desktop | 747,740 / 237,382 | 48,242 / 9,422 |
| mobile | 1,662,454 / 433,076 | 65,359 / 13,263 |

Gzip is an offline Node gzipSync size calculation; it is not a claim that the API serves compressed assets. Launcher/mobile page CPU/paint is NOT_CHECKED; only desktop is driven here.

The older `saveScene` convenience path is retained as a separate **legacy** measurement. Its 1,000-file samples are not the current approved-checkpoint pipeline. Original role-selector, networkidle, uncapped-log and generator failures remain diagnostics, not product benchmark failures or replacement numbers. The final stress-browser readiness outcome is reported in its raw result; no missing editor/input/switch observations are inferred from the successful Core API calls.

## Bottlenecks and next-wave proposals

Measured workload costs are distinct from their possible causes. Production React commit counts do not identify per-component render durations; frame delay does not prove that `toString()` alone is responsible. Git command counts and IDB getAll calls identify actual work, while savings from a different implementation remain hypotheses. Full scan and legacy-save results must not be presented as current foreground-read or approved-checkpoint latency.

Confirmed workload costs include 10-file 1 MiB typing frame p95 **637.2 ms** versus 1 KiB **8.7 ms** (20 captured samples each); 10,000-file cold revision listing **24.30 s / 10,001 top-level Git processes** versus warm **27.86 ms / one process** (one sample each); and 1,000-file full search/statistics scans **33.30 / 33.73 s** (one sample each). The incomplete stress read series retained seven completed warm-tree/scene pairs, with p50 **9.02 / 10.52 s**; the unfinished remainder remains NOT_CHECKED. These establish workload costs, not a causal allocation breakdown or proven optimization gains.

The [64-row candidate correspondence table](CANDIDATE-MAP.md) covers every audit entry, including unmeasured architecture proposals and protected invariants. It updates priorities against performance, memory, I/O, implementation effort and safety. Exactly four ledger candidates are proposed for Wave 1, with no implementation started:

1. **C01 — input whole-text materialization.** Document-size-dependent frame delay and Long Tasks warrant a controlled ChangeSet experiment. Keep full operation validation before strict journal persistence; measure allocation/GC separately.
2. **C04 — root React subscriptions.** Commits are observed during input, but component-level attribution is missing. Isolate editor subscriptions and compare with the same traces; preserve recovery ownership, navigation generations and IME/undo behavior.
3. **C13 — journal full-refresh reads.** getAll traffic is observed during autosave. Experiment with changed-document refresh while retaining strict transactions, exact receipts and multi-tab/error recovery semantics. No physical-fsync or memory saving is claimed yet.
4. **C22 — cold Snapshot revision reads.** Per-file Git process growth and cold/warm revision costs warrant bounded batching/caching experiments. Preserve byte-derived FileRevision, pinned snapshots, symlink/path guards and all writer/CAS locks. Do not replace the revision contract with Git OIDs.

Large scan workloads are also material follow-up investigations. This four-item cap does not authorize a search/index rewrite, adapter migration, polling/SSE redesign, cache-budget redesign or plugin changes. Proposed changes require their own correctness and failure tests; this baseline alone cannot authorize weaker durability or freshness.

## Verification and limits

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS before measurements; dependency manifests and lockfile unchanged |
| `node --test scripts/performance/performance.test.mjs` with system Chromium | PASS: 8 tests, 0 skipped |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: 414 passed, 1 opt-in semantic CPU case skipped |
| `SCRIPTORIUM_PROFILE=core pnpm build` | PASS; existing chunk-size warnings retained in log |
| `pnpm audit:core` | PASS |
| Fresh stress generator reproduction | PASS: 100,000 tracked files, 100 commits, identical `86eb03604a68765553c4c89753af459f48c3950c`; Git integrity checked |
| Primary browser scenarios | Complete: short control, 10 / 1,000 / 10,000-file matrices. Stress outline reached; Editor readiness NOT_CHECKED at 60 s |

The full-suite skipped case is `default ModuleRuntime composes semantic status, real CPU rebuild/search/rerank, and cache recovery`; it is not counted as passed or as plugin performance evidence. [Verification metadata](results/2026-10-20/raw/verification.json.gz) and compressed command logs preserve exact exit statuses. The medium 1 KiB typing phase captured 19 frame samples from 20 requested key actions; the absent sample is not replaced. All other reported sample counts likewise remain actual observations.

No production path changed, so browser/OCI production acceptance was not rerun as a deployment certification. The real browser performance scenarios above are their own evidence. Source review and the final diff confirm the write-set is limited to benchmark scripts, tests, documentation and synthetic measurement artifacts. No CI/workflow/template command was executed, no plugin internals were instrumented, and the completed migration ledger was untouched.

NOT_CHECKED remains explicit for hosted GitHub latency/bytes and publication races; OCI startup/RSS/image size; physical devices/native OS IME; real hidden-tab idle (headless Chromium kept the original tab visible); 24-hour idle; component-level React render durations, allocated bytes and continuous browser heap/PSS peaks; exact per-operation Git child CPU; physical IDB fsync count; memory pressure/cache evictions; 100/1,000-draft journal occupancy; network partitions, forced browser/server crash and multi-tab performance loads. Happy-path measurements and the existing correctness tests do not replace those performance workloads.

Browser CPU is Chromium cumulative process CPU at phase boundaries and CDP renderer/V8 sampling; Linux browser RSS is sampled and summed across processes, which double-counts shared pages and is not PSS or continuous peak RSS. Instrumented Node RSS includes retained command/HTTP probe data; old diagnostics kept an uncapped command list, whereas the final harness caps it at 1,000 vectors and counts dropped log entries without dropping process counts. These memory series are not directly comparable across instrumentation versions. Node per-operation CPU excludes Git child CPU; Node peak RSS is a process-lifetime high-water mark. Linux [proc I/O accounting](https://man7.org/linux/man-pages/man5/proc_pid_io.5.html) includes the process and children it has reaped; it differs from the Node-only CPU/RSS fields. `/proc` I/O distinguishes pipe/cache character counts from kernel storage bytes; zero `read_bytes` can reflect cached reads, not zero work. Async `readFile` probes are not a syscall census. Native Git trace start events include nested Git and setup; top-level counters cover Core-issued execFile/spawn within sampled operations. Origin storage estimates are approximate and include the whole origin, not isolated journal fields.

No speedup, durability change, production deployment, merge, hosted fixture publication, CI run or optional-plugin performance result is claimed. The stopping point is the committed/pushed Wave 0 PR and its reported verification results.
