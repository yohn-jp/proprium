# Core 64: bounded scene and draft durability probe

Status: **capture complete; no production change proposed**. The fixed Chromium cohort completed in 20.5 seconds on 2026-10-21. No application build, fixture generation, fixture mutation, schema change, or E2E rerun occurred in this leaf.

This leaf investigates C10, C12, C13, C17, C18, and C19 against the shared C09 plain Core/API/app build input at `ffd02739ab095dfda2854a3ff487434c84f6b536`, with source branch `main` at `9751f55f1204c2567d0a7145e165097a86465fdc`. The source roots `app/src`, `packages/core/src`, `packages/api/src`, and `profiles/core` have identical Git tree IDs at the runtime-code milestone `e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47` and the exact build input, so this probe measures the same production implementation. Its fixture is G0's canonical synthetic small dataset: 10 files, three scenes, and manuscript sizes of 1 KiB, 100 KiB, and 1 MiB. It invokes the existing performance `server.mjs` and `installBrowserProbes()`; the application writes through its real IndexedDB journal with its requested strict durability. It does not add production instrumentation or a new persistence path.

The probe records three bounded edit bursts, one scene switch with an unsaved edit inside the 350 ms debounce window, repeated clean scene switches, and a rapid-navigation freshness smoke. Each burst checks the exact marker in the saved journal row and records completed strict `operations` read/write transactions, transaction duration, IDB read calls/returned rows, timer scheduling/firing/cancellation, and fetch timing. Scene changes retain the browser API request timeline, server route duration/status, strict flush transaction, local journal reads, and time to render the requested scene.

The `nearest350TimerToTransactionStartMs` value is a timer-to-IDB-start proxy for serialized queue wait. It is not a direct observation of `draftQueueRef`; the raw timer callsites and transaction timeline must be checked before treating it as queue-wait evidence. Strict transaction duration measures browser-observed transaction completion, not a physical fsync count or device flush.

The probe does not claim asynchronous `pagehide` or `beforeunload` writes are durable. It did not run recovery E2E tests; it reuses the already-executed C02/G0 regression evidence summarized below. Native force-quit, process termination, page-exit durability, actual storage exhaustion, and power loss remain `NOT_CHECKED`.

## Capture and disposition

The frozen C09 runtime was `ffd02739ab095dfda2854a3ff487434c84f6b536`, with six manifest roots, 85 artifacts, and 5,095,497 bytes. The manifest SHA-256 is `f16e9db3d4e99c39985044ef44fa677dde62678be54f0d36f53693bf095a9031`. Chromium was `155.0.8059.79`; the fixture is the canonical synthetic small dataset with 10 files, three scenes, and 1 KiB / 100 KiB / 1 MiB manuscripts.

- **C10 — DECLINED for a production change.** The pending-draft switch took 285 ms. Its strict `operations` write completed in 13.8 ms, and the exact marker was present afterward. The scene `/views` GET began 0.2 ms after that transaction completed; the separate recent-activity PUT began before completion. Across eight clean scene switches, end-to-end p50 was 607 ms and p95/max was 1,560 ms (at n=8, p95 is the maximum). Scene-view fetches took 78–181 ms in the browser and 75–128 ms in the API server. The remaining wait includes readiness/rendering and is not assigned to a producer by this capture. This is one small-fixture run, not a matched before/after comparison; no prefetch or cache change is justified.
- **C12 — DECLINED for weakening or restructuring strict writes.** Each of the three bursts completed exactly one strict `operations` read/write transaction, taking 6 ms, 21.1 ms, and 145.9 ms for the 1 KiB, 100 KiB, and 1 MiB documents. The timer-to-transaction-start proxy was 0–0.4 ms. It is not a direct queue observation, and the three bursts do not measure physical fsync or device flush cost.
- **C13 — VERIFIED_EXISTING; retain the W1 merge.** Each burst performed the indexed `operations.documentKey.getAll` required inside `putLatestDraft`; no full-store entries/proposals refresh occurred in those autosave windows. This is not an independent before/after measurement. The historical W1 capture reduced 1 MiB input reads from 74 to 31 and returned rows from 93 to 28, while typing latency and Long Tasks worsened against C04. Keep the existing strict merge and that tradeoff attached to its result.
- **C17 — DECLINED for parallel or queue changes.** The pending-draft navigation persisted its exact marker before the scene-view request, and the local rapid-switch sequence ended on its final requested scene. The queue-wait proxy was near zero in this single-writer workload; no contended `draftQueueRef` wait was measured, and the rapid-navigation smoke injected no delayed or reordered response. Existing serialization remains the safe choice.
- **C18 — VERIFIED_EXISTING.** Preserve Draft, local Checkpoint, and confirmed publication as distinct states. The prior executed browser regression verifies this happy path; the probe made no change to those stages.
- **C19 — DECLINED for a stronger page-exit durability claim.** The prior quota regression verifies a visible synthetic `QuotaExceededError`, disabled checkpointing, and the beforeunload confirmation on reload. It does not simulate actual storage exhaustion or prove that an asynchronous page-exit write completes. Pagehide, force-quit, process kill, OS termination, and power-loss recovery remain `NOT_CHECKED`.

The C02 final Chromium run recorded 28 passed and 3 skipped across 31 selected tests. Its exact recovery regressions passed: `same-origin stale tabs cannot replace an equal-generation journal draft` (3.8 s), `coalesced typing restores to its unchanged React value without reviving the deleted draft` (2.8 s), `writing UI recovers multi-document drafts and separates Draft, Checkpoint, and GitHub publication` (10.5 s), and `IndexedDB quota failures remain visible and block checkpointing` (3.1 s). The log is `/data/scriptorium-c64-g1-final-verify-20261021/logs/chromium-final-rerun.log`, SHA-256 `b17bd1a5860ff386797ef0f162421a49d3511b8667f1e612355eba03ef109552`. These Chromium/Core tests use disposable local Git and browser fixtures. They cover equal-generation same-origin conflict, delayed draft restore, successful completed-draft reload/checkpoint/publication, and a synthetic quota exception; they do not prove concurrent queue performance, physical quota exhaustion, asynchronous page-exit completion, or crash/power-loss recovery. They were not rerun for this evidence-only leaf. The relevant `SharedApplication.tsx`, `storage/journal.ts`, and E2E test sources match between `9751f55f1204c2567d0a7145e165097a86465fdc` and `ffd02739ab095dfda2854a3ff487434c84f6b536`.

The C14–C16 journal occupancy and inventory measurements are reused from [the Journal evidence](CORE-64-JOURNAL.md); this leaf did not repeat them. No schema, queue, authority, or production source change is proposed.

## Reproduction

Run from the isolated durability worktree with the frozen runtime and immutable G0 fixture. The recorded capture used a 240-second hard process cap and completed in 20.5 seconds:

```sh
timeout --signal=TERM --kill-after=5s 240s env \
TMPDIR=/data/g1rtmp \
SCRIPTORIUM_C64_RUNTIME_ROOT=/home/sophia/src/scriptorium-c64-resize \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
node scripts/performance/core64-durability-probe.mjs \
  /home/sophia/src/scriptorium-c64-resize \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/small \
  /data \
  docs/performance/results/core64-durability/probe.json 8
```

The runner creates and removes a unique `core64-durability-*` directory directly under `/data` for each capture.

By default, the runner reads `docs/performance/results/core64-resize/runtime-manifest.json` from the runtime root. `SCRIPTORIUM_C64_RUNTIME_MANIFEST` can override that path. Before starting Chromium, it verifies the manifest source and production identity, requires the Core, API, app, generated profile, contracts, and module-runtime build roots, checks every listed artifact's size and SHA-256 against the files in the runtime root, and records the manifest and its hash in the output. It validates all roots listed by the manifest, so additional workspace artifacts are covered too.

The runner accepts `SCRIPTORIUM_C64_RUNTIME_ROOT` as the runtime path override and fails closed unless `HEAD` matches `SCRIPTORIUM_C64_EXPECTED_RUNTIME_SHA` (default `ffd02739ab095dfda2854a3ff487434c84f6b536`). It consumes the C09 runtime artifact manifest and verifies every artifact hash before measurement.

Validation for this evidence leaf: the browser capture completed with status `complete`, verified every C09 manifest artifact, saved all four scenarios, and exited 0. `node --check`, CLI help, and `git diff --check` also pass. No broad test suite was rerun because there are no production changes.
