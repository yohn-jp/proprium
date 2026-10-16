# P13 model and worker lifecycle evidence

This acceptance unit exercises the compiled Story, NLP, Diagnostics, and Semantic modules through the production `ModuleRuntime`, `CoreStore`, real local Git snapshot reader, and the default `WorkerSupervisor` bounds. It is a host-process proof; it does not certify the final OCI image or profile composition. The broader composed OCI checks remain in [Acceptance](ACCEPTANCE.md) and the P13 requirements in the [full migration plan](../migration/FULL-MIGRATION-PLAN.md).

The test uses only a disposable synthetic repository and the pinned CPU model artifacts already staged by the [P13 model preflight](P13-MODEL-PREFLIGHT.md). It does not download or copy model weights into the worktree. The default cache path is `/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models`; set `SCRIPTORIUM_P13_MODEL_CACHE` to that existing cache root if it is elsewhere. The test requires E5 revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, BGE reranker revision `e5023553f6c47f09057da7a19cdd79ef850a4985`, and the installed Lindera IPADIC package. The reranker request uses the production module's fp32 and external-data configuration.

Run from the repository root after the compiled Core and module runtime packages have been built:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @scriptorium/module-semantic build
SCRIPTORIUM_P13_MODEL_CACHE=/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models \
  node --test tests/integration/model-lifecycle.acceptance.mjs
```

The test leaves the runtime worker duration at its production default. It verifies that installed-disabled and enabled-idle states have no worker process; actual Story reads do not start models; author external-consent, semantic settings, and contradiction-dismissal files remain byte-for-byte intact; and diagnostics' real habitual-phrase path acquires the same semantic capability instance as the semantic module. Test-only gates pause callers after `ModuleRuntime` has granted each real capability lease, which makes the overlapping consumers deterministic without replacing the capability or model. A semantic action canceled while queued behind diagnostics must not terminate diagnostics' active shared worker. Disabling Diagnostics while it holds a lease during an active semantic rebuild must not terminate that rebuild. The pinned E5 model produces the derived index, deleting that file makes the actual worker report it missing, and rebuilding recreates it. After the final lease is released and Semantic is disabled, its child PID must be gone. Re-enabling Semantic stays lazy until a new action starts a replacement child; a search then exercises both the pinned E5 embedding and BGE reranking engines.

Resource measurements use only PIDs exposed by this test runtime's `WorkerSupervisor`. For those owned children, the test reads `/proc/<pid>/status` for RSS and `/proc/<pid>/cmdline` to identify the compiled worker entry. A 100 ms sampler records peak owned-child RSS and process count, plus the semantic worker's own count and RSS, for each named phase. A 50 ms timer records the largest event-loop delay observed in that phase. These are host measurements of module worker children; they do not include the API process, container cgroup totals, filesystem page cache, or browser processes.

## Result

**PASS on `55cecfa5af73982d2b98009c125928f1ab3126c5`.** The exact command above passed on current integrated source with the default 15-minute `WorkerSupervisor` deadline and the semantic worker's 10-minute request deadline; no timeout override was set. The focused test passed 1/1 in 91.35 seconds after the full `pnpm build`.

The emitted observations used the existing cache at `/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models`, with E5 revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78` and BGE revision `e5023553f6c47f09057da7a19cdd79ef850a4985`:

| Phase | Peak supervised child count / RSS | Peak Semantic worker count / RSS | Max event-loop delay |
| --- | ---: | ---: | ---: |
| Installed, Semantic disabled | 0 / 0 MiB | 0 / 0 MiB | 0 ms |
| Enabled and idle | 0 / 0 MiB | 0 / 0 MiB | 0 ms |
| Diagnostics and Semantic overlap | 2 / 1330.7 MiB | 1 / 1127.7 MiB | 14.8 ms |
| Diagnostics disabled during Semantic rebuild | 2 / 1277.5 MiB | 1 / 1078.4 MiB | 8.9 ms |
| Replacement E5 and BGE search | 1 / 1705.7 MiB | 1 / 1705.7 MiB | 4.6 ms |
| After final release | 0 / 0 MiB | 0 / 0 MiB | 0 ms |

Both overlap phases observed exactly one compiled semantic worker PID while the two real consumers shared the same capability instance. The test observed no supervised child at disabled or enabled-idle startup, then observed the semantic child exit after its final lease was released. This is host-process evidence only; final OCI image and cgroup measurements remain with the composed OCI acceptance.
