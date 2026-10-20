# C58 disposition proposal — G0 evidence only

Draft for coordinator review; this proposal is not yet counted in the `10/64` final dispositions in [`CORE-64-RESULTS.md`](../../CORE-64-RESULTS.md). It records Wave 0 measurement coverage and G0's actual post-W1 reference. G5's final runtime certification remains separate and pending.

| ID | Gate | Decision | Baseline / head | Changed paths | Scenario and result | Verification | Evidence | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C58 | G0 (G5 certification pending) | `VERIFIED_EXISTING` — existing harness coverage and the requested post-W1 baseline are recorded; no optimization comparison is claimed. | `a1587e78` / `a1587e78` (runtime unchanged; G0 evidence commit `80ab121a`) | Evidence only; production and harness source unchanged. | Core profile; four synthetic tiers, 20 read/input/switch repetitions, 180 s per-worker budget, 35 s visible-idle window. Baseline only; no before/after candidate cohort. Main-JS gzip estimates: launcher 228,587 B, desktop 239,035 B, mobile 434,651 B; mobile all-chunk estimate 441,189 B. Startup is `n=1`; detailed startup, CPU/RSS, input percentiles, and workload outcomes are in the linked G0 report. | Captured G0 results: frozen install PASS (348 packages linked, none downloaded), typecheck PASS, tests PASS (419 passed, one existing opt-in semantic CPU case skipped), Core build PASS, Core audit PASS (128 production dependency versions), harness tests PASS (8 passed, one existing opt-in browser probe skipped), Full build PASS. These checks were not rerun for this proposal. | [G0 report](../../G0-CORE-64-BASELINE.md), [C58 summary](c58-summary.json), [asset sizes](assets.json), [artifact manifest](MANIFEST.json). Raw capture: `/data/scriptorium-core64-g0-a1587e78-20261020-2318`; the G0 manifest inventories 61 result artifacts (272,377,675 B). | Large search/stats and stress search/stats produced no scan sample before their 180 s worker budgets. Stress read is partial and remains `NOT_CHECKED`; stress browser readiness failed at its 60 s action timeout. Hidden-tab idle, native OS IME, long idle, hosted GitHub traffic, OCI measurements, and crash/network-partition scenarios are `NOT_CHECKED`. No regression budget or CI gate is claimed; G5 final runtime certification remains pending. |

## Four-tier outcome record

Each tier contains 1 KiB, 100 KiB, and 1 MiB synthetic manuscripts. Large and stress also contain the fixed 10 MiB synthetic attachment; stress has 100 deterministic metadata commits. Fixtures use local synthetic remotes and contain no user repositories or manuscripts.

| Tier | Tracked files | Scenes | Tracked bytes | Core workload outcome | Browser outcome |
| --- | ---: | ---: | ---: | --- | --- |
| small | 10 | 3 | 1,152,477 | Read, mutation, revisions, search, and stats complete. | Complete. |
| medium | 1,000 | 493 | 3,216,993 | Read, mutation, revisions, search, and stats complete. | Complete. |
| large | 10,000 | 4,944 | 17,306,597 | Read, mutation, and revisions complete. Search and stats exceeded the 180 s worker budget before a scan sample; `NOT_CHECKED`. | Complete. |
| stress | 100,000 | 49,449 | 68,743,498 | Mutation and revisions complete. Read retained one registration and cold-tree sample plus nine warm-tree and nine scene-snapshot samples before the worker budget ended; unfinished read, search, and stats remain `NOT_CHECKED`. Search and stats produced no scan sample before 180 s. | Local API was reached, but editor readiness failed: `.scene-heading h1` did not show `Scene 1` within the 60 s action timeout. No stress editor-input or idle values are inferred. |

The compact asset figures are Node `gzipSync` estimates, not HTTP transfer sizes. Launcher CSS is 28,230 B / 6,330 B gzip; desktop CSS 48,242 B / 9,422 B; mobile CSS 65,359 B / 13,263 B. Full startup values and sampled first-editor API/renderer CPU and RSS are in the report; their phase samples are `n=1`. The small/medium/large visible-idle observations are 35 seconds only.

## Reproduction and artifact identity

The recorded measurement command was:

```sh
BENCH_SIZES=small,medium,large,stress \
BENCH_REPEATS=20 BENCH_TIMEOUT_MS=180000 BENCH_IDLE_MS=35000 \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
node scripts/performance/run.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic
node scripts/performance/summarize.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/results
```

The already-recorded verification commands were `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `SCRIPTORIUM_PROFILE=core pnpm build`, `pnpm audit:core`, `node --test scripts/performance/*.test.mjs`, and `SCRIPTORIUM_PROFILE=full pnpm build`; their captured results are summarized above and detailed in the G0 report. They were not rerun for this draft.

The checked-in G0 manifest preserves per-artifact raw-result hashes. Its SHA-256 is `483c6299810e7881ebcc61d096dc7936450e2c00f7b4abbc1e6f0f4695767eca`; `c58-summary.json` is `b0c975fc060675a9a52d60e993aec1623dfec70b9c6d850ead9c4d0e07a60dad`, and `assets.json` is `ffcd04d513b220088502525a7321168ebbfc095a34919453abfeee937342cb26`. The G0 raw capture is retained on `/data` as the uncompressed directory above; no new G0 tar or external release was created. The older Wave 0 release asset at [perf-wave0-2026-10-20](https://github.com/yohn-jp/scriptorium/releases/download/perf-wave0-2026-10-20/scriptorium-wave0-2026-10-20.tar) has SHA-256 `aa8ed77475d4a05b847e565f4cadd69a557e839816b708b76e08c700778fb0d3` and is separate from this post-W1 G0 capture.

The baseline has no candidate `after` value: it sets a reference, not a regression gate. Hidden-tab idle, native physical IME, 24-hour idle, OCI, hosted GitHub transport, crash recovery, and network-partition behavior remain explicitly `NOT_CHECKED`.
