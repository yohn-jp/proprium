# Core 64 writer probe status

**Status: partial `NOT_CHECKED` contended cohort.** The fixed C23/C27/C28 run
completed after the coordinator's grant. C23 checkpoint scales 1/10/100,
C27 census at 1 operation, and C28 publish at 1/10 operations completed with
semantic assertions passing. C27 census at 100/1,000/10,000 and C28 publish at
100 hit their bounded setup timeouts and have zero timed samples. See
[`CORE-64-WRITER.md`](../../CORE-64-WRITER.md) and the adjacent raw JSON.

The run used CPUs 4–7 with `CORE64_WRITER_RUN_MODE=contended`, alongside the
coordinator's other assigned lanes. Its walltimes are contended observations
and cannot support an optimization adoption decision. The G0 seed remained
read-only and the accepted frozen Core runtime is pinned by commit and
SHA-256; the final run record verifies both were unchanged.

The probe covers C23 checkpoint batches (1/10/100 files), C27 durability census
histories (1/100/1,000/10,000 operations), and C28 pending publish batches
(1/10/100 operations). See
[`CORE-64-WRITER.md`](../../CORE-64-WRITER.md) for the input guards, runtime
hashes, sample counts, integrity assertions and timeout budgets.

The maximum sum of case worker budgets was 15 minutes 30 seconds, plus process
launch overhead; reserve 17 minutes for a rerun. The 10,000-operation C27 case
has a two-minute total budget and timed out before completing proposal setup;
that result remains `NOT_CHECKED`.
