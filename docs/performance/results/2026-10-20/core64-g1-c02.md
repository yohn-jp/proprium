# Core 64 G1 C02 candidate measurement

This record retains the first partial capture and its failed status, then records a focused reproduction and one complete canonical rerun. The before capture is G0's completed Core small run at source `a1587e784788fa87d86c0eb7ab175d7a28a3209f`; the C02 editor candidate was built on planning commit `eba9a02adc0428ef17b42738861cbb315cec5d45` (candidate diff SHA-256 `93c9852f8310dcca8025819a011fe04629ba73eb704ad753b59740f271c21a39`). Captures use Chromium `155.0.8059.79`, Node `v24.21.0`, the canonical harness SHA-256 `02e9a6fd44b56e25390ecc8a61591e2899446b3c424cec1ce57a189779f7a087`, and the same small fixture commit `e70bb509cc41b383451335e05af36d78f1cb31db` with 1 KiB / 100 KiB / 1 MiB documents.

The first after run completed all three input phases (20 ArrowLeft keydowns per size) and saved its profile, then failed in the first subsequent file-switch phase: `openScene` expected Scene 1 but the heading remained Scene 3 until Playwright's 60 s timeout. File-switch and idle results are absent for that attempt; its report remains **failed** and is not a browser acceptance pass.

| Document | Arrow n | Before p50 / p95 / p99 / max (ms) | First candidate attempt p50 / p95 / p99 / max (ms) | Typing p95 before → first attempt (ms) |
| --- | ---: | --- | --- | ---: |
| 1 KiB | 20 | 4.0 / 6.4 / 7.4 / 7.4 | 7.1 / 11.8 / 12.4 / 12.4 | 9.4 → 9.0 |
| 100 KiB | 20 | 50.7 / 55.5 / 56.8 / 56.8 | 6.1 / 15.5 / 67.9 / 67.9 | 55.8 → 60.9 |
| 1 MiB | 20 | 510.6 / 606.9 / 611.7 / 611.7 | 4.2 / 25.7 / 37.3 / 37.3 | 576.6 → 541.6 |

Input timing is the harness's keydown-to-next-animation-frame opportunity proxy, not OS input-to-pixel latency. With n=20, p99 is the maximum. The initial candidate values above are partial and are not a passing browser result. At 1 MiB in that attempt, React commits were 96 → 95, IndexedDB reads 30 → 30, and strict completed writes 22 → 22; Long Task p95 was 606 → 536 ms but the maximum rose 673 → 1,032 ms. Its phase-end largest Renderer RSS was 5.916 → 2.633 GiB; process IDs differ between runs, so this endpoint reading is diagnostic only.

## Focused reproduction and canonical rerun (2026-10-21)

The first after capture failed at the first post-input Scene 3 → Scene 1 transition after the Playwright 60-second heading wait. The saved report shows no subsequent Scene 1 `/views` request. I did not change navigation or API code. On a fresh small matrix fixture, an instrumented Chromium 155 run repeated the harness's 20 character inputs, 20 ArrowLefts, undo/redo, CDP Japanese composition and synthetic paste in each document, then switched Scene 3 → Scene 1. The transition passed in 458 ms, selected Scene 1, and fetched its view with HTTP 200. The same run exercised the “Continue” cursor restore for all three scenes: each saved sentence index 1, restored to the first character, inserted `z` at offset 0, then undid it back to the original text. No page errors or failed requests occurred. The console had only the expected pre-login `/api/session` 401 and missing `/favicon.ico` 404; subsequent API responses, including all three scene view reads, were HTTP 200. Native OS IME was not tested; composition was synthetic CDP input.

Because this focused sequence passed and the large-document result remained promising, I ran the canonical browser harness once more against the original same fixture. It completed with status `complete`: all 20 scene switches, checkpoint, publish, and 35,000 ms visible idle passed. The earlier 60-second failure was not reproduced; its cause remains unknown and its failed artifact is preserved.

| Document | Arrow n | G0 before p50 / p95 / p99 / max (ms) | Complete candidate rerun p50 / p95 / p99 / max (ms) | Typing p95 before → rerun (ms) |
| --- | ---: | --- | --- | ---: |
| 1 KiB | 20 | 4.0 / 6.4 / 7.4 / 7.4 | 5.1 / 10.6 / 13.8 / 13.8 | 9.4 → 8.7 |
| 100 KiB | 20 | 50.7 / 55.5 / 56.8 / 56.8 | 7.6 / 9.3 / 13.4 / 13.4 | 55.8 → 57.9 |
| 1 MiB | 20 | 510.6 / 606.9 / 611.7 / 611.7 | 4.4 / 44.2 / 45.0 / 45.0 | 576.6 → 539.0 |

The repeated large-document arrow p95 reduction is substantial: 55.5 → 9.3 ms at 100 KiB and 606.9 → 44.2 ms at 1 MiB. The 1 KiB p95 regressed from 6.4 to 10.6 ms. The 1 MiB phase had 99 vs 96 React commits, 31 vs 30 IndexedDB reads, and 23 vs 22 strict completed writes; these do not show a general reduction in editor or journal work. Long Task p95/max was 606/673 → 525/577 ms in that phase, while largest renderer endpoint RSS was 5.51 → 2.34 GiB. The CPU profile is a whole-page low-sampling profile, process IDs differ, and these changes are not attributed to sentence mapping. Scene-switch p50/p95/p99 was 509.5/2102.0/3276.2 → 493.8/1960.6/2169.0 ms (n=20); checkpoint and publish also passed. Visible idle observed 6 requests over 35 seconds. Headless Chromium did not hide the original page, so hidden idle remains NOT_CHECKED.

The old selection callback calls `doc.toString()` and rebuilds sentence offsets for each selection update. The candidate cache test uses real immutable CodeMirror `Text` and `EditorState` selection-only updates: one document-change materialization and one index build, then **0 additional full materializations and 0 additional index builds across four selection updates**. These counts come from the direct focused test, not production telemetry or the browser arrow cohort. Tests assert Japanese punctuation/dialogue, UTF-16 surrogate, LF/blank-line sentence mapping; the browser restore check confirms the cached mapping returns to the first source offset on all three document sizes. Nonzero scroll restoration was not exercised in the focused run; its existing `scrollTop` read/write path is unchanged. W1 C01 changed-string reuse and C05 external value synchronization remain unchanged.

Verification completed for this measurement checkpoint: `pnpm install --frozen-lockfile`, `SCRIPTORIUM_PROFILE=core pnpm build`, the focused cursor tests (6/6 passed), the instrumented three-document scene/restore repro, and the complete canonical browser rerun. Full workspace typecheck, test, build, audit, and broader required acceptance gates remain pending before source adoption.

Raw captures are retained outside the repository:

- Before report/profile: `/data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/results/browser-small.json` and `.json.cpuprofile`.
- Initial failed candidate report/profile (retained): `/data/scriptorium-core64-g1-c02-eba9a02-20261020-1454/results/browser-small-after.json` and `.json.cpuprofile`.
- Complete canonical candidate rerun/profile: `/data/scriptorium-core64-g1-c02-eba9a02-20261020-1454/results/browser-small-after-rerun.json` and `.json.cpuprofile`.
- Candidate fixture: `/data/scriptorium-core64-g1-c02-eba9a02-20261020-1454/synthetic`.
- Focused scene, cursor, IME, paste and undo report: `/data/scriptorium-core64-g1-c02-focused-20261021-0010/results/focused-scene-restore.json`; its fresh fixture is in the same directory under `synthetic/`.
