# CORE-64 G0 baseline — C58

Captured on 2026-10-20 from source commit `a1587e784788fa87d86c0eb7ab175d7a28a3209f`, the post-W1 base for CORE-64. This records the C58 starting point for Core-profile bundle size, browser startup, process CPU/RSS, and the existing synthetic Core workloads. No production code or benchmark harness source changed during the capture. This baseline sets no performance budget and makes no regression-pass claim.

The compact, machine-readable C58 results are in [c58-summary.json](results/core64-g0/c58-summary.json); the complete harness summary and operation tables are [summary.json](results/core64-g0/summary.json) and [tables.md](results/core64-g0/tables.md). [assets.json](results/core64-g0/assets.json), [environment.json](results/core64-g0/environment.json), and [MANIFEST.json](results/core64-g0/MANIFEST.json) preserve bundle measurements, toolchain details, raw-result hashes, verification logs, and checksums for reusable Core build artifacts. Raw measurements, traces, CPU profiles, and command logs remain under `/data/scriptorium-core64-g0-a1587e78-20261020-2318` and are not checked into Git.

## Capture conditions

The run used the unchanged [`scripts/performance/README.md`](../../scripts/performance/README.md) harness and built source at the recorded commit. The worktree was clean when `run.mjs` captured its environment. It generated all four canonical synthetic tiers sequentially with 20 read/input/switch repetitions, a 180-second worker limit, and a 35-second visible idle window. Each tier used 1 KiB, 100 KiB, and 1 MiB manuscripts; the large and stress tiers also contain the fixed 10 MiB synthetic attachment. No user repository or manuscript was read. Browser mutations and publication stayed on local synthetic remotes.

The host was NixOS Linux 6.18.52 x86_64 with an Intel Core i5-14600KF, 16 logical CPUs, and 50,994,450,432 bytes of RAM. The toolchain was Node `v24.21.0`, pnpm `12.10.1`, Git `2.54.0`, and headless Chromium `155.0.8059.79` at `/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium`. This was a shared workstation; OS and Git object caches were not flushed. “Cold” therefore means a new worker/Core cache, not a disk-cache-cold host.

The exact measurement command was:

```sh
BENCH_SIZES=small,medium,large,stress \
BENCH_REPEATS=20 BENCH_TIMEOUT_MS=180000 BENCH_IDLE_MS=35000 \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
node scripts/performance/run.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic
node scripts/performance/summarize.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/results
```

| Fixture | Tracked files | Scenes | Tracked bytes | Seed commit | Browser |
| --- | ---: | ---: | ---: | --- | --- |
| small | 10 | 3 | 1,152,477 | `e70bb509cc41b383451335e05af36d78f1cb31db` | Complete |
| medium | 1,000 | 493 | 3,216,993 | `773d4bb408f333e330e5359d74d43da8fe990554` | Complete |
| large | 10,000 | 4,944 | 17,306,597 | `1adbb44980a9ccee009c536c7593fb23503ed86c` | Complete |
| stress | 100,000 | 49,449 | 68,743,498 | `86eb03604a68765553c4c89753af459f48c3950c` | `NOT_CHECKED` at editor readiness |

Each worker used a fresh Core process, store, and local bare remote. Git and browser instrumentation were opt-in harness probes. The complete generated fixture and uncompressed result files occupy the task-owned `/data` capture root; the manifest records each result/log hash and the checksums of Core/API/app/profile outputs available for reuse.

## C58 measurements

The Core build produced these static UI assets. Gzip sizes use Node `gzipSync`; they are size estimates, not HTTP transfer sizes. Mobile's total includes its generated JavaScript chunks, while the historical comparison is main-file-to-main-file.

| UI | Main JavaScript bytes / gzip | Total JavaScript bytes / concatenated gzip estimate | CSS bytes / gzip |
| --- | ---: | ---: | ---: |
| Launcher | 723,070 / 228,587 | 723,070 / 228,587 | 28,230 / 6,330 |
| Desktop | 753,221 / 239,035 | 753,221 / 239,035 | 48,242 / 9,422 |
| Mobile | 1,667,936 / 434,651 | 1,688,058 / 441,189 | 65,359 / 13,263 |

Against the W0 asset table in [`BASELINE.md`](BASELINE.md), launcher main JavaScript is +5,487 bytes / +1,659 gzip bytes, desktop is +5,481 / +1,653, and mobile main is +5,482 / +1,575. CSS byte counts match. The mobile total gzip estimate concatenates assets before compression and does not represent how the browser requests or caches individual files.

Browser startup figures below are one observation per phase and fixture (`n=1`). Login readiness is measured from desktop navigation; registration-to-outline and first-editor are separate action timings. API process CPU and RSS are sampled at the first-editor boundary. Node CPU excludes child Git CPU. The browser renderer RSS is a sampled process value, not PSS or a continuous peak.

| Fixture | API listen ms | Login ready ms | Register to outline ms | First editor ms | API RSS / process CPU at first editor | Largest renderer RSS / JS heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 177.1 | 197.0 | 345.4 | 311.3 | 95.5 MiB / 569.0 ms | 199.2 MiB / 7.7 MiB |
| medium | 178.6 | 201.5 | 854.4 | 312.1 | 104.8 MiB / 677.2 ms | 219.9 MiB / 11.3 MiB |
| large | 189.6 | 188.8 | 1,554.1 | 1,543.6 | 176.1 MiB / 1,386.2 ms | 317.8 MiB / 25.2 MiB |
| stress | 192.2 | `NOT_CHECKED` | `NOT_CHECKED` | `NOT_CHECKED` | `NOT_CHECKED` | `NOT_CHECKED` |

At the first-editor boundary, the API had issued 58 / 58 / 57 top-level Git processes for small / medium / large and made 23 / 23 / 21 asynchronous `readFile` calls. These counters are for the measured server process and harness probes; they are not a syscall census or child-Git CPU measure.

| Fixture | Visible idle window | API Node CPU | Chromium process CPU sum | Requests during idle |
| --- | ---: | ---: | ---: | ---: |
| small | 35.0 s | 162.7 ms | 5.28 s | 6 |
| medium | 35.0 s | 248.9 ms | 5.51 s | 9 |
| large | 35.0 s | 352.8 ms | 5.65 s | 9 |

The whole browser scenario transferred 35,750,146 / 35,898,840 / 36,274,805 encoded bytes for small / medium / large. Those totals include startup, edits, UI checkpoint/publish, refreshes, and the open event stream; they are not startup-only transfer measurements. The 1 MiB input p50 / p95 / p99 frame-opportunity latencies were 510.7 / 576.6 / 626.7 ms (small), 502.2 / 579.1 / 610.9 ms (medium), and 491.3 / 532.9 / 591.9 ms (large), each `n=20`; the detailed table also records IDB transactions, long tasks, operation CPU/RSS, and Git counts.

## Worker outcomes and limits

Small and medium completed all six Core/browser workloads. Large completed read, mutation, revisions, and browser workloads; search and stats exceeded their 180-second worker budgets before producing a scan sample and remain `NOT_CHECKED`. Stress completed mutation and revisions. Stress read retained one registration sample, one cold-tree sample, and nine each for warm-tree and scene-snapshot reads before its worker budget ended; the worker remains `NOT_CHECKED` for unfinished operations. Stress search and stats exceeded their worker budgets before producing scan samples. The stress browser reached the local API but failed editor readiness: Playwright did not find `.scene-heading h1` with the expected `Scene 1` within its 60-second action timeout. No stress editor-input or idle metrics are inferred.

Headless Chromium kept the original page visible, so hidden-tab idle is `NOT_CHECKED`. Native OS IME, physical devices, hosted GitHub traffic, OCI startup/RSS/image size, network outage or crash behavior, and 24-hour idle were not measured. Browser RSS was sampled at phase boundaries; summed process RSS double-counts shared pages. The browser harness adds DevTools/React/IDB probes and measures frame opportunities, not OS input-to-pixel latency. At `n=20`, p99 is the maximum; at `n=1`, all reported percentiles are the single observation. These limits follow the [harness methodology](../../scripts/performance/README.md#interpretation).

## Verification and reusable runtime

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS; 348 packages linked from the local store, none downloaded |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 419 passed, 1 existing opt-in semantic CPU case skipped, 0 failed |
| `SCRIPTORIUM_PROFILE=core pnpm build` | PASS; existing Vite chunk-size warnings retained |
| `pnpm audit:core` | PASS; 128 production dependency versions scanned, including after Core-profile restoration |
| `node --test scripts/performance/*.test.mjs` | PASS; 8 passed, 1 existing opt-in browser-probe test skipped |
| `SCRIPTORIUM_PROFILE=full pnpm build` | PASS; existing Vite chunk-size warnings retained |

After the full-profile build, `profiles/core/generated`, `app/dist`, and `packages/api/dist` were restored for the captured Core profile; `packages/core/dist` remained available. A final Core dependency audit passed. The reusable runtime root is `/home/sophia/src/scriptorium-c64-g0`, branch `perf/c64-g0`, source commit `a1587e784788fa87d86c0eb7ab175d7a28a3209f`. The artifact manifest lists file checksums for `packages/core/dist`, `packages/api/dist`, `app/dist`, and `profiles/core/generated`; no test suite was rerun during restoration.

No GitHub Actions, CI workflow, OCI publication, external release, or production source change was made for G0.
