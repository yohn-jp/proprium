# CORE-64 synthetic evidence archive

**Status:** published; coordinator download verification passed for the tar, INDEX and all 295 artifacts.

The frozen selection contains 295 artifacts. The deterministic tar is 16,066,560 bytes with SHA-256 `5be0a43a560f9bf601f50fc5e76817e3282e3238698fbf106898ac63973b119f`. The checked-in [`INDEX.json`](INDEX.json) has SHA-256 `33a6328e84efd918bc97f448dc92614a923c909c8329e94669d8a14b0882add3` and records the permanent asset URL `https://github.com/yohn-jp/scriptorium/releases/download/perf-core64-2026-10-21/core64-2026-10-21.tar`. The archive contains 282,467,104 source bytes represented by 15,828,762 deterministic gzip bytes. It has 251 non-diagnostic and 44 diagnostic rows. The longest USTAR filename component, including `.gz`, is 71 bytes.

The inventory preserves the explicit synthetic evidence selection assembled during CORE-64, including the 278 earlier rows with the two USTAR-safe aliases, plus 14 final-validation logs/traces and three tracked final-verification records. The partial preparation indexes in [`core64-archive-prep`](../core64-archive-prep/STAGING-2026-10-21.md) remain unchanged as preparation history. The checked-in index is the final packer output and has `storage` metadata for the archive above.

| Evidence group | Artifacts |
| --- | ---: |
| C58 / G0 baseline and verification | 69 |
| G1 editor and browser evidence | 9 |
| C09 resize | 2 |
| C14–C16 journal | 4 |
| G2 C21/C54 deep reads | 10 |
| C32–C33 derived scans and tree | 46 |
| C41–C42 status | 3 |
| Read overhead | 1 |
| C48–C57 payload | 3 |
| C59 first paint | 4 |
| C30–C31 memory | 28 |
| C39 G3 and verification | 20 |
| Durability | 3 |
| Core network | 5 |
| C23 writer and verification | 11 |
| C52–C55 lifecycle | 12 |
| C47 static and verification | 14 |
| C61 build and verification | 13 |
| C62 OCI acceptance evidence and manifest | 21 |
| Final Core/Full validation | 17 |
| **Total** | **295** |

The final validation report records passing frozen install, typecheck, tests, Core build and audit, Full build, and Chromium/WebKit acceptance runs. Its initial Core Chromium attempt exposed an obsolete `/mobile/main.js` assertion; the trace and error context are retained as diagnostics, followed by the focused corrected scenario and successful full retry. See [`CORE-64-FINAL-VERIFICATION.md`](../../CORE-64-FINAL-VERIFICATION.md) and the final-validation rows in the index for commands and hashes.

## Scope and limits

This archive contains only explicitly named synthetic captures, their selected verification logs, and tracked evidence manifests. `diagnostic: true` rows preserve failed, interrupted, superseded, or otherwise diagnostic attempts; they are not selected as primary evidence for comparative claims. The final verification manifest records hashes for 142 generated files, but the archive includes only that manifest, not compiled outputs or package distributions. No pnpm store, browser state/cache, or OCI image is included.

Two C39 natural-visibility cases were not rerun in the final browser matrix because it did not configure native headful visibility; C39 retains its separately executed natural headful comparison in the [result ledger](../../CORE-64-RESULTS.md). This archive does not claim native Japanese IME coverage or long-idle/soak coverage. C62 acceptance records are present, but this tar is not an OCI image or hosted deployment. The archive selection is the named evidence for the campaign, not a claim that every candidate disposition had a separate performance run; dispositions remain in [`CORE-64-RESULTS.md`](../../CORE-64-RESULTS.md).

## Packaging and verification

The existing [`artifacts.mjs`](../../../../scripts/performance/artifacts.mjs) packer was used. It generated sorted USTAR with fixed ownership/modes/timestamps and gzip level 6, zero mtime, and OS byte 255. Verification checked the tar hash and member list before extraction, then checked each compressed member and its decompressed source hash.

Commands from the packaging run:

```sh
node scripts/performance/artifacts.mjs pack \
  /data/scriptorium-core64-final-archive-input-20261021.json \
  /data/scriptorium-core64-archive-stage-evidence-20261021/sources-final \
  /data/scriptorium-core64-final-archive-20261021 \
  https://github.com/yohn-jp/scriptorium/releases/download/perf-core64-2026-10-21/core64-2026-10-21.tar

node scripts/performance/artifacts.mjs verify-archive \
  /data/scriptorium-core64-final-archive-20261021/INDEX.json \
  /data/scriptorium-core64-final-archive-20261021

mkdir /data/scriptorium-core64-final-archive-extracted-20261021
cp /data/scriptorium-core64-final-archive-20261021/core64-2026-10-21.tar \
  /data/scriptorium-core64-final-archive-extracted-20261021/core64-2026-10-21.tar
tar -xf /data/scriptorium-core64-final-archive-extracted-20261021/core64-2026-10-21.tar \
  -C /data/scriptorium-core64-final-archive-extracted-20261021
node scripts/performance/artifacts.mjs verify \
  /data/scriptorium-core64-final-archive-20261021/INDEX.json \
  /data/scriptorium-core64-final-archive-extracted-20261021
```

The recorded results were `Verified archive SHA-256 5be0a43a560f9bf601f50fc5e76817e3282e3238698fbf106898ac63973b119f` before extraction and `Verified 295 artifacts and archive` afterward. The tar listing contained exactly the `raw/` directory plus the 295 indexed members, with no additional entries. The archive was subsequently published and independently downloaded as recorded below.

## Publication and download verification

The coordinator published [perf-core64-2026-10-21](https://github.com/yohn-jp/scriptorium/releases/tag/perf-core64-2026-10-21) at `2026-10-20T18:56:35Z`. The tag targets `e0e0d5a9695091729240cb09acb1c3f121cf96be`, which contains the frozen INDEX. Later completion edits change documentation only.

| Uploaded asset | GitHub asset ID | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| [core64-2026-10-21.tar](https://github.com/yohn-jp/scriptorium/releases/download/perf-core64-2026-10-21/core64-2026-10-21.tar) | 660192815 | 16,066,560 | `5be0a43a560f9bf601f50fc5e76817e3282e3238698fbf106898ac63973b119f` |
| [INDEX.json](https://github.com/yohn-jp/scriptorium/releases/download/perf-core64-2026-10-21/INDEX.json) | 660192819 | 185,247 | `33a6328e84efd918bc97f448dc92614a923c909c8329e94669d8a14b0882add3` |

Both assets were downloaded through `gh release download` into `/data/scriptorium-core64-published-download-20261021`. Against the checked-in INDEX, `artifacts.mjs verify-archive` passed before extraction, then `artifacts.mjs verify` reported `Verified 295 artifacts and archive` after extraction. The downloaded INDEX SHA-256 also exactly matches the checked-in file and GitHub’s asset digest.

The original temporary C05 public-flow runner was not retained (its recorded SHA remains); the render-hook reconstruction is explicitly labeled reconstructed. C59’s first partial FCP rows were overwritten and only their documented summaries remain. Those limits are not repaired by this archive. Existing Wave 0/Wave 1 published archives remain separate and unchanged.
