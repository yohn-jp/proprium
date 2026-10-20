# Core 64 writer probe status

**Status: NOT_CHECKED.** The scripts and bounded case definitions are prepared;
no fixture generation, build, test, or measurement has run. The G0 seed remains
read-only and the accepted frozen Core runtime is pinned by commit and SHA-256.
The G5 verification and G3 environment batch currently own the heavy-run
window, so this probe is staged for a later exclusive lease.

The probe covers C23 checkpoint batches (1/10/100 files), C27 durability census
histories (1/100/1,000/10,000 operations), and C28 pending publish batches
(1/10/100 operations). See
[`CORE-64-WRITER.md`](../../CORE-64-WRITER.md) for the input guards, runtime
hashes, sample counts, integrity assertions and timeout budgets.

The maximum sum of case worker budgets is 15 minutes 30 seconds, plus process
launch overhead. The 10,000-operation C27 case has a two-minute total budget and
may time out during public checkpoint setup; such a result remains
`NOT_CHECKED`.
