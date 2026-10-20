# Core 64 C09 Workspace resize probe

**State:** C09 measurement is complete; the evidence verdict is `DECLINED`, with no Workspace production change. The frozen runtime tree is pinned to `ffd02739`, whose production source matches the C02-integrated runtime at `e8aa3ecd`. The source seed is G0's immutable synthetic-small fixture.

## Scope

C09 asks whether `Workspace.tsx` updates the complete layout too often while a split pane is resized. The accepted evidence requires a real pointer drag and keyboard resize, including exact final DOM widths and the explicitly saved layout. Do not add `requestAnimationFrame` batching or change persistence until this workload shows a repeatable benefit and preserves both input paths.

The probe makes a short disposable copy of the generated small synthetic repository under `TMPDIR` and runs the production Core app against that copy. It leaves the G0 seed untouched. It uses `scripts/performance/server.mjs` and the existing disposable-page probes in `scripts/performance/browser-probes.mjs`. It does not replace the Workspace or splitter with a test implementation. The desktop run measures:

- a 40-step trusted pointer drag across the real horizontal separator, followed by a trusted `ArrowRight` keyboard resize;
- pixel widths of the real Editor and Outline panels before and after each gesture, the actual saved split percentages, the raw localStorage value, and exact restoration after reload;
- sampled animation frames and intervals, app `requestAnimationFrame` calls, Long Tasks, React commits, panel `ResizeObserver` notifications, panel style mutations, IndexedDB transactions/reads, and storage calls;
- whether resize itself writes Workspace state before the user chooses **Save layout**.

The mobile run uses the production `/mobile/` entry at 390×844 CSS pixels. Chromium receives 30px top and 24px bottom safe-area insets through CDP. The probe records the viewport meta tag, resolved safe-area values, production mobile-header/footer padding, horizontal overflow, and whether the mobile Workspace exposes any desktop resize handles.

## Reproducible build and measurement commands

The one plain Core build was made in `/home/sophia/src/scriptorium-c64-resize`, which stays at source commit `ffd02739` as the frozen runtime root. Report and probe commits belong in a second isolated worktree based on that commit. Use Chromium 155, `/data/g1rtmp` for short temporary paths and the unique virtual store, and the existing G0 small seed:

```sh
cd /home/sophia/src/scriptorium-c64-resize
node --check scripts/performance/core64-resize.mjs
node --check scripts/performance/core64-resize-manifest.mjs
TMPDIR=/data/g1rtmp pnpm install --offline --frozen-lockfile \
  --virtual-store-dir=/data/g1rtmp/c64-resize-virtual-store
SCRIPTORIUM_PROFILE=core TMPDIR=/data/g1rtmp pnpm build
node scripts/performance/core64-resize-manifest.mjs \
  docs/performance/results/core64-resize/runtime-manifest.json
# Keep the frozen runtime worktree at ffd02739 for later probes.
TMPDIR=/data/g1rtmp \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
SCRIPTORIUM_PERF_RUNTIME_ROOT=/home/sophia/src/scriptorium-c64-resize \
SCRIPTORIUM_PERF_EXPECTED_RUNTIME_COMMIT=ffd02739 \
node scripts/performance/core64-resize.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/small \
  /data/g1rtmp/c09-2026-10-20.json
```

The output path must be new. The unhooked Core profile was built once from this pinned `ffd02739` worktree, which has the same production source as `e8aa3ecd`; do not mix in G0's older `a1587e78` app bundle or another worker's instrumented output. The runtime manifest records the full source commit, absolute runtime root, Node/pnpm toolchain, unchanged production-tree identity relative to `e8aa3ecd`, and SHA-256 plus byte length for every file in `packages/contracts/dist`, `packages/module-runtime/dist`, `packages/core/dist`, `packages/api/dist`, `app/dist`, and `profiles/core/generated`. Leave these artifacts and the runtime worktree at `ffd02739` for later API and probe work. The probe copies only the seed manifest and bare repository into `/data/g1rtmp`, uses the resulting disposable remote for both desktop and mobile, and removes that copy after the run. Copy the result from `/data/g1rtmp/c09-2026-10-20.json` into the evidence worktree before committing. The result records the probe script hash and source commit, runtime commit, fixture manifest, browser, host, raw widths/layout, per-gesture counters, and exact restore check. A failed or unsupported behavior remains explicit in the result; do not infer FPS from automation duration or equate React commits with direct `onLayout` callback counts.

## Decision rule

Compare pointer and keyboard separately. Consider a narrow update-cadence change only if repeated frame samples show resize work that crosses frames or creates avoidable commits/Long Tasks, while the final DOM widths, keyboard response, saved values, reload restoration, and mobile safe-area behavior remain equivalent. Any proposed change must be measured on the same fixture, runtime, browser, viewport, and host. If resize work is already bounded by rendered frames, or if no user-visible cost is isolated, record C09 as `DECLINED` with the measured evidence and leave `Workspace.tsx` unchanged.
