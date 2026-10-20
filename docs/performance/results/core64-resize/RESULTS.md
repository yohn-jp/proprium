# C09 Workspace resize result

**Verdict: `DECLINED` — no Workspace production change.** The real pointer and keyboard paths update the rendered split correctly, but this capture showed no user-visible cost that justifies rAF batching or a persistence change.

The canonical run used the frozen Core runtime at `/home/sophia/src/scriptorium-c64-resize` (`ffd02739ab095dfda2854a3ff487434c84f6b536`), Chromium `155.0.8059.79`, Linux x64, and the G0 synthetic-small fixture (`e70bb509cc41b383451335e05af36d78f1cb31db`; 10 files, 3 scenes, 1 KiB / 100 KiB / 1 MiB documents). The full capture is [`c09-2026-10-20.json`](c09-2026-10-20.json) (SHA-256 `2b21ed37205b1c7974dd50e83921ee6a2996f004b23a7b89ee803320d1b8c5d7`); it binds the probe bytes with SHA-256 `64fdd651de8ebb76df1ec10a96b6489be6462840566ef8582b7dd5c57aca1f75`.

| Gesture | DOM result | React / browser work | Persistence |
| --- | --- | --- | --- |
| Trusted 40-step pointer drag, 112 px requested | Editor `973.22 → 1084.86` px; Outline `457.98 → 346.34` px | 45 React commits, 82 panel ResizeObserver notifications, 84 panel style mutations, 14 app rAF requests; 69 sampled frames, p50/p95/max interval `16.7/16.8/49.9` ms, zero gaps over 50 ms, zero Long Tasks | No Workspace-key calls or writes during resize |
| Trusted `ArrowRight` | Editor `1084.86 → 1227.97` px; Outline `346.34 → 203.23` px | 1 React commit, 4 panel ResizeObserver notifications, 2 style mutations, 1 app rAF request; 7 sampled frames, p50/p95/max interval `16.7/16.7/16.7` ms, zero Long Tasks | No Workspace-key calls or writes during resize |

The pointer window also contained 6 readonly IndexedDB transactions/reads and 6 localStorage calls on draft, editor-typography, and reading-resume keys. They were not Workspace writes. Choosing **Save layout** performed exactly one Workspace localStorage write with split sizes `[85.7777777778, 14.222222222199997]`. Reload restored the exact saved JSON and the same panel widths; the measured editor share was `85.79975%`.

At 390×844, Chromium applied the requested 30 px top and 24 px bottom safe-area insets to the production mobile header and footer. The viewport and workspace were both 390 px wide, page overflow was zero, and the mobile workspace rendered no desktop resize handles.

The result shows many state commits during the pointer stream, but sampled frames stayed at the display interval for p95, no Long Task occurred, keyboard resizing committed once, and both save/restore paths were exact. A cadence change has no demonstrated benefit on this workload, so [`Workspace.tsx`](../../../../app/src/workspace/Workspace.tsx) remains unchanged.

## Runtime and commands

The once-built, unhooked Core artifact is described by [`runtime-manifest.json`](runtime-manifest.json): 85 files / 5,095,497 bytes across six roots, all independently rechecked by byte count and SHA-256. Its source commit is the frozen runtime root's `ffd02739ab095dfda2854a3ff487434c84f6b536`; production source/config trees compare equal to `e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47`. The manifest SHA-256 is `f16e9db3d4e99c39985044ef44fa677dde62678be54f0d36f53693bf095a9031`.

The offline install and one Core build completed successfully. Their retained logs are [`c64-resize-install.log`](c64-resize-install.log) (SHA-256 `0130849ae605bffae70b120f4c64f5e0a25625edd2f102126f0f5edf5a09f794`) and [`c64-resize-build.log`](c64-resize-build.log) (SHA-256 `e33e3d9b05c03136f4d797147580254748bcb279dd5a39ef145af9e5fb887705`). Commands:

```sh
cd /home/sophia/src/scriptorium-c64-resize
TMPDIR=/data/g1rtmp pnpm install --offline --frozen-lockfile \
  --virtual-store-dir=/data/g1rtmp/c64-resize-virtual-store
SCRIPTORIUM_PROFILE=core TMPDIR=/data/g1rtmp pnpm build
# This generator refuses to overwrite an existing manifest; use a new output path for another inventory.
TMPDIR=/data/g1rtmp node scripts/performance/core64-resize-manifest.mjs \
  docs/performance/results/core64-resize/runtime-manifest.json
TMPDIR=/data/g1rtmp \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
SCRIPTORIUM_PERF_RUNTIME_ROOT=/home/sophia/src/scriptorium-c64-resize \
SCRIPTORIUM_PERF_EXPECTED_RUNTIME_COMMIT=ffd02739 \
node scripts/performance/core64-resize.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/small \
  /data/g1rtmp/c09-2026-10-20.json
```
