# Core 64 G1 C02 candidate measurement

This is a partial input-phase comparison, not a passing full browser run or an adoption decision. The before capture is G0's completed Core small run at source `a1587e784788fa87d86c0eb7ab175d7a28a3209f`; the after capture was built with the uncommitted C02 editor candidate on top of planning commit `eba9a02adc0428ef17b42738861cbb315cec5d45` (candidate diff SHA-256 `93c9852f8310dcca8025819a011fe04629ba73eb704ad753b59740f271c21a39`). Both use Chromium `155.0.8059.79`, Node `v24.21.0`, the same harness SHA-256 `02e9a6fd44b56e25390ecc8a61591e2899446b3c424cec1ce57a189779f7a087`, and the same generated small fixture commit `e70bb509cc41b383451335e05af36d78f1cb31db` with 1 KiB / 100 KiB / 1 MiB documents.

The after run completed all three input phases (20 ArrowLeft keydowns per size) and saved its profile, then failed in the first subsequent file-switch phase: `openScene` expected Scene 1 but the heading remained Scene 3 until Playwright's 60 s timeout. Therefore file-switch and idle results are absent; the after run status remains **failed** and is not a browser acceptance pass.

| Document | Arrow n | Before p50 / p95 / p99 / max (ms) | Candidate p50 / p95 / p99 / max (ms) | Typing p95 before → candidate (ms) |
| --- | ---: | --- | --- | ---: |
| 1 KiB | 20 | 4.0 / 6.4 / 7.4 / 7.4 | 7.1 / 11.8 / 12.4 / 12.4 | 9.4 → 9.0 |
| 100 KiB | 20 | 50.7 / 55.5 / 56.8 / 56.8 | 6.1 / 15.5 / 67.9 / 67.9 | 55.8 → 60.9 |
| 1 MiB | 20 | 510.6 / 606.9 / 611.7 / 611.7 | 4.2 / 25.7 / 37.3 / 37.3 | 576.6 → 541.6 |

Input timing is the harness's keydown-to-next-animation-frame opportunity proxy, not OS input-to-pixel latency. With n=20, p99 is the maximum. The single after run suggests materially lower large-document arrow latency, while the small-document arrow cohort regressed. At 1 MiB, React commits were 96 → 95, IndexedDB reads 30 → 30, and strict completed writes 22 → 22; Long Task p95 was 606 → 536 ms but the maximum rose 673 → 1,032 ms. The phase-end largest Renderer RSS was 5.916 → 2.633 GiB; process IDs differ between runs and the after run failed before later phases, so this is diagnostic only.

The old selection callback calls `doc.toString()` and rebuilds sentence offsets for each selection update. The candidate cache test uses real immutable CodeMirror `Text` and `EditorState` selection-only updates: one preceding document-change materialization/build, then **0 additional full materializations and 0 additional index builds across four selection updates**. The browser arrow cohort is not separately instrumented for these counts; no production telemetry was added. The focused test also asserts exact Japanese punctuation/dialogue, UTF-16 surrogate, LF/blank-line sentence mapping. W1 C01 changed-string reuse and C05 external value synchronization remain unchanged.

Verification completed for this measurement checkpoint: `pnpm install --frozen-lockfile`, `SCRIPTORIUM_PROFILE=core pnpm build`, and `pnpm --filter @scriptorium/app exec node --import tsx --test src/continueCandidates.test.ts` (6/6 passed). The general browser harness exited 1 after the input phases as described above. Full workspace gates and focused scene-change Chromium acceptance remain pending; do not adopt until the navigation failure is ruled out and the required verification passes.

Raw captures are retained outside the repository:

- Before report/profile: `/data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/results/browser-small.json` and `.json.cpuprofile`.
- Candidate report/profile: `/data/scriptorium-core64-g1-c02-eba9a02-20261020-1454/results/browser-small-after.json` and `.json.cpuprofile`.
- Candidate fixture: `/data/scriptorium-core64-g1-c02-eba9a02-20261020-1454/synthetic`.
