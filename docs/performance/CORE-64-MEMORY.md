# Core 64 memory and output boundaries

**Scope:** G2 C30, C31 and linked C63 evidence. **State:** driver prepared; measurement is pending the exclusive G0 lease and completed G0 `large` / `stress` fixtures. No fixture, build, benchmark, test or production source was changed or run while G0 owns that lease.

The synthetic repositories come from the immutable G0 fixture set at `a1587e78`; the measured Core runtime is pinned separately to accepted source revision `f633da0b3f133ad812953c284aab35a4956d2507`, with compiled `packages/core/dist/index.js` SHA-256 `a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`. The runner records the runtime root, source path and source SHA-256, and refuses a different source revision or compiled entry hash. This Core includes C21's 4,096-entry per-reader tree lookup memo and the adopted derived-scan changes; measurements describe that accepted runtime, not the older Core used to construct G0.

Run C30 and C31 as separate bounded phases after the coordinator grants a lease. Each phase writes to a fresh output directory and can be scheduled independently:

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

Each operation records its outcome and error, Git stdout byte counts (including truncated output on failure), endpoint RSS, 20 ms sampled operation peak, process high-water RSS, Node CPU and `/proc/self/io`. Git child RSS is not included. A failed Core call returns no partial API value; the Git callback's partial stdout byte count is still retained when Node reports it.

The cache worker samples `fileRevisionCache`, `hierarchyCache`, `historicalMetadataCache` and `reconciliationCache` after each repository/operation and after a 35-second idle window. File revisions use a labeled shallow UTF-8 payload estimate; hierarchy and historical metadata use Core's existing byte counters; reconciliation values use a bounded JSON-shape estimate. These totals are estimates/accounting for retained derived data, not V8 heap or process RSS. The same report keeps the RSS series separate. Read observations, proposal/approval state and writer queues are listed as authority/lifecycle state and excluded from evictable-cache estimates. Runtime-private cache fields are inspected only by the benchmark worker; no production counters are added.

The fixture contains no Core operation records, so `historicalMetadataCache` and `reconciliationCache` may remain empty. This workload does not manufacture a large reconciliation result; its byte estimate is reported only if the normal read path populated one. A pressure-aware shared budget is justified only if these measurements show aggregate retained-cache pressure and a measurable benefit. C30 output failures remain a separate observation and do not justify raising the global buffer limit.

Raw output is written under `results/core64-memory/c30/` and `results/core64-memory/c31/` in the campaign directory. Until each corresponding phase completes, its boundary or cache-pressure behavior, idle retention, per-cache hit/eviction counts and cache-versus-RSS attribution remain **NOT_CHECKED**. Even complete raw phases leave the shared C31/C63 budget decision pending evidence review.
