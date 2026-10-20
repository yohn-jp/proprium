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

Run from a fresh output path outside the repository, fixture and runtime:

```sh
node scripts/performance/core64-writer.mjs /tmp/scriptorium-core64-writer-run
```

`run.json` records source and runtime commits/hashes, fixture manifest hash and
remote head, host details, per-case limits and statuses. Per-case JSON retains
partial progress and completed samples if a worker reaches its limit. Timeout
or worker failure is `NOT_CHECKED`, never a latency value. Git process counts
come from existing Node-only `execFile` / `spawn` instrumentation and are exact
for Core-issued child processes; the command histogram is incomplete after the
helper's 1,000-entry log fills. CPU is Node-only. `rssBytes` is the sample
endpoint and `maxRssKiB` is process-lifetime high-water RSS, including setup.

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
noise. There is no proposed production optimization before matched evidence
identifies a material cost. If evidence supports batching, the candidate scope
is limited to the existing temporary-index path; authority locks, receipts,
unknown-outcome handling and fencing remain unchanged. Any implementation
would require focused safety checks and the full repository gates.

## Evidence state

The prepared status in
[`results/core64-writer/PREPARED.md`](results/core64-writer/PREPARED.md) is not a
measurement. Probe execution remains `NOT_CHECKED` while the current G5
verification and G3 environment batch use the heavy-run window. After that
window clears, run only with the exclusive heavy-run lease and append the
generated JSON plus an evidence summary here.
