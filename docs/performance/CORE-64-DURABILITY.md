# Core 64: bounded scene and draft durability probe

Status: **probe prepared; browser evidence pending an explicit measurement grant**. Preparation has received a Node syntax check and CLI help check. It has not built the application, generated or modified a fixture, launched Chromium, or run E2E tests.

This leaf investigates C10, C12, C13, C17, C18, and C19 against the shared C09 plain Core/API/app build input at `ffd02739ab095dfda2854a3ff487434c84f6b536`, with source branch `main` at `9751f55f1204c2567d0a7145e165097a86465fdc`. The source roots `app/src`, `packages/core/src`, `packages/api/src`, and `profiles/core` have identical Git tree IDs at the runtime-code milestone `e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47` and the exact build input, so this probe measures the same production implementation. Its fixture is G0's canonical synthetic small dataset: 10 files, three scenes, and manuscript sizes of 1 KiB, 100 KiB, and 1 MiB. It invokes the existing performance `server.mjs` and `installBrowserProbes()`; the application writes through its real IndexedDB journal with its requested strict durability. It does not add production instrumentation or a new persistence path.

The probe records three bounded edit bursts, one scene switch with an unsaved edit inside the 350 ms debounce window, repeated clean scene switches, and a rapid-navigation freshness smoke. Each burst checks the exact marker in the saved journal row and records completed strict `operations` read/write transactions, transaction duration, IDB read calls/returned rows, timer scheduling/firing/cancellation, and fetch timing. Scene changes retain the browser API request timeline, server route duration/status, strict flush transaction, local journal reads, and time to render the requested scene.

The `nearest350TimerToTransactionStartMs` value is a timer-to-IDB-start proxy for serialized queue wait. It is not a direct observation of `draftQueueRef`; the raw timer callsites and transaction timeline must be checked before treating it as queue-wait evidence. Strict transaction duration measures browser-observed transaction completion, not a physical fsync count or device flush.

The probe does not claim asynchronous `pagehide` or `beforeunload` writes are durable. C19's reload/unsaved-data and quota behavior will be checked by reusing the existing quota acceptance test. Completed-draft reload and stale same-origin tab behavior will use existing E2E coverage; C18's Draft, Checkpoint, and confirmed publication receipts remain invariants, not optimization targets. Native force-quit, process termination, and power loss remain `NOT_CHECKED`.

After the explicit measurement grant, run from the isolated durability worktree with the already-built runtime and immutable G0 fixture:

```sh
SCRIPTORIUM_C64_RUNTIME_ROOT=/home/sophia/src/scriptorium-c64-resize \
node scripts/performance/core64-durability-probe.mjs \
  /home/sophia/src/scriptorium-c64-resize \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/small \
  /data \
  docs/performance/results/core64-durability/probe.json 8
```

The runner creates and removes a unique `core64-durability-*` directory directly under `/data` for each capture.

By default, the runner reads `docs/performance/results/core64-resize/runtime-manifest.json` from the runtime root. `SCRIPTORIUM_C64_RUNTIME_MANIFEST` can override that path. Before starting Chromium, it verifies the manifest source and production identity, requires the Core, API, app, generated profile, contracts, and module-runtime build roots, checks every listed artifact's size and SHA-256 against the files in the runtime root, and records the manifest and its hash in the output. It validates all roots listed by the manifest, so additional workspace artifacts are covered too.

Set `SCRIPTORIUM_E2E_CHROMIUM` to the same Chromium 155 executable recorded in the G0 environment when running the probe and focused E2E cases. Keep all generated scratch data under `/data`; only the compact report and grounded decision belong in this branch.

The runner accepts `SCRIPTORIUM_C64_RUNTIME_ROOT` as the runtime path override and fails closed unless `HEAD` matches `SCRIPTORIUM_C64_EXPECTED_RUNTIME_SHA` (default `ffd02739ab095dfda2854a3ff487434c84f6b536`). It consumes the C09 runtime artifact manifest and records its artifact hashes before measurement. The recorded source branch moved to `9751f55f1204c2567d0a7145e165097a86465fdc`.

Preparation validation: `node --check scripts/performance/core64-durability-probe.mjs` and the `--help` path both exited 0. Browser capture, recovery E2E, and any producer-owned implementation decision — **pending explicit measurement grant**.
