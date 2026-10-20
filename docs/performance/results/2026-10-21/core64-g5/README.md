# Core 64 G5 static asset closure

Date: 2026-10-21. Source baseline: `9f801061d1cc40c4719988b5e1aef17d3ff60e74` (main after C02/C21). This records static C59/C60 comparisons and C59's bounded first-paint measurements; it is not full browser or runtime acceptance.

The launcher candidate is commit `85504858418463354f9f54e4a3cd132aed80d0fd` (C59). The isolated CSS experiment is `7bb2fb8a2df5bc1aacd5983feee3a4a13088da53` (C60); it was reverted on this branch by `e3d6bc3a`. The branch retains C59 only.

## Build binding and method

The three source snapshots were built separately from the exact SHAs above. Node was `v24.21.0`, pnpm `12.10.1`, and Vite `6.4.4`; the frozen lockfile SHA-256 was `107821c3fdeb50571c891e7de500c0b477bc01206c1f4caa63d830fd8be7e768`. Dependencies and generated module packages came from G0 worktree `80ab121ad08b2c5f5957e3405eed511762fb1747`. A read-only source comparison found no changes from G0 in `package.json`, `app/package.json`, contracts/runtime packages, modules, profile files, or `scripts/profile-build.mjs` for these artifact inputs.

For every source and profile, `node scripts/profile-build.mjs --profile core|full` generated the selected profile; app TypeScript checking passed with `tsc --noEmit -p tsconfig.json`. The three Vite entries were then built from the app directory: default launcher, `SCRIPTORIUM_UI=desktop`, and `SCRIPTORIUM_UI=mobile`, using the G0 Vite executable. All 18 Vite builds and all six app typechecks exited 0. `pnpm --filter @scriptorium/app run build` could not use the symlinked G0 virtual store (`ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`), so the equivalent profile generation, TypeScript, and three Vite script steps were run directly. This was not a root `pnpm build`, test, browser, or OCI acceptance run.

The static closure probe walks each Vite manifest's transitive static imports and CSS, includes `index.html`, and separately measures the recursive union rooted at immediate dynamic imports after removing files already in the static closure. It measures each emitted file's raw bytes, SHA-256, and independently compressed gzip level-9 bytes; rows below sum JS and CSS only. The archived JSON includes HTML and per-file details. These are deterministic artifact sizes, not HTTP transfer measurements.

## Launcher closure

| Source | Profile | Initial JS raw / gzip-9 | Initial CSS raw / gzip-9 | Dynamic App JS raw / gzip-9 | Dynamic App CSS raw / gzip-9 |
| --- | --- | ---: | ---: | ---: | ---: |
| Baseline `9f801061` | Core | 723,541 / 228,224 | 28,230 / 6,308 | — | — |
| C59 `85504858` | Core | 227,391 / 70,839 | 28,230 / 6,287 | 494,823 / 157,606 | — |
| C60 `7bb2fb8a` | Core | 227,528 / 70,930 | 21,664 / 5,196 | 494,823 / 157,606 | 6,567 / 1,631 |
| Baseline `9f801061` | Full | 726,390 / 228,904 | 28,230 / 6,308 | — | — |
| C59 `85504858` | Full | 227,407 / 70,847 | 28,230 / 6,287 | 496,654 / 157,922 | — |
| C60 `7bb2fb8a` | Full | 227,544 / 70,939 | 21,664 / 5,196 | 496,671 / 157,931 | 6,567 / 1,631 |

C59 removes `496,150` raw / `157,385` gzip-9 JavaScript bytes from the Core launcher's initial closure and `498,983` / `158,057` from Full. Its lazy reader chunk is loaded on the `/r/*` path. The initial CSS remains the same 28,230 raw bytes; its compressed representation differs by 21 bytes in these builds. C59 changes only the launcher source; desktop and mobile entry JS/CSS bytes and hashes are unchanged from baseline in both profiles.

C60 reduces initial CSS by 6,566 raw / 1,091 gzip-9 bytes but increases initial JS by 137 raw / 91 gzip-9 bytes in Core and 137 / 92 in Full. It emits a separate `styles2.css` and records that CSS under the dynamic `src/App.tsx` manifest entry.

## Desktop and mobile closures

These byte totals are identical across baseline, C59, and C60 for the corresponding profile. Dynamic totals are additional recursive dynamic-import closure bytes, excluding the static closure.

| Profile / UI | Initial JS raw / gzip-9 | Initial CSS raw / gzip-9 | Dynamic JS raw / gzip-9 | Dynamic CSS raw / gzip-9 |
| --- | ---: | ---: | ---: | ---: |
| Core / desktop | 753,694 / 238,686 | 48,242 / 9,365 | — | — |
| Core / mobile | 1,668,408 / 433,548 | 65,359 / 13,191 | 20,122 / 7,911 | — |
| Full / desktop | 756,553 / 239,408 | 48,242 / 9,365 | 150,325 / 49,450 | — |
| Full / mobile | 1,670,123 / 433,847 | 65,359 / 13,191 | 170,447 / 57,361 | — |

Exact manifest, entry, CSS, and dynamic App asset hashes and per-file sizes are archived in [`artifact-hashes.json`](./artifact-hashes.json). The complete per-profile static and dynamic closure reports are [`baseline-core-assets.json`](./baseline-core-assets.json), [`baseline-full-assets.json`](./baseline-full-assets.json), [`c59-core-assets.json`](./c59-core-assets.json), [`c59-full-assets.json`](./c59-full-assets.json), [`c60-core-assets.json`](./c60-core-assets.json), and [`c60-full-assets.json`](./c60-full-assets.json). The probes used to reproduce these records are [`core64-g5-asset-closure.mjs`](../../../../../scripts/performance/core64-g5-asset-closure.mjs) and [`core64-g5-artifact-hashes.mjs`](../../../../../scripts/performance/core64-g5-artifact-hashes.mjs).

## Basic verification and Full artifact handoff

Before the frozen install, `pnpm typecheck` passed, and `pnpm test` exited 0: 421 tests passed, one optional Semantic CPU test skipped, and none failed. `SCRIPTORIUM_PROFILE=core pnpm build` passed, followed by `pnpm audit:core` (128 production dependency versions scanned). Vite emitted its existing >500 kB warnings for desktop and mobile entries; those builds completed successfully.

After those gates, the worktree ran `pnpm install --offline --frozen-lockfile` with Node `v24.21.0` and pnpm `12.10.1`. It exited 0: pnpm reported all 18 workspace projects, an up-to-date lockfile with the resolution step skipped, and completion in 58 ms. The lockfile SHA-256 before and after remained `107821c3fdeb50571c891e7de500c0b477bc01206c1f4caa63d830fd8be7e768`. Before installation, `node_modules/.pnpm` was a real directory and checked workspace links pointed into this G5 worktree. After installation, pnpm listed all 18 package names, versions, and resolved worktree paths; the 117 direct dependency identities and paths, ten root workspace links, and all 947 node_modules symlinks are recorded in [`pnpm-install-provenance.json`](./pnpm-install-provenance.json), [`pnpm-workspaces.json`](./pnpm-workspaces.json), and [`pnpm-resolved-packages.json`](./pnpm-resolved-packages.json). No symlink resolves into G0. The install log is [`pnpm-install-frozen.log`](./pnpm-install-frozen.log).

The existing 639-file Full artifact manifest was checked after installation: all 639 hashes and sizes matched, with zero mismatches. The install reported no lockfile resolution, and it left the source and Full handoff artifacts unchanged, so the earlier typecheck, test, Core build/audit, and Full build results remain recorded as pre-install executions; they were not rerun. This order is explicit in the evidence and does not replace the pending browser acceptance.

The required full-profile command `SCRIPTORIUM_PROFILE=full pnpm build` also exited 0 on source commit `e3d6bc3af249a1483016ec7fcfe4f0ffb4ec8aa2`, tree `b994c86b1a3b4b25e1f44a9a11e6a22929cde192`. That tree is exactly the C59 candidate tree from `85504858418463354f9f54e4a3cd132aed80d0fd`; the intermediate C60 change was reverted before the build. The build generated the nine-module Full profile and left these immutable handoff outputs in the worktree:

- `app/dist`
- `packages/api/dist`
- `profiles/full/generated`

[`c59-full-build-artifacts.json`](./c59-full-build-artifacts.json) records the command, source binding, three Vite manifest SHA-256 values, and SHA-256/size for 639 files: the app and API outputs above, contracts/Core/migration/module-runtime package outputs, all nine enabled Full module outputs, and the generated Full profile. The primary app/API/profile outputs also have a data-area mirror at `/data/scriptorium-core64-worktrees/g5/handoff/c59-full`; all compiled dependencies remain available in the worktree paths listed in the checksum manifest.

The full build's non-manifest app files are byte-for-byte identical to the saved C59 Full static producer output. Vite's `.vite/manifest.json` files differ from the earlier static-producer manifests because the source paths in them reflect the in-worktree dependency and module locations instead of G0's data worktree paths; the actual app asset bytes are unchanged. The full-build checksum file records the manifests that the browser/API handoff will use.

## Decisions and remaining acceptance

**C59 is declined for the current candidate.** The initial launcher JS closure is much smaller, and launcher app-ready p50 improves by about 38 ms, but launcher FCP p50 is 8–12 ms slower. On the measured Full public-reader fixture, app-ready p50 is 722 ms slower. This is sufficient to reject the current tradeoff; static byte reduction alone is not a success criterion. The direct-reader delta is observed, not causally attributed solely to lazy transfer; import scheduling and module initialization were not separately isolated. The C59 source remains on this worker branch for review only and is not adopted or merged.

**C60 is declined under the current asset-serving contract.** The exact non-applied source diff is:

```diff
diff --git a/app/vite.config.ts b/app/vite.config.ts
index d0c05c12..d088537e 100644
--- a/app/vite.config.ts
+++ b/app/vite.config.ts
@@ -37,7 +37,7 @@ export default defineConfig({
     outDir: resolve(appRoot, "dist", uiDirectory),
     emptyOutDir: true,
     manifest: true,
-    cssCodeSplit: false,
+    cssCodeSplit: true,
     rollupOptions: {
```

The experiment's dynamic App entry references root `/styles2.css`. The current API serves `/styles.css` explicitly and serves root dynamic assets under `/assets/*`; it has no route for `/styles2.css` ([`serveStatic`](../../../../../packages/api/src/server.ts#L295-L326)). Therefore the candidate's generated dynamic stylesheet does not fit the current served-asset contract. This is a finding about the current contract, not a claim that CSS splitting can never work. Reconsider only under a named asset-serving contract change (potentially coordinated with C46/C47), with a fresh measured benefit and browser proof for theme changes, route transitions, flash behavior, print styling, nonce/CSP, and Core/Full profiles.

The timing cohorts verified launcher and invalid-token public-reader shell readiness and preserved the query/hash. They did not run the full interaction matrix. Theme behavior, print styling, nonce/CSP, launcher choice and remembered preference, and valid Core reader acceptance are explicitly `NOT_CHECKED`; no claim is made about those behaviors. The full browser acceptance matrix was not run after the coordinator declined C59. OCI acceptance remains separately delegated and `NOT_CHECKED` here. C60 has no current code delta to validate.

## C59 first-paint measurements

The baseline UI artifact is bound to source `9f801061d1cc40c4719988b5e1aef17d3ff60e74`; the C59 UI artifact is bound to `85504858418463354f9f54e4a3cd132aed80d0fd`. The immutable Full runtime artifacts used for the candidate server were built at `e3d6bc3af249a1483016ec7fcfe4f0ffb4ec8aa2`, tree `b994c86b1a3b4b25e1f44a9a11e6a22929cde192`, identical to the C59 source tree. No build ran during timing. The test server served the archived production `app/dist`, not Vite dev source. Chromium `155.0.8059.79`, Node `v24.21.0`, and CPU affinity `0-7` were used for browser and servers. Each route/variant used 20 fresh contexts, alternating baseline and C59. These results are limited to the paired run and must not be compared with G0's differently-affinitized timing campaign.

FCP and app-ready values are milliseconds, shown as p50 / p95 / p99 / max; `n=20` for every row. App-ready is after the visible launcher title or, for the Full reader fixture, the visible shared-publication heading and alert.

| Route | Variant | FCP p50 / p95 / p99 / max | App-ready p50 / p95 / p99 / max |
| --- | --- | ---: | ---: |
| Core launcher | Baseline | 72 / 120 / 120 / 120 | 191.1 / 211.5 / 221.6 / 221.6 |
| Core launcher | C59 | 84 / 96 / 100 / 100 | 153.2 / 169.2 / 179 / 179 |
| Full launcher | Baseline | 68 / 112 / 120 / 120 | 178.2 / 225.3 / 237.4 / 237.4 |
| Full launcher | C59 | 76 / 100 / 100 / 100 | 140.9 / 161.1 / 182.5 / 182.5 |
| Full public-reader fixture | Baseline | 72 / 80 / 80 / 80 | 214.3 / 231.6 / 252 / 252 |
| Full public-reader fixture | C59 | 84 / 112 / 136 / 136 | 936.3 / 950.3 / 957.8 / 957.8 |

The direct route was `/r/publishing/123/e2e-invalid-token?g5=paint#reader`. The fixture intentionally uses an invalid token; this measures direct route shell/error readiness and the C59 first-use module path, not successful manuscript loading. The query and hash were preserved, and every measured navigation and listed asset returned HTTP 200. The C59 direct route served `/assets/App-C3qIvJRg.js` (496,654 bytes, SHA-256 `a5219716a2c1170094bd9d96304dbb74ed8929b1f8c5000d4fe16ce29fe29d70`). The 722 ms p50 delta is not attributed solely to chunk transfer; import scheduling and module initialization were not separately isolated.

Actual served entry bundles were:

| Profile | Variant | `/main.js` bytes | `/main.js` SHA-256 |
| --- | --- | ---: | --- |
| Core | Baseline | 723,541 | `398b49b4f36c3aa47610d1948f6becd11ebb60f5a2101b75c58338b1cfcead1f` |
| Core | C59 | 227,391 | `5d0b27ecbfa4d48e547fc6760d3f5c2c73d17c48e98ccef36830f6ffc8d55fd6` |
| Full | Baseline | 726,390 | `8f4a1383634f6e4e40f5159b2f2b3bb9ea1c809d233251562c46d9979812e271` |
| Full | C59 | 227,407 | `1bfefb240ea910192378ed1de17f7f1722b70ace5f6be454f6f0555897390920` |

Both Full variants also served `/assets/browser-BJcfBg0P.js` (20,649 bytes, SHA-256 `e09842ae66a0fe0f4baa4a18216bff4ac1004b34487dc0e5bf501ee5806dada8`). Actual served `/styles.css` was 28,230 bytes in Core and Full; baseline SHA-256 was `5e336d9b3c641023debd562bfad64b3b1776c028e623f0df3f5ca2941bba6d41`, and C59 SHA-256 was `532b7961a831d874d8617610017471978ee84daeea3bf18a7c7954f5ba6df5f8`. The stylesheet bytes therefore differ despite the equal byte count; theme, print, and CSP behavior were not tested in this timing pass.

Raw Core and Full samples, served CSS hashes, the run manifest, and exact harness are archived in [`c59-first-paint-core.json`](./c59-first-paint-core.json), [`c59-first-paint-full.json`](./c59-first-paint-full.json), [`c59-served-css.json`](./c59-served-css.json), [`c59-browser-timing-manifest.json`](./c59-browser-timing-manifest.json), and [`c59-first-paint-harness.mjs`](./c59-first-paint-harness.mjs). The first Core attempt stopped after 13 samples per variant because Chromium exposed no FCP entry for C59 sample 14. Its surfaced partial summary and failure are documented in [`c59-first-paint-initial-attempt-diagnostic.json`](./c59-first-paint-initial-attempt-diagnostic.json); the attempt's individual sample rows were overwritten by the successful complete rerun, so the diagnostic does not present those rows as preserved raw data. The complete rerun waited for the official FCP entry and has 20 samples per variant with zero errors.
