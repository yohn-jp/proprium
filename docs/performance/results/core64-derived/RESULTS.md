# C32/C33/C34/C36 evidence

**Date:** 2026-10-21 JST. **Branch:** `perf/c64-derived`. **Base/runtime commit:** `e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47`. **Node:** v24.21.0. **Git:** 2.54.0. **Fixture:** fixed synthetic medium `773d4bb408f333e330e5359d74d43da8fe990554`, large `1adbb44980a9ccee009c536c7593fb23503ed86c`, small `e70bb509cc41b383451335e05af36d78f1cb31db`. All fixture copies were immutable; the manifests point to copied bare remotes with unchanged commit IDs.

## Reused G0 context (separate `n=1` observations)

The existing G0 runtime was `a1587e784788fa87d86c0eb7ab175d7a28a3209f`. These standalone Core calls are reference points only; they are not paired with each other or with the C21-integrated before/after cohort below.

| G0 operation | Files | Wall | Node CPU user + system | End RSS / process peak | Core Git processes | State |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Search | 10 | 326.48 ms | 113.29 + 40.40 ms | 80.6 / 80.6 MiB | 59 | complete |
| Search | 1,000 | 35,912.40 ms | 7,772.74 + 5,288.85 ms | 212.5 / 212.5 MiB | 6,492 | complete |
| Search | 10,000 | — | — | — | — | `NOT_CHECKED`; no scan sample completed |
| Statistics | 10 | 324.75 ms | 114.58 + 45.54 ms | 78.6 / 80.5 MiB | 58 | complete |
| Statistics | 1,000 | 35,680.49 ms | 7,853.14 + 5,027.69 ms | 212.7 / 212.7 MiB | 6,491 | complete |

The same G0 evidence has `readTreeSnapshot` cold reads below, each `n=1`; these are whole-tree observations, not path-grouping attribution.

| Cold tree | Files | Wall | Node CPU user + system | End RSS / process peak | Core Git processes |
| --- | ---: | ---: | ---: | ---: | ---: |
| read | 10 | 73.67 ms | 40.13 + 7.82 ms | 75.8 / 75.8 MiB | 9 |
| read | 1,000 | 135.37 ms | 135.33 + 18.49 ms | 84.6 / 84.6 MiB | 9 |
| read | 10,000 | 591.90 ms | 678.39 + 87.36 ms | 129.7 / 129.7 MiB | 10 |

The G0 100,000-file `read-stress.json` is a partial workload report with a completed cold-tree sample of 9,333.29 ms; it has no matched after run or tree CPU attribution.

The C21 `SnapshotReader.readMany` measurement is also separate from Core `searchSnapshot`/`writingStatsSnapshot`: warmed 100-path medium reads changed from 400 `ls-tree` plus 100 `cat-file` launches to 100 `cat-file` launches (p50 1,361.07 ms → 244.85 ms). Large changed from 500 to 100 launches. Fresh-reader first reads retained five process launches and similar medium p50 (21.31 ms → 21.37 ms). Core search and statistics call `snapshotFile` directly, so these C21 results are not credited as scan improvements. See [C21 evidence](../../CORE-64-G2-C21-EVIDENCE.md).

## Measured changes

The before cohort used the C21-integrated compiled Core entry with SHA-256 `aae44d8d17b135872daa016bff3ae7ffa1845a98921149a76322efb376ecae09`. The candidate compiled Core entry has SHA-256 `a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`; candidate `packages/core/src/index.ts` SHA-256 is `dd05006e97a4dd471fd3555b852d1ad4166de53a4ec41b80d8a0c52d3ab929c5`. Both harness records identify tracked base commit `e8aa3ecd`; these binary/source hashes distinguish the candidate's uncommitted measurement build from the before build.

### Matched 1,000-file search + statistics pair

Five fresh Core workers per cohort used the same fixture commit and absent query. Each worker registered its own local clone, pinned one remote snapshot, then ran search followed by writing statistics in the same CoreStore. All ten workers completed and asserted the pinned snapshot. The before/after result hashes are identical:

- Search: 0 results, SHA-256 `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
- Statistics: 1 volume, 10 chapters, 493 scenes, 3,159,040 characters, SHA-256 `ad31bbb20ba3325a5d3e5d1b054ac2ee312a7319ca86ad36ad60f534b68c507d`.

| Measure | Before p50 | Before p95/max | Candidate p50 | Candidate p95/max |
| --- | ---: | ---: | ---: | ---: |
| Search wall | 30,887.95 ms | 37,878.69 ms | 10,192.88 ms | 11,410.28 ms |
| Stats wall | 33,800.90 ms | 39,875.41 ms | 10,260.96 ms | 12,734.97 ms |
| Combined wall | 67,906.60 ms | 77,754.10 ms | 21,166.43 ms | 24,145.25 ms |
| Combined Node CPU | 25,601.63 ms | 29,817.10 ms | 8,743.86 ms | 10,074.00 ms |
| Combined Git processes | 12,987 | 12,987 | 4,079 | 4,079 |
| `ls-tree` processes | 10,977 | 10,977 | 2,069 | 2,069 |
| `cat-file blob` processes | 1,994 | 1,994 | 1,994 | 1,994 |
| Document reads / bytes | 986 / 6,318,080 | same | 986 / 6,318,080 | same |
| Metadata reads / bytes | 1,008 / 115,734 | same | 1,008 / 115,734 | same |
| Max operation RSS sample | 218.92 MiB | 219.22 MiB | 206.13 MiB | 210.57 MiB |

For `n=5`, p95 and p99 are the observed maximum. They are not service percentiles. Operation p50s were 30.89 s → 10.19 s for search and 33.80 s → 10.26 s for statistics. The paired median reduction is 68.8%; process counts show the same path lookup reduction while body/blob reads remain unchanged.

### Hierarchy profile

These fresh-worker `tree-profile` runs used the public cold `readTreeSnapshot` operation and a V8 profile around `hierarchySnapshot`. The tree SHA was identical before and after at each fixture size.

| Files | Tree SHA-256 | `hierarchySnapshot` method wall p50 before → after | Post-read grouping/assembly wall residual p50 before → after | `readHierarchyYaml` wall p50 before → after | Profiled whole cold-tree wall p50 before → after | Process peak RSS p50 before → after |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | `eec728cfa3f03edb54ff9d2abc6d24da06a04b6078d303e1388c88ace5bbfeb0` | 101.694 → 99.240 ms | 3.935 → 3.571 ms | 97.759 → 95.670 ms | 194.129 → 167.442 ms | 93.82 → 91.30 MiB |
| 10,000 | `ea9490c340d7f3742d161be63a87681f897f88035d905e50ce97416df5472cae` | 558.228 → 526.419 ms | 70.101 → 21.569 ms | 487.503 → 503.121 ms | 897.930 → 599.655 ms | 134.93 → 131.98 MiB |

The `hierarchySnapshot` method wall starts after the benchmark wrapper's `Profiler.start` request and stops when the original method returns, before the wrapper awaits `Profiler.stop`. It includes `readHierarchyYaml` and subsequent grouping, ordering, and tree materialization. The grouping/assembly residual is calculated as that method wall minus the separately timed `readHierarchyYaml` wall; it is the direct attribution used here, though it is not an exact per-loop timer. At 10,000 files, this residual fell 69.2% while the method wall fell from 558.228 to 526.419 ms and `readHierarchyYaml` was slightly slower in the candidate cohort.

The `tree.cold.profiled` wall is the outer `readTreeSnapshot` sample. It includes cold-read wrapper work and the profiler start/stop requests, so its 897.930 → 599.655 ms p50 change is not attributed entirely to grouping. A representative baseline profile's top Core leaf was the per-chapter `files.filter(...)` closure (39.095 ms); that frame was absent from the candidate's top frames. The candidate's representative top Core leaf `addHierarchyChild` was 2.110 ms. The profile also samples `node:inspector` stop overhead; do not treat sampled CPU as a precise per-loop census.

The 10-file exact-tree comparison was semantic-only and produced the same baseline/candidate tree SHA-256 `188d597fd606e4de07abc7caa052f6a5c8b86c5dd7ee160be3647e094cb9fc6b`. The comparator used the G0 distribution SHA-256 `6044bf153eecf17075c1319dbef00619e6959bc9846ba38bd849ef2a36c5da96` and the candidate distribution SHA-256 `a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3`. Existing G0 small cold-tree wall 73.67 ms is a separate `n=1` context value, not an after measurement.

## NOT_CHECKED

- 10,000-file combined search/statistics: before result is `NOT_CHECKED` at the 180-second worker cap while search was pending; the candidate-after scan was not run. No full large-scan latency or inferred win is reported.
- 100,000-file candidate hierarchy CPU/profile. The existing G0 cold-tree sample is partial single-observation context only.
- A store-wide or cross-operation decoded-body/count cache; no resident/general index was adopted.
- Central full-profile browser and OCI acceptance. Focused Core-profile Chromium passed 3/3.

## Validation logs

The frozen offline install was completed before measurement and reused 348 packages with zero downloads. `pnpm-lock.yaml` and dependencies are unchanged by this unit. The audit command behavior is recorded explicitly: stock `pnpm audit:core` exits because the worktree lacks `node_modules/.pnpm`; the frozen store is external. Running the same `scripts/audit-runtime-deps.mjs` against a hardlinked view of that exact virtual store passes and scans 128 production versions.

| Check | Result | Log SHA-256 |
| --- | --- | --- |
| Focused Core behavior tests | pass, 2/2 | `6825e54739266ebc02ce9ba5572a95fe080e3433febdedd2f7c20e98cc3344cd` |
| Focused transaction boundary tests | pass, 3/3 | `3b5269d3ac9faca13d1783f26f8104d016fd283317df54cb5a5d7b6a2f7d6f73` |
| `pnpm typecheck` | pass | `feb9f0737a5d45717a689a8503b8597ae0b388ec3340494233dd94660e0e5a6b` |
| `pnpm test` | pass; one existing opt-in Semantic CPU case skipped | `d5bbdc909b4807cd49b0403919e43d116bd061e4c5cf5b57c5868a391f1f3be1` |
| `SCRIPTORIUM_PROFILE=core pnpm build` | pass; existing Vite large-chunk warning | `2324ee50dccb7a36a9ce77f111d9ec23e4d98c384a1dcd344c6098f1b5471d48` |
| Stock `pnpm audit:core` | external virtual-store path limitation | `cec2c6c1c79d235d88b9e43f88f8537e77478f87bd63cb3208ec2cdbb4c6d687` |
| Same audit script, exact store view, Core/API/app dist | pass; 128 production versions | `21b0d5ec906dedd70cbb7bd3a0146bbdea488fb39205d6a2aa3dd9e1d188b43a` |
| Focused Chromium 155 / Core profile | pass, 3/3 | `b941a4cffc0fc26ad62021b8e7bd21f6cb1e512537d6cdb4b1c9db2fae818020` |

The browser command used port 4186, a fresh `/data` Core state, system Chromium 155.0.8059.79, and grep-matched tests for pinned history/tree observation, multi-document Draft/Checkpoint/GitHub workflow, and Core-only workspace authoring. The full-profile browser matrix, WebKit, and OCI remain central G5 checks.

## Artifact locations and checksums

Raw before/after JSON, worker outputs, the exact-tree parity script/output, validation logs, and the hardlinked audit view are under `/data/scriptorium-core64-derived-e8aa3ecd-20261021/`. The artifact manifest lists SHA-256 values for all raw JSON reports and the source, harness, compiled candidate, and validation logs.
