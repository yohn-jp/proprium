# G2 C21 / C54 reader lookup evidence

- **Date:** 2026-10-21 JST
- **Implementation:** `59ae3d323d6cd314e33072132d76398382814dea`
- **Baseline runtime:** frozen G0 distribution; harness checkout `80ab121ad08b2c5f5957e3405eed511762fb1747`
- **Candidate runtime:** `59ae3d323d6cd314e33072132d76398382814dea`
- **Fixtures:** medium `773d4bb408f333e330e5359d74d43da8fe990554`; large `1adbb44980a9ccee009c536c7593fb23503ed86c`

The candidate adds a per-`SnapshotReader` LRU memo of `(treeish, path segment)` lookups, capped at 4,096 entries. It keeps the existing `SnapshotReader` and `DocumentSource` APIs and the C22 batch parser. The cache is reader-local; failed Git lookups are removed, and the path/mode checks still run on each read. The 1/10/100 candidate build was produced from the exact source changes later committed as `59ae3d3`.

## Warm 1/10/100 deep reads

The existing `DocumentSource.readMany` probe used 20 samples per size. It warmed 100 fixture paths before timing and checked every returned path, content, and SHA-256 revision against the exact fixture bytes. G0 had no reader lookup memo; the candidate warmup populated the reader-local memo. Git process counts were constant across samples.

| Fixture | Paths | G0 p50 / p95 | Candidate p50 / p95 | Git processes, G0 → candidate |
| --- | ---: | ---: | ---: | ---: |
| Medium | 1 | 22.50 / 23.74 ms | 4.82 / 5.39 ms | 5 → 1 |
| Medium | 10 | 114.28 / 118.19 ms | 23.80 / 29.22 ms | 50 → 10 |
| Medium | 100 | 1,361.07 / 1,443.31 ms | 244.85 / 264.29 ms | 500 → 100 |
| Large | 1 | 23.21 / 25.06 ms | 4.47 / 5.05 ms | 5 → 1 |
| Large | 10 | 113.45 / 123.28 ms | 22.57 / 24.90 ms | 50 → 10 |
| Large | 100 | 1,356.23 / 1,446.80 ms | 248.75 / 274.33 ms | 500 → 100 |

For 100 reads, the measured work drops from 400 `ls-tree` plus 100 `cat-file` launches to 100 `cat-file` launches. Candidate p50 is about 82% lower on both fixtures. The 1-read rows are from the warmed 100-path phase and should not be read as fresh-reader timings.

## Fresh-reader first read

This separate control used 20 fresh readers per fixture and runtime. Reader construction and `DocumentSource` construction were outside the measured interval; each timed operation was the first read through that reader. All 20 reads matched the exact 1,024-byte fixture content and revision `d13e2f8468431998dd99760029820c01553e0c25906c8ebaa6d2886af5134b25`. Each used five Git processes: four `ls-tree` and one `cat-file`.

| Fixture | Runtime | p50 / p95 | CPU p50 user / system | RSS p50 |
| --- | --- | ---: | ---: | ---: |
| Medium | G0 | 21.31 / 23.78 ms | 5.69 / 2.46 ms | 85,860,352 B |
| Medium | Candidate | 21.37 / 24.34 ms | 6.19 / 2.41 ms | 86,401,024 B |
| Large | G0 | 21.73 / 23.22 ms | 6.10 / 2.86 ms | 90,120,192 B |
| Large | Candidate | 24.43 / 44.83 ms | 6.80 / 3.36 ms | 89,255,936 B |

The medium timings are similar. The large candidate timing was slower and noisier in this n=20 run; the evidence supports unchanged process count, not cold timing equivalence. Per-sample RSS and high-water RSS values are in the raw files below.

## Large 10,000-path sweep

The fixture has 10,000 tracked readable paths, of which 9,998 have at least four path segments. The 10,000 paths contain 10,333 distinct `(treeish, segment)` lookup keys, exceeding the 4,096-entry reader memo limit. The sweep used the existing `DocumentSource.readMany` in its 32-path contract batches, one reader for the entire run, and a 180-second budget. Each completed batch was deep-compared with the fixture's exact path/content/revision records. The expected raw-byte total is 17,306,597; the completed candidate revision-list digest matches the expected digest.

| Runtime | Completed | Wall time | Git processes (`ls-tree` + `cat-file`) | Exact bytes / revisions | CPU user / system | Maximum sampled RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| G0 | 9,120 / 10,000 | 175.62 s (cap) | 58,011 (48,891 + 9,120) | 17,199,740 / 9,120 | 55,704,383 / 50,959,515 µs | 301,191,168 B |
| Candidate | 10,000 / 10,000 | 73.58 s | 20,333 (10,333 + 10,000) | 17,306,597 / 10,000 | 20,598,745 / 21,430,885 µs | 317,501,440 B |

G0 stopped before beginning another complete batch at the time budget. Its measurements are partial: they establish the exact completed count, bytes, revisions, processes, CPU and sampled RSS only. No full-run latency is inferred from that control. Candidate completion crossed the memo limit; all 10,000 reads returned the expected exact bytes and revisions. The candidate used more sampled RSS than the partial G0 run, so memory remains visible for the broader verification batch.

## Final verification

The frozen offline install reused 348 packages with zero downloads and left the lockfile unchanged. The focused Core reader test passed (1/1), `git diff --check` passed, `pnpm typecheck` passed, the full `pnpm test` suite passed with its existing opt-in Semantic CPU case skipped, `pnpm --filter @scriptorium/core build` passed, and `SCRIPTORIUM_PROFILE=core pnpm build` passed. Vite emitted its existing large-chunk warning.

The stock `pnpm audit:core` entrypoint could not locate this worktree's virtual store because the frozen install places it at `/data/scriptorium-core64-g2-virtual-store` rather than `node_modules/.pnpm`. The same audit script passed against a read-only hardlinked view of that exact store, scanning 128 production dependency versions and the built Core/API/app outputs. The invocation and log hash are in the verification manifest below.

```sh
pnpm typecheck
pnpm test
pnpm --filter @scriptorium/core build
SCRIPTORIUM_PROFILE=core pnpm build
node scripts/audit-runtime-deps.mjs \
  --node-modules /data/c64-g2-verification-20261021/audit-node-modules \
  --dist packages/core/dist --dist packages/api/dist --dist app/dist
```

The Core + modular Chromium run used Chromium 155.0.8059.79, Core profile, port 4186, one worker, and isolated synthetic Git fixtures. It reported 18 passed, 6 failed, and 3 profile skips in 27 tests. All six failures were the shared scene-open assertion: the chapter scene button was clicked but the Editor stayed on its placeholder. One failing test reproduced once against frozen G0 and passed on its next attempt. A bounded fresh-state rerun of those six cases, once per case and without retries, passed 6/6. Temporary response instrumentation on a candidate failure showed four HTTP 200 responses from `/api/projects/<id>/scenes/scene-1/views`, each containing the correct pinned commit, `Scene One` metadata, exact manuscript text and byte revisions; it observed no failed request or page error. This leaves a disclosed UI timing flake also present on G0, not a Core data mismatch. Snapshot-specific Core loss replay, delayed recovery, and Core-only workspace cases passed in the full run. OCI image checks remain in central G5; this leaf made no packaging or dependency change.

## Reproduction and artifact manifest

Measurements used Node `v24.21.0`, Git `2.54.0`, the medium and large synthetic fixtures at commits `773d4bb408f333e330e5359d74d43da8fe990554` and `1adbb44980a9ccee009c536c7593fb23503ed86c`, respectively, and these runtime roots:

- Baseline: `/data/scriptorium-core64-worktrees/g0`, compiled G0 distribution from source baseline `a1587e784788fa87d86c0eb7ab175d7a28a3209f`; measurement harness checkout `80ab121ad08b2c5f5957e3405eed511762fb1747`.
- Candidate: `/home/sophia/src/scriptorium-c64-g2`, source commit `59ae3d323d6cd314e33072132d76398382814dea`. The warm readMany raw files identify checkout `0532e17cda6508a769acc591666873a13f366619`; its only source/test delta from the later product commit is exactly the change committed as `59ae3d3`.
- Fixture root: `/data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic`.

The following commands regenerate the paired warm readMany cohorts, fresh-reader first-read controls, and 10,000-path sweep. The 10k baseline is intentionally time-capped at 180 seconds; its partial result must not be treated as a full-run latency.

```sh
export G0=/data/scriptorium-core64-worktrees/g0
export CANDIDATE=/home/sophia/src/scriptorium-c64-g2
export FIXTURE=/data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic
export WARM=/data/c64-g2-measure-20261021
export SUPP=/data/c64-g2-supplement-20261021
export TMPDIR=/data/c64-g2-measure-20261021/tmp

SCRIPTORIUM_REPO="$G0" node /tmp/c64-g2-deep-reads-probe.mjs "$FIXTURE/medium" "$WARM/medium-readmany.json" 20
SCRIPTORIUM_REPO="$CANDIDATE" node /tmp/c64-g2-deep-reads-probe.mjs "$FIXTURE/medium" "$WARM/medium-readmany-after.json" 20
SCRIPTORIUM_REPO="$G0" node /tmp/c64-g2-deep-reads-probe.mjs "$FIXTURE/large" "$WARM/large-readmany.json" 20
SCRIPTORIUM_REPO="$CANDIDATE" node /tmp/c64-g2-deep-reads-probe.mjs "$FIXTURE/large" "$WARM/large-readmany-after.json" 20

SCRIPTORIUM_REPO="$G0" node "$SUPP/reader-first-read-n20.mjs" "$FIXTURE/medium" "$SUPP/medium-first-read-before.json" 20
SCRIPTORIUM_REPO="$CANDIDATE" node "$SUPP/reader-first-read-n20.mjs" "$FIXTURE/medium" "$SUPP/medium-first-read-after.json" 20
SCRIPTORIUM_REPO="$G0" node "$SUPP/reader-first-read-n20.mjs" "$FIXTURE/large" "$SUPP/large-first-read-before.json" 20
SCRIPTORIUM_REPO="$CANDIDATE" node "$SUPP/reader-first-read-n20.mjs" "$FIXTURE/large" "$SUPP/large-first-read-after.json" 20

SCRIPTORIUM_REPO="$G0" node "$SUPP/deep-10k-sweep.mjs" "$FIXTURE/large" "$SUPP/large-10k-before.json" 180000
SCRIPTORIUM_REPO="$CANDIDATE" node "$SUPP/deep-10k-sweep.mjs" "$FIXTURE/large" "$SUPP/large-10k-after.json" 180000
```

The synthetic JSON outputs and one-off harnesses are local task artifacts, not repository fixtures. These SHA-256 values make the referenced files auditable without adding the raw data to the repository:

| Artifact | SHA-256 |
| --- | --- |
| `/data/c64-g2-measure-20261021/medium-readmany.json` | `b2d27684ca1f0b14dbf3438fafaffdb87641b932e1c533f91b7ea117829c8265` |
| `/data/c64-g2-measure-20261021/medium-readmany-after.json` | `956b757b89bf550efd258b23a4035757f3b547ab96c0a5e39b2881cc08df92df` |
| `/data/c64-g2-measure-20261021/large-readmany.json` | `79c38d7bfd1014d0110718c3bf00581937c6e83251be76a87c2e421a3e63f3e9` |
| `/data/c64-g2-measure-20261021/large-readmany-after.json` | `b29eeaddcf781cb6c855837e95a87bb4b4372fafa147befc9d4f36748ddfbbd2` |
| `/tmp/c64-g2-deep-reads-probe.mjs` | `90fe0e58a10eb86aef0cc5014b1a958ca7c7c1ccedd44d07878177b443df401b` |
| `/data/c64-g2-supplement-20261021/medium-first-read-before.json` | `5871c54ba75c4856255c651ac7c9b137708e6a7b6089a6cf38b8f90fa4e031c7` |
| `/data/c64-g2-supplement-20261021/medium-first-read-after.json` | `8a63af36078e73067023c07c6da5849acdbd33c93d22b045791a45ae209a25b0` |
| `/data/c64-g2-supplement-20261021/large-first-read-before.json` | `42a0f3194ff7843e2fcd4051407605452ba33646daa31589387fcc912c500f61` |
| `/data/c64-g2-supplement-20261021/large-first-read-after.json` | `1445497486f385434e277518cb36750e8425cb38f67114628457b9d019edecdd` |
| `/data/c64-g2-supplement-20261021/large-10k-before.json` | `7ebe583a89643286a0d1f454a4dae416104f0a108f55a79dcb86ed2a5bdbb1b1` |
| `/data/c64-g2-supplement-20261021/large-10k-after.json` | `223feedd5c35c89ca1d997c38e2106d8401c08acd6958c96f1cd2add7749bf03` |
| `/data/c64-g2-supplement-20261021/reader-first-read-n20.mjs` | `065498d471acf5b59b4865c08ce07b212b24ac618bbe80c0342d661f5aaf4ef1` |
| `/data/c64-g2-supplement-20261021/deep-10k-sweep.mjs` | `1633ed31dcf6edb7be1e6a0c3fb09fd082b71fc5b7350ccf57a2fa664d71c001` |

Workspace and browser verification ran with pnpm `12.10.1`, Chromium `155.0.8059.79` at `/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium`, Core profile, port 4186 and `/data` outputs. The initial full browser command was:

```sh
TMPDIR=/data/c64-g2-verification-20261021/tmp \
SCRIPTORIUM_PROFILE=core \
SCRIPTORIUM_E2E_PORT=4186 \
SCRIPTORIUM_E2E_STATE_DIR=/data/c64-g2-verification-20261021/e2e-state \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
pnpm exec playwright test --config tests/e2e/playwright.config.ts --project=chromium \
  tests/e2e/core.acceptance.spec.ts tests/e2e/modular-workspace.acceptance.spec.ts \
  --trace off --output=/data/c64-g2-verification-20261021/e2e-output
```

Verification log SHA-256 values are recorded here:

| Check | Result | Log SHA-256 |
| --- | --- | --- |
| `pnpm typecheck` | PASS | `feb9f0737a5d45717a689a8503b8597ae0b388ec3340494233dd94660e0e5a6b` |
| `pnpm test` | PASS; one existing opt-in Semantic CPU case skipped | `ac04c768210c398072342acb746949c97a52993f03118acf0e769a9519e9c9d0` |
| `pnpm --filter @scriptorium/core build` | PASS | `c283b8569451d5ebac87ea96ecac71133ac2bae3657ff7b133e3e1ab5779c591` |
| `SCRIPTORIUM_PROFILE=core pnpm build` | PASS | `2ada5ee3ba7a5ba6890d56ccb5ffa20c46b24f61a4313f0e0eeb5bc9b26b3aae` |
| Stock `pnpm audit:core` entrypoint | Could not find `node_modules/.pnpm` because this install uses the `/data` virtual store | `7a6af273fe1fef939e3ec3e5f0db8a80d2795a8d96ffe76dd65cfd8fef11b6ec` |
| Direct Core dependency audit against `/data` virtual store view | PASS; 128 production versions scanned | `21b0d5ec906dedd70cbb7bd3a0146bbdea488fb39205d6a2aa3dd9e1d188b43a` |
| Full Core + modular Chromium run | 18 pass, 6 fail, 3 skip; disclosed shared-state flake | `66b2f81e74aaee7d26de1968167e2de5b9978006644a8fa3d3c95a8c1dae5ab3` |
| Frozen G0 focused flake control, failing attempt | Same scene-open assertion | `21c21f7d59294fe96eb1d417a4fc354ba2db4b9723a1c157248e62f47b9800b1` |
| Frozen G0 focused flake control, next attempt | PASS | `43defaa2c0a166e2664b86ef374f20169e3a5f578dc93668adb22c3cdd632d29` |

Each failed browser case then passed once on its own fresh state with workers set to one; these were first attempts, not retries. The command form was:

```sh
TMPDIR=/data/g2tmp SCRIPTORIUM_PROFILE=core SCRIPTORIUM_E2E_PORT=4186 \
SCRIPTORIUM_E2E_STATE_DIR=/data/c64g2rNN \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
pnpm exec playwright test --config tests/e2e/playwright.config.ts --project=chromium \
  <spec-file> --grep "<exact case title>" --trace retain-on-failure \
  --output=<case-specific /data output directory>
```

| State root | Case | Log SHA-256 |
| --- | --- | --- |
| `/data/c64g2r01` | Coalesced draft restoration | `ad3992a204a627f0e50ba1195c3652b6cfac517074facfb55a2290b581d5dcfb` |
| `/data/c64g2r02` | Multi-document writing / checkpoint / publication | `111f601f1b2cb32e15efc18d76defad5d533d66bdedf31eff3ad287ffe9632fd` |
| `/data/c64g2r03` | Remote-update conflict draft | `113fa05889458751b2fc63751470a9489fa2cea55c3216797c7545e8760665a5` |
| `/data/c64g2r04` | IndexedDB quota guard | `6b45e61b53d87a30820ff9ef1e6c226a7a781bc11ee27a2f3e7420716dd27336` |
| `/data/c64g2r05` | Project reconstruction and guarded removal | `c6563ac1d25f2f963d0d63b07b8665989a8d242f5351d60f452cd21322085dd4` |
| `/data/c64g2r06` | Modular desktop workspace layout | `9d153b0189ed9f80f68ab018cfaaf20ed9bee71785e5d4084f53af04df36b641` |

The instrumented candidate failure log, retaining the correct HTTP 200 scene response for review, has SHA-256 `f8149328bd40dc2ac592d46df2e03754dea42816605c2b2c57f7875881dcd95f`. Logs and browser output remain under `/data/c64-g2-verification-20261021/`; the larger raw performance artifacts can be archived centrally with their checksums above.
