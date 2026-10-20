# Core 64 writer probe

This probe prepares bounded evidence for G2 candidates C23, C27 and C28. It
reuses the Wave 0 `dataset.mjs`, `instrument-node.mjs`, `common.mjs` and
`run.mjs` helpers. It reads the immutable 10-file G0 fixture and creates all
benchmark clones and Core state under a fresh output root. It does not rebuild
Core, modify the fixture, connect to GitHub, use author credentials, or edit
Core source.

## Pinned inputs and command

The accepted frozen runtime is
`/home/sophia/src/scriptorium-c64-derived` at
`f633da0b3f133ad812953c284aab35a4956d2507`. Before launching workers, the
runner requires a clean checkout, checks the compiled Core `index.js` SHA-256
(`a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`), checks
the contracts `index.js` SHA-256
(`b33421f57a9ba54adebdf06fee5c298ed2cdd65ea0a710d885d87d0f974b15be`), and
compares the accepted runtime's `packages/core/src/index.ts` byte-for-byte by
SHA-256 with the source under measurement. The accepted source SHA-256 is
`dd05006e97a4dd471fd3555b852d1ad4166de53a4ec41b80d8a0c52d3ab929c5`. It
records source and compiled tree hashes. No build is part of this probe.

The fixture is the existing
`/tmp/scriptorium-wave0-baseline-20261020/small` manifest and local bare remote,
at baseline commit `e70bb509cc41b383451335e05af36d78f1cb31db`. The runner checks
its 10-file synthetic-only manifest and remote `main` before and after the
workers. The manifest SHA-256 is
`a8612670688f31269fb0541dc5aa528efa0eb92eab30c45fe2e0fcaa0a7125dd`. Fixture
and runtime paths can be changed with
`CORE64_WRITER_G0_FIXTURE` and `CORE64_WRITER_RUNTIME_ROOT` only when the
manifest, commit, runtime commit, source match and compiled hashes still pass
the same guards.

After C59 releases the first-paint metrics lane and an explicit grant is given,
run the writer cohort alongside the other assigned lanes on CPUs 4–7. Use a
fresh output path outside the repository, fixture and runtime:

```sh
CORE64_WRITER_RUN_MODE=contended \
CORE64_WRITER_REQUESTED_CPUSET=4-7 \
taskset -c 4-7 node scripts/performance/core64-writer.mjs \
  /data/scriptorium-core64-writer-affinity4-7
```

`run.json` records source and runtime commits/hashes, fixture manifest hash and
remote head, host details, per-case limits and statuses. Per-case JSON retains
partial progress and completed samples if a worker reaches its limit. Timeout
or worker failure is `NOT_CHECKED`, never a latency value. Git process counts
come from existing Node-only `execFile` / `spawn` instrumentation and are exact
for Core-issued child processes; the command histogram is incomplete after the
helper's 1,000-entry log fills. CPU is Node-only. `rssBytes` is the sample
endpoint and `maxRssKiB` is process-lifetime high-water RSS, including setup.
The runner verifies and records the requested and effective CPU set is `4-7`;
its Node workers and their Git subprocesses inherit that affinity. Since this lane overlaps other assigned
acceptance, its walltimes are contended observations and cannot justify
adopting an optimization. Only later isolated, selective matched before/after
timing may support adoption, and only if correctness evidence supports a
candidate.

## Cases

| Candidate | Workload | Samples | Per-case limit |
| --- | --- | ---: | ---: |
| C23 | One approved checkpoint operation writes 1, 10, then 100 new manuscript files. Proposal and approval setup are outside the checkpoint timer. Receipt and local census are checked after timing. | 5 per scale | 90 s |
| C27 | Approved local checkpoint history contains 1, 100, 1,000, then 10,000 unique operations. Census samples run against that history and verify all pending receipt IDs. Setup time is reported separately and excluded from census samples. | 3 census samples per scale | 30 / 60 / 90 / 120 s by scale |
| C28 | A single approved proposal produces 1, 10, then 100 distinct pending checkpoint operations; the public `publish` call is timed and its confirmed receipt must acknowledge exactly that set. | 5 for 1 and 10; 3 for 100 | 60 / 120 / 180 s by scale |

Every timed sample reports wall time, Node CPU, endpoint and peak RSS, proc I/O,
and the delta in Core-issued Git child processes. The existing nearest-rank
distribution helper reports p50/p95 for time and Git process counts, with CPU
and RSS distributions alongside them. At n=3 or n=5, p95 is the maximum sample;
these bounded cohorts do not estimate a stable tail.

C27 setup deliberately uses public proposal, approval and checkpoint calls.
As the local operation history grows, checkpoint preparation re-reads more
durable records. A setup timeout therefore leaves that census scale
`NOT_CHECKED`; it does not stand in for census latency. The canonical
10,000-operation scale has a two-minute total worker budget for setup and
measurement. The sum of all case budgets is 15 minutes 30 seconds, plus process
launch overhead. This bounds the full sequence; it does not predict a result.

The workload keeps the current public CAS, temporary-index checkpoint, receipt,
freshness and fencing paths. It does not inject remote races or lost publish
responses into timed samples; those remain correctness cases, not latency
noise. The overlapped cohort cannot justify adoption. Any implementation
candidate stays limited to the existing temporary-index path; authority locks,
receipts, unknown-outcome handling and fencing remain unchanged. Any
implementation requires focused safety checks and the full repository gates.

## Evidence state

The affinity-pinned cohort ran with `CORE64_WRITER_RUN_MODE=contended` and
effective CPU set 4–7 while the coordinator's other lanes were active. These
walltimes are cohort observations, not isolated performance evidence, and are
not used to adopt an optimization. The top-level record and per-case raw data
are in [`run.json`](results/core64-writer/run.json) and the adjacent case JSON.
Each completed cohort passed its receipt or publish-acknowledgement assertions.
The runner verified that the immutable fixture and frozen runtime were
unchanged (`fixtureUnchanged` and `runtimeUnchanged` are true).

| Candidate | Scale | Samples | p50 / p95 wall time | p50 / p95 Git processes | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| C23 checkpoint | 1 file | 5 | 551 / 709 ms | 50 / 50 | complete |
| C23 checkpoint | 10 files | 5 | 961 / 1,147 ms | 104 / 104 | complete |
| C23 checkpoint | 100 files | 5 | 4,558 / 12,479 ms | 644 / 644 | complete |
| C27 census | 1 pending operation | 3 | 154 / 176 ms | 16 / 27 | complete |
| C27 census | 100 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 20/100 after 60 s |
| C27 census | 1,000 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 20/1,000 after 90 s |
| C27 census | 10,000 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 0/10,000 after 120 s |
| C28 publish | 1 operation | 5 | 1,666 / 5,223 ms | 98 / 98 | complete |
| C28 publish | 10 operations | 5 | 4,618 / 5,354 ms | 584 / 584 | complete |
| C28 publish | 100 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 20/100 after 180 s |

For the completed C23 samples, the exact per-sample Git child-process counts
were stable at `50`, `104`, and `644`, giving an exact slope of six additional
Git forks per additional file (`44 + 6 × file count`). This is a useful
checkpoint scaling signal, but stage-level counts were not retained: the
instrumentation's command parser treated the leading `--literal-pathspecs`
option as the command name, and the raw argv arrays were not persisted. The
`gitProcessCount` totals remain exact; `gitCommandLog.byCommand` in this cohort
must not be used as a command breakdown.

The source under measurement has two per-file tree lookups for the new path
(one for the operation precondition and one to preserve the existing file mode
in `createCommit`), followed by per-file `hash-object` and `update-index`
calls. The exact fork slope plus the source's one `update-index` subprocess per
non-null write supports a focused isolated A/B candidate: batch contiguous
upsert records with `update-index --index-info -z` against the existing
temporary index, while keeping per-content hashing, file modes, validation,
and commit creation unchanged. Flush pending upserts before each deletion (or
fall back to the existing path for mixed writes); preserve NUL-safe paths,
binary hashing, CAS, receipt, temporary-index, workspace, and single-writer
semantics. The branch candidate passes a focused Core build and mixed
checkpoint/publish semantic test covering binary contents, spaced and Unicode
paths, executable tree mode, deletion ordering, receipt revisions and exact
publish acknowledgement. Git's `-z --index-info` input still separates the
header from the pathname with a tab; NUL terminates the pathname record. The
candidate remains unmeasured and unadopted: a separate isolated matched C23
1/10/100 before/after run is required before an optimization claim or adoption.

## Candidate dispositions

**C27 — decline a census index/cache in this cohort.** Only the one-operation
history completed (`n=3`, p50/p95 154/176 ms, 16/27 Git processes); all three
pending-receipt integrity checks passed. Histories of 100, 1,000 and 10,000
operations are `NOT_CHECKED` because public checkpoint setup timed out at
20/100 after 60 seconds, 20/1,000 after 90 seconds, and 0/10,000 after 120
seconds. These results do not show whether the census's remote/local operation
record reads, worktree status, ancestry checks or `rev-list --all --reflog`
scan become material at representative history scale. They also do not prove
that an auxiliary index can preserve unknown-commit, restart, reflog and manual
parent detection. Reconsider only with a complete isolated representative
history measurement and source-stage evidence that the scan is material, plus
correctness evidence for a rebuildable index preserving those checks.

**C28 — decline request-scope memoization in this cohort.** The complete
one-operation batch (`n=5`) measured p50/p95 1,666/5,223 ms and 98 Git
processes; the ten-operation batch (`n=5`) measured 4,618/5,354 ms and 584
Git processes. Both batches were confirmed with exact receipt acknowledgement.
Those are contended totals, not phase attribution, and the saved command
histogram is unusable; they do not establish that repeated immutable
commit-keyed scans account for a material share of work. The 100-operation
batch is `NOT_CHECKED`: setup timed out at 20/100 after 180 seconds. Reconsider
only when an isolated, complete batch with valid phase or command attribution
shows material repeated immutable reads. Any future memo must remain request
scoped and leave fresh observation, remote CAS, retry, unknown-outcome and
receipt reconciliation boundaries intact.

The prepared status in
[`results/core64-writer/PREPARED.md`](results/core64-writer/PREPARED.md) records
the bounded run limits and remaining `NOT_CHECKED` scales. The script's
command-name parser has been corrected for future runs; it cannot reconstruct
the omitted argv from this archived cohort.
