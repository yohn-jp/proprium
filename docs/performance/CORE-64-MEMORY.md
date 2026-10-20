# Core 64 memory and output boundaries

**Scope:** G2 C30, C31 and linked C63 evidence. **State:** driver prepared; measurement is pending the exclusive G0 lease and completed G0 `large` / `stress` fixtures. No fixture, build, benchmark, test or production source was changed or run while G0 owns that lease.

The synthetic repositories come from the immutable G0 fixture set at `a1587e78`; the measured Core runtime is pinned separately to accepted source revision `f633da0b3f133ad812953c284aab35a4956d2507`, with compiled `packages/core/dist/index.js` SHA-256 `a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`. The runner records the runtime root, source path and source SHA-256, and refuses a different source revision or compiled entry hash. This Core includes C21's 4,096-entry per-reader tree lookup memo and the adopted derived-scan changes; measurements describe that accepted runtime, not the older Core used to construct G0.

Run the bounded probe after G0 releases the lease and confirms both synthetic dataset tiers are complete:

```sh
node scripts/performance/core64-memory.mjs --run \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/results/core64-memory \
  --runtime-root /home/sophia/src/scriptorium-c64-derived \
  --runtime-revision f633da0b3f133ad812953c284aab35a4956d2507 \
  --core-index-sha256 a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3
```

The output directory must not exist. No build is needed in this probe worktree: the accepted, already-compiled Core runtime is supplied explicitly and verified before output creation. The driver reuses G0's 10-file seed to prepare synthetic binary and tree-output cases, then reads the completed 10,000-file and 100,000-file G0 remotes. It creates separate local bare remotes with shared object storage for each Core project and never writes to G0 fixtures. Defaults use nine 10,000-file repositories (to cross the hierarchy cache's eight-entry ceiling) and two 100,000-file repositories; `C64_MEMORY_LARGE_REPOS`, `C64_MEMORY_STRESS_REPOS`, `C64_MEMORY_IDLE_MS`, and `C64_MEMORY_WORKER_TIMEOUT_MS` bound or adjust the run. A timeout is retained as incomplete evidence.

The C30 workers exercise `SnapshotReader.read(path, "base64")` and `listRevisions(path)` with a 32 MiB binary blob and a blob one byte larger. The deterministic payload includes NUL bytes; the successful read and revision must match the independently recorded SHA-256. `reader.list("")` is tested with exact 32 MiB and 32 MiB + 1 `ls-tree` output. A separate raw `git cat-file --batch` worker checks exact/+1 Node `maxBuffer` behavior. The cache worker captures the actual `cat-file --batch` response lengths used by Core. Core's revision batches cap blob bodies at 24 MiB and each batch at 4,096 objects, so the raw batch trial measures the Node output boundary while the cache worker records the bounded Core path.

Each operation records its outcome and error, Git stdout byte counts (including truncated output on failure), endpoint RSS, 20 ms sampled operation peak, process high-water RSS, Node CPU and `/proc/self/io`. Git child RSS is not included. A failed Core call returns no partial API value; the Git callback's partial stdout byte count is still retained when Node reports it.

The cache worker samples `fileRevisionCache`, `hierarchyCache`, `historicalMetadataCache` and `reconciliationCache` after each repository/operation and after a 35-second idle window. File revisions use a labeled shallow UTF-8 payload estimate; hierarchy and historical metadata use Core's existing byte counters; reconciliation values use a bounded JSON-shape estimate. These totals are estimates/accounting for retained derived data, not V8 heap or process RSS. The same report keeps the RSS series separate. Read observations, proposal/approval state and writer queues are listed as authority/lifecycle state and excluded from evictable-cache estimates. Runtime-private cache fields are inspected only by the benchmark worker; no production counters are added.

The fixture contains no Core operation records, so `historicalMetadataCache` and `reconciliationCache` may remain empty. This workload does not manufacture a large reconciliation result; its byte estimate is reported only if the normal read path populated one. A pressure-aware shared budget is justified only if these measurements show aggregate retained-cache pressure and a measurable benefit. C30 output failures remain a separate observation and do not justify raising the global buffer limit.

Raw output is written under `results/core64-memory/` in the campaign directory. Until the run completes, C30 boundary behavior, multi-repository cache pressure, idle retention, per-cache hit/eviction counts and cache-versus-RSS attribution remain **NOT_CHECKED**.
