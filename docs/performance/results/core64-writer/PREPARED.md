# Core 64 writer probe status

**Status: NOT_CHECKED.** The scripts and bounded case definitions are prepared;
no fixture generation, build, test, or measurement has run. The G0 seed remains
read-only and the accepted frozen Core runtime is pinned by commit and SHA-256.
The probe is staged for an affinity-pinned contended cohort after C59 releases
the first-paint metrics lane and the coordinator grants execution. CPUs 8–11
are available; `taskset` will apply that affinity to the runner, and child
workers and Git processes inherit it. The runner and workers record the
effective CPU set. Overlapped walltimes will be labeled contended and cannot
support an optimization adoption decision.

The probe covers C23 checkpoint batches (1/10/100 files), C27 durability census
histories (1/100/1,000/10,000 operations), and C28 pending publish batches
(1/10/100 operations). See
[`CORE-64-WRITER.md`](../../CORE-64-WRITER.md) for the input guards, runtime
hashes, sample counts, integrity assertions and timeout budgets.

The maximum sum of case worker budgets is 15 minutes 30 seconds, plus process
launch overhead; reserve 17 minutes. The 10,000-operation C27 case has a
two-minute total budget and may time out during public checkpoint setup; such a
result remains `NOT_CHECKED`.
