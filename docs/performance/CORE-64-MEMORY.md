# Core 64 memory and output boundaries

**Scope:** G2 C30, C31 and linked C63 evidence. **State:** C30 is complete on the accepted runtime; the C31 cache-pressure cohort and linked C63 shared-budget decision remain **NOT_CHECKED** pending a separate measurement lease. The initial C30 attempt failed in the benchmark's `execFile` wrapper before Git ran; that failure is preserved alongside the corrected run under [`results/core64-memory/c30`](../../results/core64-memory/c30/).

The synthetic repositories come from the immutable G0 fixture set at `a1587e78`; the measured Core runtime is pinned separately to accepted source revision `f633da0b3f133ad812953c284aab35a4956d2507`, with compiled `packages/core/dist/index.js` SHA-256 `a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`. The runner records the runtime root, source path and source SHA-256, and refuses a different source revision or compiled entry hash. This Core includes C21's 4,096-entry per-reader tree lookup memo and the adopted derived-scan changes; measurements describe that accepted runtime, not the older Core used to construct G0.

The C30 run used a fresh output directory under the shared campaign data root and completed all eight workers in 40.3 seconds. The exact compact manifest, raw reports and fixture manifests are archived under [`results/core64-memory/c30`](../../results/core64-memory/c30/); the large temporary fixture and worker-data directories remain in the campaign data root and are not committed. C31 still requires its own explicit lease. Each reproduction uses a fresh output directory:

```sh
node scripts/performance/core64-memory.mjs --run \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/results/core64-memory/c30 \
  --phase c30 \
  --runtime-root /home/sophia/src/scriptorium-c64-derived \
  --runtime-revision f633da0b3f133ad812953c284aab35a4956d2507 \
  --core-index-sha256 a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3

node scripts/performance/core64-memory.mjs --run \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/results/core64-memory/c31 \
  --phase c31 \
  --runtime-root /home/sophia/src/scriptorium-c64-derived \
  --runtime-revision f633da0b3f133ad812953c284aab35a4956d2507 \
  --core-index-sha256 a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3
```

The output directory for each phase must not exist. No build is needed in this probe worktree: the accepted, already-compiled Core runtime is supplied explicitly and verified before output creation. C30 reuses G0's 10-file seed to prepare only the synthetic binary and tree-output boundary cases. C31 reads the immutable G0 10,000-file and 100,000-file datasets and creates bare project remotes with Git alternates that point directly at each G0 object store; it records and verifies those alternate references rather than copying or regenerating the large fixture objects.

C30 has eight sequential task workers and a six-minute cohort deadline. C31 has two task workers over eleven project remotes total (nine 10,000-file and two 100,000-file) and a twelve-minute cohort deadline, with a 35-second idle window for each cache worker. Nine 10,000-file projects cross `hierarchyCache`'s eight-entry count cap. Each 100,000-file project exceeds `fileRevisionCache`'s 16,384-entry cap; the second remote uses the same immutable Git object set so it measures cross-project reuse after eviction churn, not 200,000 unique blob revisions. Each fixture Git command is capped at 30 seconds wall and CPU time. Every task worker and its Git subprocesses inherit a 6 GiB per-process `RLIMIT_AS` and 180 seconds of CPU time; Node workers also have a 2 GiB old-space and 64 MiB semi-space cap, plus a 180-second wall timeout. These limits bound individual processes; they do not form an aggregate cgroup memory cap. If a cohort or worker cap is reached, that phase is explicitly `NOT_CHECKED` for conclusions and retained as partial evidence.

The runner records the effective CPU affinity and `C64_MEMORY_OVERLAP_NOTE` in each manifest. If another campaign lane is active, its exact assignment belongs in that note; latency from that run remains observational and cannot support an adoption-performance claim.

The C30 workers exercise `SnapshotReader.read(path, "base64")` and `listRevisions(path)` with a 32 MiB binary blob and a blob one byte larger. The deterministic payload includes NUL bytes; the successful read and revision must match the independently recorded SHA-256. `reader.list("")` is tested with exact 32 MiB and 32 MiB + 1 `ls-tree` output. A separate raw `git cat-file --batch` worker checks exact/+1 Node `maxBuffer` behavior. The cache worker captures the actual `cat-file --batch` response lengths used by Core. Core's revision batches cap blob bodies at 24 MiB and each batch at 4,096 objects, so the raw batch trial measures the Node output boundary while the cache worker records the bounded Core path.

The completed C30 run accepted exactly 32 MiB for the binary read, revision lookup, tree listing, and raw batch response. All four corresponding 32 MiB + 1 cases failed at Node's `maxBuffer` boundary as expected. The successful binary read returned the independently verified SHA-256 and all 130,562 NUL bytes; the exact tree output parsed into 124,275 paths. The `read` and `listRevisions` +1 errors reported that Git output exceeded `maxBuffer`; the Core API returned no partial value even though the output probe recorded 32 MiB captured. The raw `cat-file --batch` +1 case recorded `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and 32 MiB partial stdout.

RSS figures below are Node-process endpoints and sampled/process high-water observations; Git child RSS is excluded. C30 ran with CPU affinity `0-3` while writer, C48 semantics and OCI lanes occupied `4-7`, `8-11` and `12-15`. The elapsed times are therefore contended observations, not adoption-performance evidence.

| C30 operation | Result | RSS before → after (MiB) | Process RSS delta (MiB) |
| --- | --- | ---: | ---: |
| `read`, 32 MiB | Success; binary hash and NUL count match | 71.9 → 213.0 | +141.1 |
| `read`, 32 MiB + 1 | Expected `maxBuffer` error; no partial Core value | 72.6 → 138.2 | +65.6 |
| `listRevisions`, 32 MiB | Success; one revision matches the blob hash | 72.6 → 138.2 | +65.6 |
| `listRevisions`, 32 MiB + 1 | Expected `maxBuffer` error | 72.5 → 137.8 | +65.3 |
| `reader.list("")`, 32 MiB tree output | Success; 124,275 paths | 73.1 → 183.9 | +110.9 |
| `reader.list("")`, 32 MiB + 1 | Expected `maxBuffer` error | 72.9 → 166.4 | +93.5 |
| Raw `cat-file --batch`, exact 32 MiB response | Success | 57.1 → 125.2 | +68.1 |
| Raw `cat-file --batch`, response + 1 | Expected `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`; 32 MiB partial stdout | 57.2 → 125.0 | +67.8 |

This establishes the current per-call output boundary and its process-RSS cost for these synthetic inputs. It does not show cache pressure or justify raising the global output buffer. The minimal Core verdict from C30 is **no product change**: retain the 32 MiB boundary. If a supported operation later requires larger content, measure and design a streaming or chunked path for that operation instead of increasing every buffered Git call. C30's single-reader cache snapshots are not evidence for C31/C63; no shared cache budget or eviction governor is recommended until the multi-repository pressure and idle-retention measurements show a benefit.

The first C30 attempt produced no boundary measurements because `installGitOutputProbe()` called the original `execFile` with only the options and callback, treating the options object as the executable. All eight raw failures and the partial manifest are retained under `c30/runner-failure`. The corrected wrapper forwards the executable and argument list; the fix is in `core64-memory.mjs` and its SHA-256 is recorded in `c30/archive.json`. A one-object smoke reached Git and recorded one process plus 1,076 stdout bytes; its expected-phase status is failed because the smoke blob is intentionally smaller than the 32 MiB target, so it is not boundary evidence.

Each operation records its outcome and error, Git stdout byte counts (including truncated output on failure), endpoint RSS, 20 ms sampled operation peak, process high-water RSS, Node CPU and `/proc/self/io`. Git child RSS is not included. A failed Core call returns no partial API value; the Git callback's partial stdout byte count is still retained when Node reports it.

The cache worker samples `fileRevisionCache`, `hierarchyCache`, `historicalMetadataCache` and `reconciliationCache` after each repository/operation and after a 35-second idle window. File revisions use a labeled shallow UTF-8 payload estimate; hierarchy and historical metadata use Core's existing byte counters; reconciliation values use a bounded JSON-shape estimate. These totals are estimates/accounting for retained derived data, not V8 heap or process RSS. The same report keeps the RSS series separate. Read observations, proposal/approval state and writer queues are listed as authority/lifecycle state and excluded from evictable-cache estimates. Runtime-private cache fields are inspected only by the benchmark worker; no production counters are added.

The fixture contains no Core operation records, so `historicalMetadataCache` and `reconciliationCache` may remain empty. This workload does not manufacture a large reconciliation result; its byte estimate is reported only if the normal read path populated one. A pressure-aware shared budget is justified only if these measurements show aggregate retained-cache pressure and a measurable benefit. C30 output failures remain a separate observation and do not justify raising the global buffer limit.

Raw output is written under `results/core64-memory/c30/` and `results/core64-memory/c31/` in the campaign directory. C30 is complete and its boundary outcomes are recorded above. C31 cache pressure, idle retention, per-cache hit/eviction counts and cache-versus-RSS attribution remain **NOT_CHECKED**. Even after C31 completes, the shared C31/C63 budget decision requires evidence review.
