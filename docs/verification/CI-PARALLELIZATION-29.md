# Issue #29 parallel verification

Authority: Issue #29 and the owner's 2026-10-23 CI parallelization instruction. Reference source: `4ad50373416e11daac83d775358583ee59bfb466`. Implementation remains in PR #30; verification never publishes, deploys, merges, or changes branch protection.

## Execution and coverage

`scripts/ci-contract.mjs` is the canonical inventory. `scripts/ci-contract.test.mjs` parses the actual workflow and verifies exact matrix expansion, independent leaves, failure behavior, source checkout and pinned browser runtime. No runner concurrency limit is configured; matrix fail-fast is disabled and updates do not cancel earlier runs.

| Required checks | Count | Coverage |
| --- | ---: | --- |
| `unit-*` | 16 | Five packages, app, nine modules, all root script tests; actual package test commands |
| `typecheck-*` | 5 | Foundations, Core/API, app, two module groups; existing production contracts |
| `test-types-*` | 3 | app/E2E, packages, modules; production and test sources together |
| `safety` | 1 | Existing stricter scoped compiler checks |
| `build-core`, `build-full`, `audit-core` | 3 | Separate production builds and Core runtime audit |
| `oci-core`, `oci-full` | 2 | Existing Dockerfile, HTTP readiness, UID, writable state and shutdown checks |
| `browser-{core,full}-*` | 14 | Six Chromium spec files and WebKit UI per profile, workers=1 |
| `hosted-native-*` | 4 | Catalog/Runtime Base/BuildKit and independent Core/selected/all-module actual offline composition |
| `coverage` | 1 | Workspace/test-source/browser/workflow inventory completeness |
| `certification` | 1 | All 49 leaves required successful at exact source SHA |

Each runner owns its checkout, builds, ephemeral Git repositories, API process, data and browser state. Browser ports may have the same numeric value on separate runner hosts; no shared listener or state exists. No `fullyParallel` change was made. Profile-conditional and browser/display-conditional existing skips remain visible per test in browser coverage artifacts. Empty or incomplete shards fail.

Package runners build their declared internal dependency closure on their own host. The coverage validator rejects unregistered workspaces/test sources; root `pnpm test` includes the same root script test discovery as `unit-root`. Production/test-source grouping is an execution partition, not a compiler relaxation.

Hosted Native jobs independently build digest-bound disposable Producer inputs at HEAD. Catalog-only host preparation builds module-runtime and all module dependency closures; compose jobs also build the required app/API production outputs. Catalog reports bind source/recipe/lock digests and actual runtime-base/BuildKit OCI digests. Compose keeps online cache preparation followed by the original offline Producer operation. Source inventory, clean checkout, symlink, provenance and signature checks remain enabled. These checks do not certify a deployed Hosted runtime or publish a signed Producer.

## Browser environment

Official `mcr.microsoft.com/playwright:v1.64.1-noble` resolved to OCI index `sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea`, with pinned Linux amd64 manifest `sha256:d65108d1a8095d8b0c4a5e32bf1807a40a5ce90ff0c78473e1116b1c243235e8`. Each browser job checks Noble, Node 24, pnpm 12.10.1 and Playwright 1.64.1, launches Chromium and WebKit and renders a real page before the build/E2E steps. There is no APT or dynamic browser installation in this path. Container retrieval remains an external dependency; failure is an environment failure, never synthetic test success.

## Certification and release

Only certification depends on every verification group. It rejects failed/cancelled/skipped/unexecuted groups and checks the exact successful leaf names and source SHAs through paginated GitHub jobs evidence. Release additionally requires the completed successful certification, an exact-SHA successful main push run and unchanged version tag. Every page of both run and job results is inspected. Missing/extra/duplicate jobs and uncertain/incomplete responses fail closed. Existing OCI version tags remain immutable.

The main branch protection endpoint returned `404 Branch not protected` and repository rulesets returned an empty list during preflight. No protection settings were changed.

## Timing and results

Baseline: [run 39940436971](https://github.com/yohn-jp/scriptorium/actions/runs/39940436971), source `4ad50373416e11daac83d775358583ee59bfb466`.

| Baseline job | Seconds | Result |
| --- | ---: | --- |
| source-checks | 214 | PASS |
| hosted-native | 240 | PASS |
| oci-core | 50 | PASS |
| oci-full | 85 | PASS |
| browser-full | 324 | PASS |
| browser-core | 1819 | CANCELLED before E2E, during APT download |

`scripts/measure-ci.mjs` records queue wait, runner setup, explicit install/build/test step durations, cache hit evidence, result, last-leaf critical path and completed-run wall-clock. Combined baseline phases and download-only time not exposed by the API remain explicitly unseparated/NOT_CHECKED. Container pull appears in runner initialization; dependency network retrieval appears within dependency installation. Cache hit is recorded in an API-visible step name. Cache keys bind OS, Node major, exact pnpm and lockfile; every runner still performs frozen install and its own builds.

Verified implementation source: `af72d8ecb4c2fc2b4c065cf735c5623040d0a317`. Both full attempts of [run 39955477245](https://github.com/yohn-jp/scriptorium/actions/runs/39955477245) succeeded: **all 50 jobs PASS**, including certification, on that same SHA.

| Scenario | Attempt | Wall-clock | Explicit pnpm cache | Result / critical path |
| --- | ---: | ---: | --- | --- |
| Original baseline | 1 | 1857 s (30m57s) | No explicit dependency cache | CANCELLED; browser-core APT |
| Verified warm | [1](https://github.com/yohn-jp/scriptorium/actions/runs/39955477245/attempts/1) | 322 s (5m22s) | 47 hit, 0 miss | 50/50 PASS; hosted-native-selected → certification |
| Verified cold-start | [2](https://github.com/yohn-jp/scriptorium/actions/runs/39955477245/attempts/2) | 284 s (4m44s) | 25 hit, 22 miss | 50/50 PASS; hosted-native-core → certification |

For the cold-start attempt, only the two cache entries created by this task for `refs/pull/30/merge` were removed; the API then confirmed the cache list was empty. All 50 jobs were rerun with unchanged source and validation commands. The first wave downloaded dependencies; later jobs could reuse caches saved earlier in that same run. This is a cold-start workflow measurement, not a claim that every job remained uncached. Warm/cold differences include runner queueing and network variance; these two samples do not establish a causal cache speedup or a guaranteed five-minute bound. Maximum per-job queue wait was 116 s warm and 137 s cold-start. GitHub scheduled up to approximately 20 jobs concurrently during observation; the workflow imposes no cap.

[Machine-readable per-job measurements and evidence](CI-PARALLELIZATION-29-METRICS.json) contain all 106 baseline/warm/cold job records, queue/setup/install/build/verification/download-related step durations, cache outcomes, all browser test titles/outcomes and the eight actual Native reports with source/recipe/lock/OCI digests. Null phase values mean the API did not separately expose that phase, not zero duration. OCI combines build/runtime checking; Native verification includes Docker builds/compose; download-related step timings include other work and overlap setup/install. They are not download-only stopwatches.

## Actual test coverage and review

| Browser profile / project or shard | Expected | PASS | Existing skip | FAIL |
| --- | ---: | ---: | ---: | ---: |
| Core / Chromium core | 18 | 16 | 2 | 0 |
| Core / Chromium job-inbox | 1 | 1 | 0 | 0 |
| Core / Chromium modular-workspace | 13 | 12 | 1 | 0 |
| Core / Chromium recent-activity | 4 | 2 | 2 | 0 |
| Core / Chromium review-contributions | 1 | 0 | 1 | 0 |
| Core / Chromium ui-v1 | 3 | 3 | 0 | 0 |
| Core / WebKit ui-v1 | 3 | 2 | 1 | 0 |
| Full / Chromium core | 18 | 18 | 0 | 0 |
| Full / Chromium job-inbox | 1 | 1 | 0 | 0 |
| Full / Chromium modular-workspace | 13 | 12 | 1 | 0 |
| Full / Chromium recent-activity | 4 | 2 | 2 | 0 |
| Full / Chromium review-contributions | 1 | 1 | 0 | 0 |
| Full / Chromium ui-v1 | 3 | 3 | 0 | 0 |
| Full / WebKit ui-v1 | 3 | 2 | 1 | 0 |

Both warm and cold-start attempts produced the same counts: Core 36 PASS / 7 existing skips; Full 39 PASS / 4 existing skips. Every shard discovered at least one test. The Core review-contributions test remains explicitly profile-skipped; it is recorded as zero test assertions passed, not as an executed contribution test. Existing host-only lifecycle acceptance (`core64-lifecycle.host.acceptance.spec.ts`) stays outside this browser suite; all its sources are still typechecked. No test was removed or newly skipped.

The root scripts target now also runs pre-existing root test files omitted by the former explicit five-file root list. New workspace/test/browser registration omissions fail coverage checks, including test sources outside `src`. Final local `pnpm test`: **495 tests, 493 PASS / 2 existing conditional skips / 0 FAIL**. The extra conditional skip comes from a pre-existing root browser-probe test newly included by full root coverage; no skip directive was added. Test-source typechecking covers 67 test/spec files (app/E2E 22, packages 12, modules 33); unit inventory covers 74 test/spec files including root JavaScript tests. Production typechecks, scoped safety, frozen install, Core/Full builds, Core audit, real OCI and actual Native checks all passed in both complete remote attempts.

Trace-backed E2E corrections preserve all behavior assertions. Project reloads now branch from the completed, validated project-list response and await the target project's DOM; lifecycle registration waits for that exact project to become current before selecting its scene. The previously failing cases passed three local repeats and their complete Core/Full files. Independent read-only reviews found no remaining major code findings after these corrections. All publishing, provenance, approval and recovery assertions remain.

## Issue #29 acceptance mapping

| Acceptance | Required checks / evidence |
| --- | --- |
| 1. Exact source/release safety | All 50 jobs; unit-root release negative cases; exact main/push/SHA + complete matrix + certification; immutable tag denial |
| 2. Hosted 502/503 and fail-closed auth | unit-api / unit-core HTTP boundary regressions |
| 3. Runtime browser DTO validation | unit-app; Core/Full browser matrix; existing malformed/empty/persisted-operation/receipt regressions |
| 4. Actual SDK MCP session boundaries | unit-mcp capacity, concurrent/abandoned initialization, active stream, expiry, cancellation/disposal and isolation |
| 5. Production/test/safety typing | typecheck-* / test-types-* / safety; full scope and omitted-test negative coverage |
| 6. Native input and module integrity | hosted-native-catalog/core/selected/full; unit-root source/symlink/clean/provenance/signature tests; eight actual digest-bound reports |
| 7. Scoped extraction | Existing API/browser/MCP/release modules and tests retained; no Core/app architecture rewrite |

For the final submitted documentation/collector revision, exact-HEAD CI and review status, use the final verification section of PR #30. The SHA above identifies the executed implementation benchmark, not this document's containing commit. Required checks are rerun after the final documentation/collector commit.

Remaining NOT_CHECKED boundaries: live production Hosted/Platform replacement, public signed Producer/Release/OCI publication, optional model and natural headful-background prerequisites, and download-only phase attribution not exposed separately by the Actions API. These are distinct from the executed native/OCI/browser checks; publication/deployment remains prohibited for this task.

Local checks: frozen install; workflow syntax via actionlint 1.7.12; workflow/matrix and release-policy tests; scoped safety typecheck.

Completed-run collection uses `GH_TOKEN=<read token> GITHUB_REPOSITORY=yohn-jp/scriptorium node scripts/measure-ci.mjs --run <run-id> --attempt <attempt> --out <report.json>` after the run terminates. The in-workflow metrics artifact is explicitly a partial snapshot while certification is still running; it cannot by itself certify final wall-clock. The final delivery record uses the completed-run collection.
