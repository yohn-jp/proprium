# Wave 1 — Git revision batching (C22)

This change improves cold `snapshotFileRevisions()` work for large pinned
snapshots. On the synthetic 10,000-file fixture, five independent cold runs
reduced median latency from 23.61 s to 442.45 ms (53.36×, a 98.13% reduction)
and Git processes from 10,001 to 5 per call (99.95% fewer). The immediately
following warm call became slower: its median increased from 25.66 ms to
44.34 ms (+18.68 ms, +72.80%). That warm cost is a measured tradeoff and is
reported alongside the cold result.

## Implementation and contracts

After the pinned `ls-tree` result has passed the existing path, mode and symlink
checks, the revision reader now deduplicates uncached blob IDs for that request.
It obtains object types and sizes with one `cat-file --batch-check`, then reads
objects through bounded `cat-file --batch` calls, split at the existing 24 MiB
content and 4,096-object limits. A larger individual object uses the existing
single-object output path. The response parser verifies ordered IDs, blob types,
declared sizes, separators and trailing bytes before hashing raw buffers.

`FileRevision` remains SHA-256 over the exact file bytes. Git object IDs are only
temporary request/cache keys. Path validation still precedes cache access;
revision lookup remains pinned to the observed commit. A request-local mapping
retains results when duplicate IDs occur or the persistent cache's 16,384-entry
limit evicts entries while a large result is being assembled. The warm all-cache
path returns aligned cached revisions directly. This change does not modify
snapshot pinning, symlink rejection, CAS, writer locks or publish behavior.

Regression coverage checks binary data with embedded NUL/newline/high bytes,
empty files, duplicate blobs and executable mode, prefix filtering, pinned old
snapshots after the remote advances, symlink rejection, a result larger than the
cache capacity, batches crossing the 24 MiB boundary, and a single blob just
over that boundary.

## Measurement

The unchanged Wave 0 `scripts/performance/core.mjs` revisions workload was run
five times at each source revision. Each invocation used a fresh Node process,
CoreStore and local bare-remote clone, with one cold revision listing followed
immediately by one warm listing. Both cohorts used the same generated synthetic
fixture (10,000 files, 17,306,597 bytes, seed commit
`1adbb44980a9ccee009c536c7593fb23503ed86c`), Core profile, host and toolchain.
The fixture's Git object and OS page caches were not flushed, so “cold” means a
fresh Core cache and worker process, not a disk-cache-cold host. Harness SHA-256
was `3a4916d0da54242d5ab51eb7bf0638c582fb815d5e5e9697230e3e9e965fcacb` for both
cohorts. Before used `eaa52ce09e2e5217e55e68b139a578a313a5ea0b`; after used
`6793f06e083f328111c0cf717f498a49741a2c3c`.

Values below are p50 / p95 / p99; each phase has n=5. Percentiles use nearest
rank, so p95 and p99 equal the maximum at this sample count. Times are
milliseconds unless indicated. Git counts are Core-issued processes within the
measured phase.

| Phase / measure | Base | After | Change |
| --- | ---: | ---: | ---: |
| Cold elapsed (ms) | 23,608.89 / 24,512.64 / 24,512.64 | 442.45 / 449.02 / 449.02 | 53.36× faster at p50; −98.13% |
| Cold Node CPU (ms) | 16,221.61 / 16,693.22 / 16,693.22 | 513.95 / 516.59 / 516.59 | −96.83% at p50 |
| Cold Git processes | 10,001 / 10,001 / 10,001 | 5 / 5 / 5 | −99.95% |
| Cold boundary RSS (bytes) | 252,325,888 / 253,919,232 / 253,919,232 | 126,406,656 / 126,570,496 / 126,570,496 | −49.91% at p50 |
| Cold process peak RSS (KiB) | 246,568 / 248,196 / 248,196 | 136,088 / 136,404 / 136,404 | −44.80% at p50 |
| Warm elapsed (ms) | 25.66 / 25.96 / 25.96 | 44.34 / 45.12 / 45.12 | **+18.68 ms / +72.80% at p50** |
| Warm Node CPU (ms) | 35.21 / 36.57 / 36.57 | 57.81 / 58.51 / 58.51 | +22.60 ms at p50 |
| Warm Git processes | 1 / 1 / 1 | 1 / 1 / 1 | unchanged |
| Warm boundary RSS (bytes) | 255,864,832 / 257,720,320 / 257,720,320 | 137,023,488 / 137,306,112 / 137,306,112 | −46.45% at p50 |
| Warm process peak RSS (KiB) | 249,868 / 251,680 / 251,680 | 136,088 / 136,404 / 136,404 | −45.54% at p50 |

Boundary RSS is `process.memoryUsage().rss` sampled at the end of the measured
phase. Process peak RSS is `process.resourceUsage().maxRSS`, the worker's
lifetime high-water mark in KiB; it is not a phase-local peak. Node CPU uses
`process.cpuUsage()` and excludes CPU consumed by child Git processes. The
Wave 0 `/proc/self/io` counters include reaped-child accounting: cold p50
`rchar` fell from 126,872,863 to 20,198,663 bytes, `wchar` from 35,106,835 to
20,152,632 bytes, `syscr` from 382,305 to 15,731 calls, and `syscw` from
111,633 to 41,081 calls. Kernel `read_bytes` was zero in both cohorts; `write_bytes`
fell from 16,621,568 to 8,192. These are supporting measurements, not direct
storage-traffic or per-child CPU measurements.

Wave 0's original large-fixture observation was n=1: 24,296.88 ms cold and
27.86 ms warm. The five-run base cohort above repeats the unchanged harness at
the required base commit to provide a distribution that the original single
sample could not.

Two intermediate warm-path variants were diagnostic only and are excluded
from the primary comparison and Release Asset: the initial batched version at
`c3dffa2099fc5421e6f836b2b8d528f353e7b111` promoted cache entries on reads and
measured 51.10 ms p50 (n=5); `cd8d3c3d986d266e424227f345dd6bd3001302f1`
avoided that promotion using a map-only return path and measured 47.54 ms p50
(n=5). The final aligned cached-result fast path at `6793f06e083f328111c0cf717f498a49741a2c3c`
measured 44.34 ms p50 (n=5). These steps reduced the measured warm cost but did
not recover the base's 25.66 ms p50. The final implementation is retained for
the large cold gain, with that remaining warm regression explicit above.

IndexedDB, React commits and browser Long Tasks are not applicable to this
direct Core `SnapshotReader` workload. Per-child Git CPU, 100,000-file cold
latency and blobs larger than the inherited 32 MiB Git output buffer were not
checked. The tests exercise the >24 MiB fallback with a 24 MiB + 1 byte blob.

## Reproduction and artifacts

The archived raw JSON and Git Trace2 logs preserve all ten worker reports and
their native traces. To rerun the same workload, generate the `large` fixture
with `node scripts/performance/dataset.mjs /tmp/wave1-fixture large`, build the
Core profile at the base and candidate commits, and invoke
`node scripts/performance/core.mjs /tmp/wave1-fixture /tmp/revisions-NN.json 1 revisions`
five times per source revision with a fresh output name each time. Keep the
fixture seed fixed, use one worker at a time, and set
`GIT_TRACE2_EVENT=/tmp/revisions-NN.git-trace.jsonl` for each invocation.

The compact aggregate is [summary.json](results/wave1-git-engine/summary.json).
The [INDEX manifest](results/wave1-git-engine/INDEX.json) points to the
permanent synthetic-only archive
[`scriptorium-wave1-git-2026-10-20.tar`](https://github.com/yohn-jp/scriptorium/releases/download/perf-wave1-git-2026-10-20/scriptorium-wave1-git-2026-10-20.tar)
in the `perf-wave1-git-2026-10-20` prerelease. Download it and verify the
archive before extraction, then verify its compressed and raw members:

```sh
index=docs/performance/results/wave1-git-engine/INDEX.json
evidence=$(mktemp -d /tmp/scriptorium-wave1-git.XXXXXX)
gh release download perf-wave1-git-2026-10-20 --repo yohn-jp/scriptorium \
  --pattern scriptorium-wave1-git-2026-10-20.tar --dir "$evidence"
node scripts/performance/artifacts.mjs verify-archive "$index" "$evidence"
tar -xf "$evidence/scriptorium-wave1-git-2026-10-20.tar" -C "$evidence"
node scripts/performance/artifacts.mjs verify "$index" "$evidence"
```

The source JSON and JSONL traces are compressed at gzip level 6 with mtime 0
and OS byte 255, then packed into a deterministic GNU ustar archive. The
repository contains the aggregate, external-artifact manifest and method; raw
compressed data remains in the Release Asset.

## Verification

| Check | Result |
| --- | --- |
| Focused Core regression tests | Passed; included in the complete test run |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | Passed: 417 passed, 1 skipped (418 total) |
| `SCRIPTORIUM_PROFILE=core pnpm build` | Passed |
| `pnpm audit:core` | Passed: 128 production dependency versions scanned |
| Browser E2E | Passed: Chromium modular-workspace suite, 8 passed, 1 full-profile-only test skipped |
| OCI acceptance (`nix shell nixpkgs#podman -c bash scripts/verify-oci.sh`) | NOT_CHECKED: the image build exited 125 with `no space left on device` while storing a layer; host had 2.8 GiB free. No existing images or storage were removed for a retry. |
