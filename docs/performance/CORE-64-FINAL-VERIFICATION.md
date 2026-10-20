# Core 64 final validation

Final Core/Full validation passed on production source `8966fc329a7628d3cf6b4aac84e6b678afc2d157` (tree `9a28184bffa5e4bc005ea860f011eae6c5680ed9`). The only tracked change after that source pin is the test-only update to `tests/e2e/ui-v1.acceptance.spec.ts`, committed in `9fbb5904fbe38142e88d5a439d8c2fefb7ff0a48` and tightened for same-origin eight-character Vite hashes in `3fe99c758ba88a185dc02bc5edaaa738f183b8a5`. The tested head is `3fe99c758ba88a185dc02bc5edaaa738f183b8a5`, tree `97e806040f8e6eb7aa8b9e5f5736c557a50ec987`. Production bytes, dependencies, manifests, and packaging remain identical to the pinned source.

The corrected UI-v1 assertions check that Desktop and Mobile load same-origin `/{shell}/assets/index-XXXXXXXX.js` and `/{shell}/assets/styles-XXXXXXXX.css` entries. The initial Core Chromium run exposed an obsolete assertion for `/mobile/main.js`; the built page correctly loaded `/mobile/assets/index-DIdvRkwO.js`. Its trace and error context are retained. The focused corrected scenario passed, followed by the single authorized full Core Chromium retry. No production code was changed.

The frozen install verified 453 supply-chain entries and left the lockfile unchanged (SHA-256 `107821c3fdeb50571c891e7de500c0b477bc01206c1f4caa63d830fd8be7e768`). `pnpm typecheck` passed. `pnpm test` passed with 431 passed, 0 failed, and 1 opt-in Semantic real-CPU/cache test skipped (432 total). The Core build passed with zero selected modules, and `pnpm audit:core` passed after it with 128 production dependency versions scanned. The Full build passed with nine selected modules. Vite emitted its existing large-chunk warnings; all builds exited successfully.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --store-dir=/data/.pnpm-store --reporter=append-only` | PASS; 453 supply-chain entries, lockfile unchanged |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 431 passed, 1 skipped, 0 failed |
| `SCRIPTORIUM_PROFILE=core pnpm build` | PASS |
| `SCRIPTORIUM_PROFILE=core pnpm audit:core` | PASS; 128 production dependency versions |
| `SCRIPTORIUM_PROFILE=full pnpm build` | PASS; nine selected modules |

Browser commands used `pnpm exec playwright test --config tests/e2e/playwright.config.ts` with the `chromium` or `webkit` project, isolated state directories and output traces under `/data/scriptorium-core64-final-validation-final/`. Chromium used the pinned executable at `/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium`; WebKit ran through `/data/scriptorium-ui-tools/with-webkit-runtime`. The JSON manifest records each exact command, port, state/output path, result, and log hash.

| Browser acceptance | Result |
| --- | --- |
| Core Chromium initial diagnostic | 29 passed, 6 skipped, 1 obsolete asset-path assertion failed; retained as a diagnostic, not a pass |
| Corrected UI-v1 scenario on Core Chromium | 1 passed |
| Core Chromium final retry | 30 passed, 6 skipped, 0 failed |
| Core WebKit UI-v1 | 2 passed, 1 skipped, 0 failed |
| Full Chromium | 33 passed, 3 skipped, 0 failed |
| Full WebKit UI-v1 | 2 passed, 1 skipped, 0 failed |

Core Chromium skips were the four Full-only cases (publishing contribution cancellation, public publishing reader, Full search/terminology, and Story/Speaker review contributions) plus two C39 natural-visibility cases. The C39 cases remain `NOT_CHECKED`: this run did not configure native headful visibility. Full Chromium skipped the Core-only workspace case and those same two C39 cases. Each WebKit run skipped the workspace contribution catalog case, which is explicitly Chromium-only. The configured Playwright file excludes `core64-lifecycle.host.acceptance.spec.ts`; no separate C55 host-9 run or OCI build was duplicated here because this leaf changed only a browser-test assertion and those acceptance checks are owned by the separate G5 validation.

The log and trace hashes, complete browser skip names, exact commands, source and lock pins, browser/tool versions, production-source comparison, and current post-Full-build artifact hashes are in [the JSON manifest](results/core64-final-verification/manifest.json) and [the log/trace SHA-256 list](results/core64-final-verification/LOGS-AND-TRACES.sha256). Raw logs and the retained initial-failure trace are under `/data/scriptorium-core64-final-validation-final/`. The manifest covers the current Full `app/dist`, package `dist` outputs, and both generated Core/Full profile manifests; it contains 142 file hashes. The current `app/dist` tree reflects the Full build, while the successful Core build output is preserved in its log.

The checks ran locally with Chromium 155.0.8059.79 and WebKit 27.2 / Playwright revision 2370. No CI workflow, hosted repository, image registry, or production service was modified.
