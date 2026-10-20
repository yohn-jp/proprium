# Core 64 G5 static asset closure

Date: 2026-10-21. Source baseline: `9f801061d1cc40c4719988b5e1aef17d3ff60e74` (current main after C02/C21). This is a static build comparison for C59 and C60, not a browser performance or runtime acceptance result.

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

`pnpm install --frozen-lockfile` was **not run in this worktree** during this verification batch; the earlier claim that the coordinator had verified it was unsupported and is withdrawn. At gate time `node_modules/.pnpm` was a real directory in this worktree. A read-only symlink audit found the workspace package links resolve to this worktree's own `packages/` and `modules/` sources, with no links resolving into the G0 worktree. This verifies workspace source binding, but does not establish that the installed package tree was produced by the current lockfile. The frozen install is scheduled for the next verification batch after C39 metrics as `pnpm install --frozen-lockfile` (prefer the cached store/offline mode when available); record the command and exit result before relying on dependency-install provenance. The lockfile SHA-256 remains `107821c3fdeb50571c891e7de500c0b477bc01206c1f4caa63d830fd8be7e768`.

With the installed tree described above, `pnpm typecheck` passed, and `pnpm test` exited 0: 421 tests passed, one optional Semantic CPU test skipped, and none failed. `SCRIPTORIUM_PROFILE=core pnpm build` passed, followed by `pnpm audit:core` (128 production dependency versions scanned). Vite emitted its existing >500 kB warnings for desktop and mobile entries; those builds completed successfully. These results have not yet been revalidated after a lockfile-frozen install.

The required full-profile command `SCRIPTORIUM_PROFILE=full pnpm build` also exited 0 on source commit `e3d6bc3af249a1483016ec7fcfe4f0ffb4ec8aa2`, tree `b994c86b1a3b4b25e1f44a9a11e6a22929cde192`. That tree is exactly the C59 candidate tree from `85504858418463354f9f54e4a3cd132aed80d0fd`; the intermediate C60 change was reverted before the build. The build generated the nine-module Full profile and left these immutable handoff outputs in the worktree:

- `app/dist`
- `packages/api/dist`
- `profiles/full/generated`

[`c59-full-build-artifacts.json`](./c59-full-build-artifacts.json) records the command, source binding, three Vite manifest SHA-256 values, and SHA-256/size for 639 files: the app and API outputs above, contracts/Core/migration/module-runtime package outputs, all nine enabled Full module outputs, and the generated Full profile. The primary app/API/profile outputs also have a data-area mirror at `/data/scriptorium-core64-worktrees/g5/handoff/c59-full`; all compiled dependencies remain available in the worktree paths listed in the checksum manifest.

The full build's non-manifest app files are byte-for-byte identical to the saved C59 Full static producer output. Vite's `.vite/manifest.json` files differ from the earlier static-producer manifests because the source paths in them reflect the in-worktree dependency and module locations instead of G0's data worktree paths; the actual app asset bytes are unchanged. The full-build checksum file records the manifests that the browser/API handoff will use.

## Decisions and remaining acceptance

**C59 remains a measurement candidate, not an accepted optimization.** Its static launcher closure has a clear reduction, while `/r/*` now downloads the App chunk on first use. Browser timing and interaction checks must decide whether that tradeoff is acceptable. Required browser evidence includes direct `/r/*` loading, launcher choice, remembered preference redirects, query/hash preservation, theme behavior, nonce/CSP, and Core/Full profiles in the configured Chromium and WebKit coverage. Run the documented Core and Full Playwright acceptance commands after the browser/timing lease is granted.

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

Neither candidate has completed browser or OCI acceptance. Browser and first-paint checks remain pending the isolated browser slot; no performance timing was run in this batch. The documented Core and Full Playwright commands still need exact results for direct routes, reader loading, launcher choice and remembered preference, query/hash, theme, nonce/CSP, and profile behavior. OCI acceptance remains delegated and `NOT_CHECKED` here. C59 must not be called accepted until the browser results are recorded. C60 has no current code delta to validate.
