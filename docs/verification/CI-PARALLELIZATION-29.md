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

Remote cold/warm measurements and final exact-SHA certification: **PENDING**, to be replaced by actual completed-run evidence. A rerun alone is not proof of a warm cache. Approximately five minutes is a target, not a guarantee.

Initial local checks: frozen install; workflow syntax via actionlint 1.7.12; workflow/matrix and release-policy tests; scoped safety typecheck. Final results and independent review will be recorded with actual SHA/run in PR #30 to avoid a self-referential documentation SHA.

Completed-run collection uses `GH_TOKEN=<read token> GITHUB_REPOSITORY=yohn-jp/scriptorium node scripts/measure-ci.mjs --run <run-id> --out <report.json>` after the run terminates. The in-workflow metrics artifact is explicitly a partial snapshot while certification is still running; it cannot by itself certify final wall-clock. The final delivery record uses the completed-run collection.
