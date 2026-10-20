# Core 64 writer probe

This probe measures bounded Core checkpoint, local durability census, and
publish workloads for G2 candidates C23, C27, and C28. It reuses the Wave 0
`dataset.mjs`, `instrument-node.mjs`, `common.mjs`, and `run.mjs` helpers. The
fixture is synthetic and immutable; no GitHub access, author credentials, or
real project data are used.

## Pinned inputs and method

The accepted baseline runtime is source commit
`f633da0b3f133ad812953c284aab35a4956d2507`. Its compiled Core `index.js` SHA-256
is `a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`, and
the contracts `index.js` SHA-256 is
`b33421f57a9ba54adebdf06fee5c298ed2cdd65ea0a710d885d87d0f974b15be`. The
immutable G0 fixture has remote commit
`e70bb509cc41b383451335e05af36d78f1cb31db` and manifest SHA-256
`a8612670688f31269fb0541dc5aa528efa0eb92eab30c45fe2e0fcaa0a7125dd`.

The first C23/C27/C28 cohort used the accepted runtime. The later isolated C23
comparison built the guarded candidate once, outside the timed workers, from
source commit `0152e9211f00abdbfdbc36939505d48162a3c1a1`. Candidate source
SHA-256 is `0408ab8500555060bc1efc6a1cdb21ed1036ed8904ad7f0bc356fc5a25e36ee4`,
and its compiled Core `index.js` SHA-256 is
`8f339dacbea1ad40ae60d358c7fba12e74bfd390337a7cbbadceef4247264e68`. The
contracts runtime hash matched the baseline. No source edits were made during
the matched run.

The probe retains the public CAS, temporary-index checkpoint, receipt,
freshness, unknown-outcome, and fencing paths. Proposal and approval setup are
outside checkpoint timers. Publish timing includes the public `publish` call,
whose confirmed receipt must acknowledge exactly the pending operation set.
Timed samples do not inject remote races or lost responses; those remain
correctness cases. Each worker records wall time, Node CPU, RSS, proc I/O, and
the delta in Core-issued Git child processes. Git process totals come from the
existing Node-only `execFile` / `spawn` instrumentation. The nearest-rank
distribution reports p50/p95; with five samples, p95 is the maximum observed
sample and is not a stable tail estimate.

The isolated C23 workers ran on requested and effective CPUs 4–7, with five
fresh Core contexts per worker. Variant order was baseline-1, candidate-1,
candidate-10, baseline-10, baseline-100, candidate-100. Thus order alternated
by scale, not within each five-sample worker. Shared-host external activity is
unknown and cannot be attributed. Treat the latency values as one isolated
matched cohort, not a general workload or host-wide p95 claim.

## Results

The initial affinity-pinned cohort ran in `contended` mode alongside other
assigned lanes. Those walltimes are retained as context only and do not support
adoption decisions.

| Candidate | Scale | Samples | p50 / p95 wall time | p50 / p95 Git processes | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| C23 baseline checkpoint | 1 file | 5 | 551 / 709 ms | 50 / 50 | complete, contended |
| C23 baseline checkpoint | 10 files | 5 | 961 / 1,147 ms | 104 / 104 | complete, contended |
| C23 baseline checkpoint | 100 files | 5 | 4,558 / 12,479 ms | 644 / 644 | complete, contended |
| C27 census | 1 pending operation | 3 | 154 / 176 ms | 16 / 27 | complete, contended |
| C27 census | 100 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 20/100 after 60 s |
| C27 census | 1,000 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 20/1,000 after 90 s |
| C27 census | 10,000 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 0/10,000 after 120 s |
| C28 publish | 1 operation | 5 | 1,666 / 5,223 ms | 98 / 98 | complete, contended |
| C28 publish | 10 operations | 5 | 4,618 / 5,354 ms | 584 / 584 | complete, contended |
| C28 publish | 100 operations | 0 | — | — | `NOT_CHECKED`: setup timed out at 20/100 after 180 s |

The matched isolated C23 measurements were:

| Files in checkpoint | Baseline p50 / p95 | Candidate p50 / p95 | Baseline → candidate Git processes | Samples and integrity |
| ---: | ---: | ---: | ---: | --- |
| 1 | 294.286 / 311.692 ms | 278.877 / 286.015 ms | 50 → 47 | 5; receipt and census checks passed |
| 10 | 547.491 / 567.939 ms | 495.255 / 507.124 ms | 104 → 92 | 5; receipt and census checks passed |
| 100 | 3,644.116 / 4,148.850 ms | 2,800.180 / 3,010.380 ms | 644 → 542 | 5; receipt and census checks passed |

All five sample process totals were identical within each variant/scale. The
batched candidate removed 3, 12, and 102 Git processes at 1, 10, and 100 files
respectively. Complete first-sample command logs show `update-index` totals of
4/13/103 for the baseline and 1/1/1 for the candidate. The instrumentation
retains at most 1,000 argv records per worker: command logs are complete for
all 1- and 10-file samples and for the first 100-file sample only. Later
100-file samples have exact aggregate process deltas, but their per-command
logs are dropped by that buffer limit. Do not use the incomplete logs to infer
later per-command counts.

The isolated C23 summary, including raw report SHA-256 values, is recorded in
[`isolated-c23.json`](results/core64-writer/isolated-c23.json). The raw JSON and
worker logs remain in the authorized external scratch area and are not copied
into the repository.

## C23 implementation and compatibility evidence

The baseline source performs two per-file tree lookups for a new path, one for
the operation precondition and one to preserve the existing file mode in
`createCommit`, followed by per-file `hash-object` and `update-index` calls.
The candidate batches contiguous upsert records through `update-index
--index-info -z` against the existing temporary index. It retains per-content
hashing, validation, file modes, commit creation, CAS, receipts, and the
temporary-index path. Pending upserts flush before deletions; mixed path-prefix
conflicts use the complete legacy per-path update path.

Focused semantic checks cover binary contents, spaced and Unicode paths,
executable tree mode, deletion ordering, receipt revisions, and exact publish
acknowledgement. The file/directory compatibility matrix verified that raw
`--index-info -z` accepts writes to both `a` and `a/b` in either order,
including a user `meta` path that conflicts with generated Core metadata,
where legacy sequential `--add --cacheinfo` rejects the operation. The
candidate detects ancestor/descendant path pairs in O(total path segments)
with a set-based walk and falls back for the whole operation. Existing
file-to-directory and directory-to-file transitions fail Core path
preconditions. The focused test
`batched temporary-index updates preserve legacy file-directory conflict
semantics` passed, including rejection with no partial ref or receipt changes.

The isolated C23 measurements support the batching candidate at these tested
scales. This report does not claim a general total-workload p95 improvement;
full repository gates remain a separate validation step.

## Candidate dispositions

**C27 — decline a census index/cache on current evidence.** The one-operation
history completed with three samples, p50/p95 154/176 ms and 16/27 Git
processes; all receipt integrity checks passed. Histories of 100, 1,000, and
10,000 operations remain `NOT_CHECKED` because public checkpoint setup timed
out at 20/100 after 60 seconds, 20/1,000 after 90 seconds, and 0/10,000 after
120 seconds. These results do not establish whether operation-record reads,
worktree status, ancestry checks, or the `rev-list --all --reflog` scan become
material at representative scale, and they do not prove an auxiliary index
preserves unknown-commit, restart, reflog, and manual-parent detection.
Reconsider only after a complete representative history measurement shows
material source-stage cost and a rebuildable index is shown to preserve those
checks.

**C28 — decline request-scope memoization on current evidence.** The completed
one-operation and ten-operation batches had exact publish acknowledgements,
with p50/p95 1,666/5,223 ms and 4,618/5,354 ms, and 98 and 584 Git processes.
These were contended totals without valid phase attribution; they do not show
that repeated immutable reads account for a material share of work. The
100-operation case remains `NOT_CHECKED` after setup timed out at 20/100 after
180 seconds. Reconsider only when an isolated complete batch with valid phase
or command attribution shows material repeated immutable reads. Any future
memo must remain request scoped and preserve fresh observation, remote CAS,
retry, unknown-outcome, and receipt reconciliation boundaries.

The initial cohort raw files and `PREPARED.md` retain its setup progress and
remaining `NOT_CHECKED` scales. The separate canonical verification results and
raw command-log hashes are recorded in
[`VERIFICATION.md`](results/core64-writer/VERIFICATION.md).
