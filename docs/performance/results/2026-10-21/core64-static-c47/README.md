# Core-64 C46/C47 matched static delivery result

Date: 2026-10-21. Matched browser and 1,000-GET candidate source: `d8e32e6006f59fe938d68388bbdbb9cb78f084f8`. Final production source, including the follow-up alias symlink fix: `e27cacdfeb9bc4e4b975f68e4db99735c60e408b`. The matched UI baseline was built from source `1a03807dec4990c7b44af551b4dcbd279c9498e4`; candidate UI outputs were built from C47. Core and Full each include launcher, desktop, and mobile outputs. The probe records every UI manifest and JavaScript/CSS file hash and size in the four raw reports. Before/after API measurement builds used the same workspace dependencies and differed only by the C47 server leaf: baseline server SHA-256 `28ec0901676cf96beb28e20c0b86c211af5119f7bb125aee1f9fc88667de86c3`; measured candidate server SHA-256 `d777f6340700a91bd816f1be909c514e869ebef258b38d04324e8503289579a3`. The final e27 API build has server SHA-256 `a89908021450e9414694591e9657d4452f10890cb725f3be3f721bc124a728ff`.

All samples ran on CPUs 8–11 with Node `v24.21.0`, pnpm `12.10.1`, and the frozen lockfile SHA-256 recorded in each report. Browser samples used the already-installed Nix Chromium `155.0.8059.39`; no browser or package was installed during this run. The current UI outputs are preserved outside the repository at `/data/scriptorium-core64-static-matched-candidate/{core,full}/dist`.

The baseline served fixed `main.js`/`styles.css` URLs under the default `Cache-Control: no-store` security header; it did not give assets immutable caching. The candidate HTML points to content-hashed JS/CSS under `assets/`; those URLs return `Cache-Control: public, max-age=31536000, immutable`, while HTML and fixed aliases remain `no-store`. All six candidate first/repeat pairs retained distinct request-specific CSP/style nonces.

| Profile / route | Baseline `first.totalTransferBytes` | Baseline `repeat.totalTransferBytes` | Candidate `first.totalTransferBytes` | Candidate `repeat.totalTransferBytes` | Net repeat reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core `/` | 753,565 B | 753,565 B | 753,598 B | 1,016 B | 752,549 B |
| Core `/desktop/` | 803,749 B | 803,749 B | 803,782 B | 1,032 B | 802,717 B |
| Core `/mobile/` | 1,735,579 B | 1,735,579 B | 1,735,556 B | 1,030 B | 1,734,549 B |
| Full `/` | 756,414 B | 756,414 B | 756,391 B | 1,016 B | 755,398 B |
| Full `/desktop/` | 806,608 B | 806,608 B | 806,585 B | 1,032 B | 805,576 B |
| Full `/mobile/` | 1,737,294 B | 1,737,294 B | 1,737,215 B | 1,030 B | 1,736,264 B |

Net repeat reduction is baseline `repeat.totalTransferBytes` minus candidate `repeat.totalTransferBytes` for each route. The raw candidate `savedTransferBytes` field is a different measure: candidate entry/style bytes served on its first navigation that were absent from its repeat transfer; it excludes the fresh HTML shell. Across the two navigations for all three routes, browser requests fell from 27 to 21 per profile: the six repeat entry/style requests were served from the browser cache. The remaining repeat transfers are fresh no-store HTML shells.

For 1,000 direct entry GETs, every response was HTTP 200 and returned exact artifact bytes. Baseline counts were 1,000 `lstat`, 2,000 `realpath`, and 1,000 `readFile` calls. Candidate counts were 2,000 `lstat`, 2,000 `realpath`, and 1,000 `readFile` calls. The added `lstat` checks the `assets/` directory symlink on every hashed asset request; path and symlink checks remain per request. Read bytes were unchanged for each profile. The e27 follow-up changes only manifest-resolved fixed-alias safety: aliases targeting `assets/` now receive that same directory symlink check. It does not change direct hashed-URL bytes, cache behavior, or their measured syscall counts. Alias-request syscall counts were not part of the 1,000 direct-asset loop. TTFB was similar: Core p50 `3.045` → `3.056` ms and Full p50 `2.785` → `2.857` ms. These timing values are observational because other CPU lanes were active and do not support a latency-gain claim.

The raw Core and Full samples are [before-core.json](./before-core.json), [after-core.json](./after-core.json), [before-full.json](./before-full.json), and [after-full.json](./after-full.json). Chromium `155.0.8059.39` was used for both matched samples. No C59 payload or C60 CSS split is included.

The follow-up regression confirms that fixed JS and CSS aliases reject a manifest target beneath an internal symlinked `assets/` directory. It passes both in the [focused API test log](./gates-e27/static-symlink-focused.log) and the full suite. An initial full test attempt at d8 was interrupted with status 130 after the safety gap was found; its partial output is preserved separately and is not counted as a gate result.

All required canonical gates passed on final source `e27cacdfeb9bc4e4b975f68e4db99735c60e408b`: frozen install, typecheck, full test, `SCRIPTORIUM_PROFILE=core pnpm build`, and `pnpm audit:core` (128 production dependency versions scanned). Raw command logs are under [gates-e27](./gates-e27/). Final combined Full, browser, and OCI acceptance remains with the coordinator.
