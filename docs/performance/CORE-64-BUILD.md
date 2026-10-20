# C61 — Core root build graph

The Core profile now selects the existing selective build sequence from `scripts/profile-package.mjs`; Full still delegates to the preserved all-workspace command. The candidate changes only the root build scripts and the focused graph test. It does not alter package dependencies, generated profile semantics, or production source imports.

## Matched build measurement

The baseline source is `1a03807dec4990c7b44af551b4dcbd279c9498e4`. Candidate source is `184c4e7994a58855b0de1cf316cb27bd988b5ece`, whose parent is the baseline. Both use `pnpm-lock.yaml` SHA-256 `107821c3fdeb50571c891e7de500c0b477bc01206c1f4caa63d830fd8be7e768`.

Both worktrees used Node `v24.21.0`, pnpm `12.10.1`, Vite `6.4.4`, and the `/data/.pnpm-store/v11` content store. `pnpm install --frozen-lockfile` succeeded in each worktree, reusing 348 packages and downloading none. pnpm selected the `/data` store because its default home store cannot hardlink into the `/data` filesystem. Each worktree has its own real `node_modules/.pnpm` directory.

The timed invocation in both cases was `SCRIPTORIUM_PROFILE=core pnpm build`, pinned with `taskset -c 0-7`. The baseline `build` script is the original all-workspace command. The candidate `build` script dispatches Core to the existing selective graph; its `build:workspace` script is byte-for-byte equal to the baseline `build` script and preserves Full compatibility. The invoking shell allowed CPUs 0–15; the timed child process affinity was verified as CPUs 0–7.

| Source | Output state | Wall time | Exit |
| --- | --- | ---: | ---: |
| Baseline `1a03807` | Clean outputs/caches | 34.72 s | 0 |
| Baseline `1a03807` | Immediate warm repeat | 29.64 s | 0 |
| Candidate `184c4e7` | Clean outputs/caches | 17.84 s | 0 |
| Candidate `184c4e7` | Immediate warm repeat | 17.13 s | 0 |

The observed difference is 16.88 s (48.6%) for the clean pair and 12.51 s (42.2%) for the warm pair. These are descriptive results from one observation in each state, not performance budgets. External shared-host activity was unknown. The four runs were ordered baseline clean, baseline warm, candidate clean, candidate warm. Before each clean run, the fresh worktree had no build output directories, generated Core profile, Vite cache, or TypeScript build-info files; warm runs immediately repeated without cleanup.

The exact four build logs, run metadata, preserved script strings, and per-file output manifests are in [the C61 evidence directory](../../results/core64-build/). The manifests show that baseline and candidate produced identical Core, API, app, and Core profile outputs by both aggregate and per-file hashes. The candidate generated profile declares `modules: []`; its build log shows only contracts, module runtime, Core, app, and API build steps. No optional module output directories or optional module package specifiers were found in the generated profile or Core/API/app output.

A preliminary attempt to invoke `build:workspace` on the baseline exited before running a build because that alias exists only in the candidate. It is excluded from the measurement. The baseline was measured with its actual pre-change `pnpm build` entrypoint; the candidate preserves the baseline command body as `build:workspace` for the Full path.

## Verification status

The focused root-graph test previously passed 2/2 on the unchanged implementation inputs and was not rerun before timing. At this evidence commit, canonical typecheck, full tests, Core build/audit, and Full build compatibility are pending a separate validation batch.
