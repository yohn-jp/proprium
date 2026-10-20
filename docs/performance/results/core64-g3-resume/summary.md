# C39/C40 recent-activity comparison

The C39 leaf is adopted. With the same local Git fixture, port, viewport, Chromium 155 binary, 15-second scheduler, and 15.5-second observation windows, native visible polling stayed at 1 GET in both runs. Natural hidden polling fell from 1 GET to 0. Returning to the foreground still triggered an immediate fresh handoff; the candidate then produced one more GET in the following 15.5 seconds. A response deliberately held across hide was applied by baseline and discarded by candidate.

| Observation | Baseline | Candidate |
| --- | ---: | ---: |
| Visible idle GETs in 15.5 s before hide | 1 | 1 |
| Hidden GETs in 15.5 s after Chromium reported `hidden` | 1 | 0 |
| GETs in 15.5 s after returning visible, including focus refresh | 3 | 2 |
| Additional GETs in 15.5 s after the immediate focus refresh | 1 | 1 |
| Delayed response completing after hide | Applied to the UI | Discarded; no stale handoff |

C40 stays unchanged. Fifty identical-position reports in a 97 ms baseline burst and a 112 ms candidate burst each produced 1 PUT. The saved sentence offset stayed the same while `updatedAt` advanced in both runs, so identical reports retain recency meaning. A 50-character burst completed in 464 ms at baseline and 493 ms on candidate, with 1 PUT each; this only characterizes a fast burst inside the two-second debounce. Longer normal typing can autosend before the user finishes.

The C39 tests used an actual headful Chromium process launched from the recorded Nix Chromium 155 executable, attached with Playwright CDP `noDefaults: true`, and operated on the existing default browser context. A second page was opened in that same context and brought to the foreground. The test read the browser's real `document.visibilityState`; it did not set visibility or synthesize events. `DISPLAY=:97` used the recorded Xvfb and Openbox binaries. The native preflight recorded both same-window targets as window `469417178`, with the original page transitioning to `hidden` and then `visible`; the acceptance reports independently record the natural `hidden` state. Per-case window IDs are not serialized in Playwright JSON.

The browser helper uses `SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium`; the actual process executable resolved to `/nix/store/xaaviz84rjj4pm3k6rq1rvz5pja1a77q-chromium-unwrapped-155.0.8059.79/libexec/chromium/chromium`. The captured baseline and candidate root process argv both omit `--headless`. C40 used the ordinary Playwright fixture and does not make a natural-visibility claim.

The reporter command was:

```sh
pnpm exec playwright test --config tests/e2e/playwright.config.ts --project=chromium --workers=1 --reporter=json --grep 'recent activity (polling|ignores a refresh|coalesces)'
```

Both runs set `DISPLAY=:97`, `TMPDIR=/data/scriptorium-core64-g3-tmp`, `SCRIPTORIUM_E2E_NATIVE_VISIBILITY=1`, `SCRIPTORIUM_E2E_BASE_URL=http://127.0.0.1:4573`, `SCRIPTORIUM_E2E_REPOSITORY_BRANCH=main`, `SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY=0`, and `SCRIPTORIUM_E2E_PORT=4573`. They used isolated state directories and auth tokens. The candidate additionally set `SCRIPTORIUM_E2E_EXPECT_C39_PAUSED=1`. The server and test runner were started sequentially for baseline and candidate; no timing benchmark, build, or other worker ran during the metric lease.

The clean baseline poll report passed 1/1. Baseline in-flight and C40 cases passed in `baseline-support-cases.json`; that earlier full reporter run also contains a first-case assertion failure from an interim baseline-only focus assumption and is retained as-is. `baseline-poll.json` is the final baseline polling result after correcting that assumption. The candidate report passed 3/3. An earlier headless visibility attempt marked the in-flight case NOT_CHECKED and is preserved in `original-headless-skip.json`; it is not counted as evidence. The broader typecheck, unit suite, full browser suite, build, and audit remain with the verification batch.

Baseline runtime: source commit `ffd02739ab095dfda2854a3ff487434c84f6b536`; checked-in runtime manifest SHA-256 `f16e9db3d4e99c39985044ef44fa677dde62678be54f0d36f53693bf095a9031`. Candidate production change: commit `020d3d2b`; test follow-up: `e7103f4f40c9700b32b3ebbcc841aa455b792579`. Candidate hook source SHA-256 is `1ca7cc1dc0de5aa88d0fe7cc92294012be5f3aaf36c3ddf67e7a464d8a814435`. The final candidate report used the committed focus assertions and bounded profile-cleanup retry. The only source edit after that report corrected stale `headless` wording in the NOT_CHECKED fallback; no measured assertion or production hook changed.

Machine-readable metrics, runtime hashes, and raw-report SHA-256 values are in [summary.json](summary.json). The raw JSON reports, clean-run stdout logs, original NOT_CHECKED report, and captured process argv are stored beside this file. The earlier baseline stdout that contains the interim assertion failure remains in the task-local result directory; its raw JSON is included here.
