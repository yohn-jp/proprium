# Issue #29 audit hardening evidence

Authority: [Issue #29](https://github.com/yohn-jp/scriptorium/issues/29), [PR #30](https://github.com/yohn-jp/scriptorium/pull/30), and [the accepted implementation plan](../superpowers/plans/2026-10-23-audit-hardening.md). Base: `7f698cb943e672c90ec3c60a484124e12fad5ac0`. The original nine commits through `698774a22a13751430e5193de955b83ce9c4c892` are retained. Implementation revision for the final verification series: `2cdf1c8c0ce88ae2e983232040cc2c07a5c4990e`.

The PR records the final submitted HEAD and its exact GitHub Actions run, including documentation-only successors of this implementation revision. A previous run or a local result is not certification of a later runtime tree.

## Acceptance matrix

| Issue #29 condition | Implementation | Executable evidence |
| --- | --- | --- |
| 1. Verify PR/main and gate publication on exact source | `verify.yml`, `publish-oci.yml`, `verify-release-source.mjs`, `release-policy.mjs`, `verify-unpublished-image.mjs` | Source job runs frozen install, three typechecks, tests, Core/Full builds and Core audit. Separate real OCI, native and browser jobs are mandatory for an exact-SHA main push. Release-policy tests reject wrong SHA/event/branch/status, incomplete jobs, moved tag identity, existing images and uncertain registry results. Release creation follows both verified images; existing Releases remain unchanged. |
| 2. Preserve authorization dependency outages | `packages/api/src/authorization-error.ts`, both read/write hooks in `server.ts` | `authorization-error.test.ts` and actual HTTP tests in `server.test.ts`: read/write × 502/503 retain status, omit authentication challenges and redact provider details. Existing invalid-token and permission-denial HTTP regressions retain fail-closed 401/403 behavior. |
| 3. Reject malformed successful browser responses | `app/src/api-response.ts`, `api-error.ts`, `api.ts` | `api-boundary.test.ts`: invalid/empty JSON, partial version/session DTOs, operation receipts and required action/job payloads rejected; legitimate optional fields/null payloads and no-content endpoints accepted. `api.test.ts` retains the rotating-refresh single-flight and pinned scene/snapshot contracts. |
| 4. Bound/expire MCP sessions using the SDK | `modules/mcp/src/http.ts`, `session-lifetime.ts`, shutdown in `index.ts` | Actual SDK tests in `http.test.ts`: concurrent initialization capacity, abandoned initialized sessions, idle expiry, disposal, cross-project denial and cancellation. An actual SDK GET event stream holds capacity beyond idle expiry, rejects another initialization, then releases on cancel and expires with no retained timer/session. `session-lifetime.test.ts` tests timer and stream edges. |
| 5. Typecheck tests and tighten changed boundaries | `typecheck-tests.mjs`, `tsconfig.safety.json`, scoped test declarations/mocks | `pnpm typecheck:tests` compiles production and tests together, including 67 test/spec files and E2E fixtures. `typecheck:safety` enables indexed/optional/return/fallthrough checks and checked JavaScript for the changed policy modules. Root E2E workspace dependencies are declared. No production contract relaxation, `any` escape, exclusion or new skip was added. |
| 6. Protect actual native Hosted inputs/outputs | Existing `hosted-build.mjs` validation; `verify-hosted-native.mjs`; buildkit cache preparation | Real catalog and compose checks build disposable digest-bound OCI inputs from a clean checkout. Native host cache preparation matches the buildkit's existing online deploy-cache priming; actual composition remains offline. Verify empty Core, `story,mcp,search`, and all nine shipped modules; inspect catalog, artifact report and composition manifest. Existing symlink, clean-source, signature and SLSA tests remain enabled. |
| 7. Extract only changed boundary logic | `authorization-error.ts`, `api-response.ts`, `api-error.ts`, `session-lifetime.ts`, `release-policy.mjs` | Focused boundary suites and existing Core/API/application regressions. Git, checkpoint, publication, IndexedDB ownership and MCP author-approval authority remain with their existing implementations. No Core/SharedApplication redesign. |

## Regressions and browser corrections

The baseline fixture is an isolated `git archive` of the base revision, with the new regression tests copied into it and dependency resolution shared from the task checkout. No implementation or main branch was overwritten. Browser API tests fail on all six malformed-response cases before the correction; Hosted HTTP outage tests fail in all four read/write cases; MCP capacity/idle tests fail in both cases. The corresponding corrected tests pass. OCI immutability and required-payload regressions were also run failing before and passing after their fixes.

Initial CI [39900127647](https://github.com/yohn-jp/scriptorium/actions/runs/39900127647), at `698774a22a13751430e5193de955b83ce9c4c892`, failed test-source types, native offline metadata, and nine browser cases per profile. Core/Full OCI already passed.

Real DOM/interaction diagnosis identified:

- Foreground observation retained an unknown or older remote-status message. Refresh only remote-observation messages while preserving unrelated save confirmations/errors.
- The move-menu's stacking context intercepted clicks in the panel list. Give the layout toolbar its own higher stacking context.
- Studio's higher-specificity two-column rule overrode the existing narrow-screen one-column rule; preview intercepted scratch-panel actions at 390px. Restore the existing responsive breakpoint. The complete writing/recovery/checkpoint/publication browser case failed before and passed after.
- A coalesced proposal poll wrote current server status to IndexedDB but did not refresh React after same-project reactivation changed navigation. Extend the existing recovery test with a gated actual proposal request and second actual project selection. The exact stale-warning assertion fails before and passes after refreshing coalesced callers under their own current-navigation guard.
- Scope duplicate-alert assertions to the actual connection-status surface. Select the Editor tab after docking activates Outline. Wait for keyboard resizing to change measured width. Assert the existing IME failure's actual alert role. Compare undo with the exact pre-edit manuscript, since the preceding browser may have published a new fixture revision. All text, recovery, conflict, approval and publication assertions remain; no failure was removed or skipped.

At `ddd68ad8916516bb3be6401524e0ccd328ddc003`, [CI 39937325479](https://github.com/yohn-jp/scriptorium/actions/runs/39937325479) proved native catalog/compose for all three selections, with disposable runtime-base `sha256:d93e8996d2b14e4c36289b0d6c2fd050428b0f067d18c79402d2e942225265dc` and buildkit `sha256:310b5645b420f69d5b568c7bc104337f56bc474b297cd487d5819295348c0d66`. Source and both OCI jobs also passed. That run was superseded after further browser fixes; it is intermediate evidence, not final certification.

## Original audit verification series

Local toolchain: Node `24.21.0`, pnpm `12.10.1`; task worktree `/data/scriptorium-29-audit-hardening`. The final integrated command series completed on runtime revision `2cdf1c8c0ce88ae2e983232040cc2c07a5c4990e` (subsequent changes strengthen E2E synchronization/DOM comparison and documentation only):

| Command | Actual local result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS with the submitted lockfile; no package-version changes after the test workspace dependencies were declared |
| `pnpm typecheck` | PASS |
| `pnpm typecheck:tests` | PASS, 67 test/spec files included |
| `pnpm typecheck:safety` | PASS, including the new checked-JavaScript registry gate |
| `pnpm test` | PASS: 459 tests, 458 passed, 1 existing conditional semantic-model skip, 0 failures |
| `pnpm build` | PASS, Core production build |
| `pnpm audit:core` | PASS, 128 production dependency versions inspected |
| `SCRIPTORIUM_PROFILE=full pnpm build` | PASS |
| `node --test scripts/release-policy.test.mjs` | PASS, four release/registry policy regressions (also included by `pnpm test`) |
| Core Chromium, production browser suite | 34 passed / 6 existing conditional skips / 0 failures, after the responsive correction |
| Full Chromium, production browser suite | 37 passed / 3 existing conditional skips / 0 failures, after the responsive correction |
| Strengthened coalesced proposal recovery regression, Full Chromium | Failed before production correction; passed after; repeated twice with activation-completion synchronization: 2 passed |
| Undo/redo and cross-Shell recovery/publication flow, Full Chromium | Exact pre-edit CodeMirror line comparison; two consecutive runs against the same disposable remote: 2 passed |

Browser commands use `pnpm exec playwright test --config tests/e2e/playwright.config.ts --project chromium`, with `SCRIPTORIUM_PROFILE=full` after the Full build. On NixOS, `SCRIPTORIUM_E2E_CHROMIUM` selects the actual system Chromium 153 executable; `TMPDIR` locates disposable fixtures on the data disk. These options do not mock application behavior. The original GitHub runs installed Playwright browser dependencies at runtime. The subsequent [parallel CI verification](CI-PARALLELIZATION-29.md) replaces that browser environment with the digest-pinned official image and preserves both projects against Core/Full builds. Final exact-HEAD CI, including WebKit, real OCI startup and the native checks, is linked with its SHA and job results in PR #30.

Task-local logs are under `/data/scriptorium-29-scratch`: `typecheck-final.log`, `typecheck-tests-integrated.log`, `typecheck-safety-final.log`, `test-integrated.log`, `build-core-final.log`, `audit-core-final.log`, `build-full-final.log`, `browser-core-final.log`, `browser-full.log`, `proposal-coalescing-before.log`, `proposal-coalescing-final.log`, and `browser-undo-lines-final.log`. Required checks are also repeated remotely on the submitted HEAD; local results are supporting evidence, not a substitute for those jobs.

## Independent review

A separate read-only reviewer examined the whole base-to-HEAD branch and then the corrective commits. Accepted findings were the missing OCI tag-overwrite guard, missing actual-SDK active-stream integration coverage, mandatory action/job payload guard gaps, and the coalesced proposal status race. Each was addressed with executable regressions. Final review status and exact reviewed SHA are recorded in PR #30.

## NOT_CHECKED and execution boundary

- Production Hosted deployment/Platform replacement and signed public Producer publication were not performed. Native acceptance uses disposable local OCI inputs; it does not claim a deployed Hosted runtime or public attestation. Existing signature/provenance checks were retained.
- No Release/image/tag publication, main write, merge, Issue closure, secret mutation or branch-protection change was performed. Existing `v0.3.2` is retained. Actual publication is deliberately not tested by publishing a version.
- Existing conditional semantic-model tests and natural headful-background visibility checks remain conditional. Missing model configuration or a headful display is NOT_CHECKED, never a passing model/background test. Profile/browser-specific skips are recorded in the CI counts; no new skips were introduced.
- A read-only GHCR probe confirmed an absent `core:v0.3.2` at that repository path. It does not prove rejection of a live existing image tag. Existing-tag/error behavior is covered by the response-policy regressions. Package listing returned 403 because the local token lacks `read:packages`; no scopes were changed. This listing is not required for the disposable verification jobs.
- Administrator-controlled manual tag/Release/registry operations are outside repository-workflow enforcement, as explained in [OCI release policy](OCI-RELEASE.md).

## Parallel CI continuation

The owner subsequently authorized the 50-job parallel CI structure. See [CI parallelization evidence](CI-PARALLELIZATION-29.md) for the current job inventory, complete test coverage checks, exact-source certification, cold/warm observations and final verification record. The original audit results above remain historical supporting evidence; PR #30 identifies the final submitted source SHA and completed CI result.
