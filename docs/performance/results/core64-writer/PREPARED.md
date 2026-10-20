# Core 64 writer probe status

**Status: isolated C23 matched cohort complete; C27/C28 remain partial.** The
guarded C23 candidate and accepted baseline each completed five checkpoint
samples at 1, 10, and 100 files. Receipt revisions and pending-checkpoint
census assertions passed for all 30 samples. Exact Git process totals were
stable per scale: baseline/candidate 50/47, 104/92, and 644/542. The compact
matched evidence and raw report hashes are in
[`isolated-c23.json`](isolated-c23.json); the full cohort report is in
[`CORE-64-WRITER.md`](../../CORE-64-WRITER.md).

The C23 workers used requested and effective CPUs 4–7. Variant order
alternated by scale: baseline then candidate at 1 file, candidate then baseline
at 10, and baseline then candidate at 100. Each worker collected five fresh
contexts. Shared-host external activity is unknown. At n=5, nearest-rank p95
is the maximum sample and is not a stable tail estimate. The 100-file workers
retained complete command logs for their first sample only because the
instrumentation caps each worker at 1,000 argv records; all aggregate process
counts remain exact.

C27's census history beyond one pending operation and C28's 100-operation
publish setup remain `NOT_CHECKED` after their bounded setup timeouts. The
report records why census indexing/cache and request-scope publish memoization
are declined on current evidence, with concrete reconsideration conditions.
These limits do not imply a global blocked result.

No full repository gates were run as part of this evidence commit. The C23
source candidate remains frozen at `0152e9211f00abdbfdbc36939505d48162a3c1a1`;
the measured candidate build hash is recorded in `isolated-c23.json`.
