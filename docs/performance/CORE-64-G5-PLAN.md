# Core 64 G5 — build and OCI preflight

Date: 2026-10-20. Read-only preflight at base `a1587e784788fa87d86c0eb7ab175d7a28a3209f`.

Status: plan only. No dependency install, build, test, browser acceptance, OCI build/container, benchmark, CI, or Inari command was run. G0 retains the exclusive build/OCI resource lease.

## Scope and current source evidence

This unit covers C59–C62. C58's current-main baseline remains with G0; C63's cache-budget work remains with G2. After the resource lease is released, G5 owns the UI build configuration, root build graph, Dockerfile, and directly related build/verification scripts. `server.ts` is G3's boundary and `SharedApplication.tsx` is G1's boundary.

The active launcher path needs one ownership correction before a C59 edit: `app/index.html` loads `/src/launcher.tsx`; Vite rewrites that URL to `entries/desktop.tsx` or `entries/mobile.tsx` for those builds. The active `launcher.tsx` statically imports `App`, and `App` re-exports `SharedApplication`. `app/src/main.tsx` also statically imports `App`, but the current `index.html` does not reference `main.tsx`. If C59 needs code changes, include `app/src/launcher.tsx` in G5's exclusive write set; no source was changed in this plan.

Current build facts:

- `app/vite.config.ts` selects `launcher`, `desktop`, or `mobile` with `SCRIPTORIUM_UI`, writes each UI to a separate output directory, and sets `cssCodeSplit: false`.
- `app/package.json` builds all three UIs in sequence: the default launcher, then `SCRIPTORIUM_UI=desktop`, then `SCRIPTORIUM_UI=mobile`.
- Root `pnpm build` builds contracts, module runtime, migration, all nine optional module packages, Core, the selected generated profile, the app, and API in sequence. `SCRIPTORIUM_PROFILE=core` changes the generated profile and app build; it does not skip the optional module build steps.
- `scripts/profile-package.mjs --profile core --out <new-directory-outside-workspace>` already provides a selective Core packaging path. Its Core command graph builds contracts/runtime, profile generation, app, and API dependencies; it does not build optional modules.
- The Dockerfile pins Node 24 slim and builds a selected Core or Full runtime package. The runtime installs CA certificates, Git, and tini, runs as `node`/UID 1000, and declares `/data` and `/history` volumes. Its separate Go buildkit stages are not part of the Core/Full runtime image measurement.

These source facts establish candidate gaps, not measured savings. G5 should consume G0's frozen toolchain and current-main reference when available and add only the route/build/OCI observations needed for these candidates.

## Tool and host preflight

Observed on this host on 2026-10-20:

| Area | Read-only result |
| --- | --- |
| OCI tools | System Podman is `/run/current-system/sw/bin/podman`, version 5.8.6; Docker and the other probed OCI commands were not found. Nix 2.34.8 is present. The prepared `/data/scriptorium-ui-oci-tools/podman-cgroupfs-bin/podman` wrapper is present and resolves Podman 5.8.9. |
| OCI runtime | `podman info` returned exit 125 both directly and through the cgroupfs wrapper: `/run/user/1000/libpod/tmp/pause.pid` is missing. An info probe with `/data/scriptorium-ui-oci-run` as a different runroot was rejected because the existing database expects `/run/user/1000/containers`. No migration or runtime-directory repair was attempted. OCI acceptance is currently blocked pending a valid rootless runtime probe. |
| Storage | `/` has 2.0 GiB free; `/data` has 104 GiB free. The prepared wrapper routes graph storage and temporary files to `/data`. Keep build output, `TMPDIR`, and OCI storage on `/data`; do not use the default root filesystem for candidate image builds. |
| Signature policy | Existing policy is reject-by-default and allows the pinned `docker.io/library/node` source plus local container storage (and the existing GHCR entry). SHA-256: `0ab20a9a08e3a9c7ae6593bc83f23806d4121ecf558ffef1f6d229650d0e1042`. It was read and left unchanged. |
| Browser tools | This worktree has no `node_modules` or Playwright CLI. The default cached Playwright Chromium at `/home/sophia/.cache/ms-playwright/chromium-1248/.../chrome` failed `--version` because `libglib-2.0.so.0` is unavailable; no system Chromium executable was found. `/data/scriptorium-ui-browsers` contains cached Chromium 1248 and WebKit 2370, but a runnable browser path was not verified in this preflight. The earlier [Modular Workspace verification record](../verification/MODULAR-WORKSPACE.md) reports Chromium 155 and cached WebKit through an FHS wrapper; that historical result does not establish availability in this worktree. |

The Playwright config supports `SCRIPTORIUM_E2E_CHROMIUM` and `SCRIPTORIUM_E2E_WEBKIT`. Do not install browsers or change the host policy as part of this preflight.

## Existing acceptance commands

The repository's aggregate local gate is `pnpm verify` (`scripts/verify.mjs`). It runs frozen install, typecheck, tests, Core build/audit/browser/OCI, Full build/browser/OCI, and the existing MCP, Diagnostics, and migration acceptance stages. It is local-only and does not invoke CI.

The focused production gates relevant to G5 are:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
SCRIPTORIUM_PROFILE=core pnpm build
pnpm audit:core
SCRIPTORIUM_PROFILE=core pnpm exec playwright test --config tests/e2e/playwright.config.ts
SCRIPTORIUM_PROFILE=full pnpm build
SCRIPTORIUM_PROFILE=full pnpm exec playwright test --config tests/e2e/playwright.config.ts
```

The browser suites run Chromium for the configured E2E set and WebKit for `ui-v1.acceptance.spec.ts`. The existing UI acceptance contract covers launcher preference/direct routes, desktop/mobile shell behavior, themes, nonce/CSP, and navigation. These commands require the relevant browser executable and a completed profile build.

The existing Core and Full image acceptance command is `bash scripts/verify-oci.sh`, once per profile. It builds the selected profile, checks startup/readiness and the complete served asset closure, validates profile metadata, UID 1000, writable `/data`, image ID/digest, startup process/cgroup observations, and SIGTERM drain. For Podman the verifier selects OCI media type when `OCI_ENGINE` has basename `podman`. The prepared cgroupfs wrapper preserves that basename:

```sh
OCI_ENGINE=/data/scriptorium-ui-oci-tools/podman-cgroupfs-bin/podman \
TMPDIR=/data/scriptorium-ui-oci-tmp \
SCRIPTORIUM_PROFILE=core \
SCRIPTORIUM_OCI_IMAGE=localhost/scriptorium:c64-g5-core \
bash scripts/verify-oci.sh
```

Repeat with `SCRIPTORIUM_PROFILE=full` and a distinct tag. The command is recorded, not currently runnable: the OCI `info` probe above failed. The existing verifier does not check `/history` writes, report image byte size, capture repeated startup quantiles, or measure an idle CPU/RSS window; those are gaps against C62's criteria.

## Minimal candidate experiments

| Candidate | Comparison and acceptance evidence |
| --- | --- |
| C59 — launcher static import | At the G0 reference SHA, record the Vite manifest's recursively imported JavaScript and CSS bytes (gzip) for `/`, `/desktop/`, and `/mobile/`, then capture cold first paint and launcher choice, remembered preference, direct route, and `/r/*` load behavior in Chromium. Test one isolated dynamic-import change only if the launcher route's initial closure contains avoidable `App` code. Compare the same routes and cache conditions before/after; preserve reader routing, query/hash, theme, nonce/CSP, and all three built entries. |
| C60 — CSS split | Change only `cssCodeSplit` in an isolated candidate. Compare each entry's initial CSS request/gzip bytes and first paint, then check desktop/mobile light, dark, and paper themes, route transitions, and print styling for flash or style differences. Keep it only with a measured initial-load benefit and equivalent rendering. |
| C61 — Core build graph | Compare current `SCRIPTORIUM_PROFILE=core pnpm build` with a Core-only root graph using the existing `createBuildCommands('core', profile)` sequence from `profile-package.mjs`. Record clean-output and warm build wall time, cache state, and emitted profile closure on the same host and toolchain. The existing `node scripts/profile-package.mjs --profile core --out <new-directory-outside-workspace>` can validate the selective package closure, but exclude its deploy/audit time from the matched build-time comparison. Confirm generated Core imports contain no optional modules and retain typecheck, tests, Core audit, Core build, and Full build behavior. Do not treat package pruning or a skipped source import as a valid build-time saving. |
| C62 — runtime image | Once Podman preflight succeeds and G0 releases the lease, compare Core and Full images at the same source SHA and engine settings. Record final image bytes/digest, repeated start-to-ready times, a fixed idle CPU/RSS sample, `/data` and `/history` writes, UID 1000, profile/assets, and graceful SIGTERM drain. Reuse the existing verifier for its covered assertions and add only the missing task-local measurements/checks required by C62. Preserve pinned base, user, volume, signal, and profile semantics. |

No performance budget or implementation is justified by static source inspection alone. Keep each candidate's before/after SHA, command, raw evidence, sample count, and unchecked cases in the G5 result record; retain `NOT_CHECKED` for unavailable browser or OCI measurements.

## Next execution gate

After G0 releases its resource lease, first establish a successful rootless Podman `info` probe and a runnable Playwright Chromium/WebKit path, then bind measurements to G0's reference SHA/toolchain. Recheck G5's exclusive paths, including the active `launcher.tsx` path if C59 is implemented. Run only the focused experiment for a candidate with an observable gap, followed by the production acceptance commands above. Do not add CI/workflow changes.
