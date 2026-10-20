# USTAR filename compatibility checkpoint — 2026-10-21

The original [`partial-index.json`](partial-index.json) and its 278 rows are preserved unchanged. [`ustar-partial-index.json`](ustar-partial-index.json) is a separate schema-2 inventory copy for later packaging; it keeps `selectionComplete: false` and `archivePreparationStatus: partial-not-final`.

The existing [`artifacts.mjs`](../../../../scripts/performance/artifacts.mjs) packer writes `raw/<sourceFile>.gz` members using GNU tar `--format=ustar`. USTAR allows at most 100 bytes in that filename component. Only the two entries below exceeded that bound. For each, the replacement is generated deterministically as `lifecycle-${SHA256(UTF8(sourcePath)).slice(0, 16)}-${basename(sourcePath)}`. All names are ASCII, so byte and character counts match.

| Original staged source name | Old component bytes | USTAR-compatible source name | New component bytes | Source SHA-256 |
| --- | ---: | --- | ---: | --- |
| `lifecycle__results-latecallback-retry2__core64-lifecycle.host.acce-eb369-l-into-the-old-author-scope-chromium__trace.zip` | 123 | `lifecycle-8453983b530c4ce8-trace.zip` | 39 | `77556205b49a43b47f1583b49f98ab4942fa44ee09fb597cb7a854cf3a7f8b3e` |
| `lifecycle__results-latecallback-retry2__core64-lifecycle.host.acce-eb369-l-into-the-old-author-scope-chromium__error-context.md` | 130 | `lifecycle-d14bcadffcd0c9ce-error-context.md` | 46 | `37908aad2372c71e47c7ba9d0165c04a0ae3a41fdc3e71057d857a7a38ad4387` |

The replacement source files were copied byte-for-byte into the existing authorized source root, `/data/scriptorium-core64-archive-stage-evidence-20261021/sources-final`. The original staged files remain intact. The final inventory changes only `sourceFile` and `file` for these two rows; `sourcePath`, provenance, diagnostic status, source bytes/SHA, and deterministic gzip bytes/SHA remain identical. All other 276 artifact rows are unchanged. The maximum filename component in the USTAR-compatible index, including `.gz`, is 71 bytes; all 278 source names and archive members are unique.

This prepares the names only. It did not create gzip members or a tar, and it did not invoke `artifacts.mjs pack`. The final browser-validation handoff is still pending, so the USTAR-compatible inventory remains partial and is not yet the final archive selection.
