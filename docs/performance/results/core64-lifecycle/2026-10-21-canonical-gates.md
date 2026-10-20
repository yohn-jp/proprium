# C52/C55 canonical validation — 2026-10-21

The lifecycle fix at source commit `449f26386bd0c2acf515364da1ead7deabfd0e69` (tree `04c5ceabff5ca9a7a35f786c3f555b7f1b0fb02e`) passed the focused browser run and the canonical Core validation gates below. These checks establish correctness and buildability; their elapsed times are not performance evidence.

The worktree was `/home/sophia/src/scriptorium-c64-lifecycle`. The frozen install used the local pnpm store at `/home/sophia/.local/share/pnpm/store/v11`: 348 packages reused, none downloaded, lockfile resolution skipped. Build outputs for the Core package, API, app, and generated Core profile are enumerated by the 58-file SHA-256 manifest at `/data/scriptorium-core64-worktrees/g4-lifecycle/20261021-c52-c55/canonical/core-profile-artifacts.json` (manifest SHA-256 `9ce7062cc6f567468e88fabc51f019ae7c232e6d3bcda8075f819bebb34f81f0`).

| Command | Result | Raw log SHA-256 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS, exit 0 | `ae91938ac3d2bf7033a91a06bfeb2ce4f6707e36d84c64e794f3e68f1fed343d` |
| `pnpm typecheck` | PASS, exit 0 | `feb9f0737a5d45717a689a8503b8597ae0b388ec3340494233dd94660e0e5a6b` |
| `pnpm test` | PASS, 422 passed, 1 existing opt-in Semantic CPU test skipped, 0 failed | `480e9e7f789e59145056a67b58552b2349b94c3db7a6af7c9b2993538cf1e916` |
| `pnpm --filter @scriptorium/core build` | PASS, exit 0 | `c283b8569451d5ebac87ea96ecac71133ac2bae3657ff7b133e3e1ab5779c591` |
| `SCRIPTORIUM_PROFILE=core pnpm build` | PASS, exit 0; emitted the Core profile and all three app UI outputs | `552765c74de33eadfb1127fe19c3c2d07e6e5816ae07d3b6c2d5c69eb95ea870` |
| `pnpm audit:core` | PASS, 128 production dependency versions scanned | `b4926aaaf9c2a51c388d729a342e24e792f2e7387fbc7bf201df0fe6b40d1030` |

Raw logs and exit-code files are under `/data/scriptorium-core64-worktrees/g4-lifecycle/20261021-c52-c55/canonical/`. The Core-profile build retains the existing Vite large-chunk warnings. The host had concurrent CPU activity during these checks, so no wall-time conclusion is drawn.

An app-only build was tried before generating `profiles/core/generated`; it stopped at the missing generated `browser.mjs` entry and emitted no app bundle. The subsequent canonical profile build generated that entry and passed. This setup attempt is retained as `app-core-build.log` (SHA-256 `18ef4064d7b0bd08cb9586d3f0e9c4a99a6932035d427f0a9094526bf8ab55e9`) and is not a product-code failure.

The separate focused Chromium evidence remains [here](2026-10-21-C52-C55.md), with exact host, API, and journal source hashes attached to its final 9/9 run. These checks do not replace the coordinated Full-profile browser or OCI acceptance batch, which remains pending.
