# Core 64 Journal probe — C14–C16

This bounded probe measured the current Core journal implementation without changing its schema or production code. The proposals below are evidence-based dispositions for review; they do not update the canonical C14–C16 ledger.

## Method and source

The probe served the actual `BrowserJournal` module from the frozen Core runtime through Vite and used Chromium's native IndexedDB. The inline probe page was passed through Vite's `transformIndexHtml`, so `@scriptorium/contracts` resolved to the frozen contracts build. All fixtures were synthetic and isolated in fresh browser contexts. Operation records were created with valid contract identities; the C15 occupancy fixtures used checkpointed same-document records, and C16 seeded 1,000 entries plus 1,000 proposals across ten repositories.

Each timing has 20 samples. Percentiles use nearest rank `ceil(p*n)`: p95 is rank 19 and p99 is the maximum (rank 20). No samples were dropped. Record text used repeated four-byte UTF-8 Unicode scalars to produce exact 100 KiB and 1 MiB fields. The full records intentionally contain independent `text`, `baseText`, and `operation.writes[0].content` values.

The frozen runtime was `/data/scriptorium-core64-worktrees/g0`, git head `80ab121ad08b2c5f5957e3405eed511762fb1747`, with `journal.ts` SHA-256 `5392cf4dcce0e0bbdd19fabaea683903334e157f3cc3d385552cf1f90ab024d9`. Chromium was `155.0.8059.79`; Node was `v24.21.0`. The probe script SHA-256 is `6fe2be822dcc1d8880da378647aa125112755c9cba4813379c66890a482089dc`; the HTML SHA-256 is `098165d53cde430d32c5d9d92d19d62376c83306050805a8ef846f22e0148f8a`.

The exact run used the G0 frozen install and kept temporary files, Playwright profiles, and Vite cache under `/data`:

```sh
TMPDIR=/data/scriptorium-core64-journal-tmp \
SCRIPTORIUM_CORE64_RUNTIME_ROOT=/data/scriptorium-core64-worktrees/g0 \
SCRIPTORIUM_CORE64_CACHE_DIR=/data/scriptorium-core64-journal-tmp/vite-cache-transform \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
node scripts/performance/core64-journal.mjs \
  /data/scriptorium-core64-g1-journal-20261020T145916Z/raw-measurement-transformed.json 20
```

The complete 20-sample capture is [raw.json](results/core64-journal/raw.json). Its SHA-256 is `9ab98b4fd57a45cb313c1cb65b1d8f3080ee73469847f552fd6d1310f31c7c4b`; the compact machine-readable results are [summary.json](results/core64-journal/summary.json). Two earlier startup failures are retained outside the repository under `/data/scriptorium-core64-g1-journal-20261020T145916Z/FAILED_PRE_MEASUREMENT.json` and `FAILED_PROBE_NO_READY.json`. Both contain zero measurements; neither contributes to this report.

## C14 — duplicated journal payload and restore

Exact restore passed for all 20 reads at both sizes. Each read used one readonly transaction and one `operations.documentKey.getAll` request, returning exactly one record. The latency table reports end-to-end `getDocument` p50/p95 and request p95 in milliseconds.

| Target UTF-8 bytes per field | Combined logical bytes in `text` + `baseText` + write content | JSON record UTF-8 bytes | `getDocument` p50 / p95 | Indexed request p95 |
| ---: | ---: | ---: | ---: | ---: |
| 102,400 | 307,200 | 308,892 | 2.9 / 7.4 ms | 1.7 ms |
| 1,048,576 | 3,145,728 | 3,147,428 | 19.6 / 20.4 ms | 10.1 ms |

Each 100 KiB field contained 51,200 UTF-16 code units / 25,600 code points; each 1 MiB field contained 524,288 UTF-16 code units / 262,144 code points. `navigator.storage.estimate()` reported 73,728 origin bytes both immediately before and after each record put, a zero-byte observed delta. It reported the same 73,728 bytes after opening the empty database. This origin-wide estimate did not resolve record-sized differences and is not evidence of physical IndexedDB bytes or write durability cost.

**Proposal: retain the current full fields; do not adopt a versioned payload rewrite from this evidence.** The logical and JSON sizes confirm that records carry roughly three copies of manuscript content, but no physical per-record saving was measured. A digest, compressed payload, or delta would add migration and recovery obligations without a demonstrated storage benefit. C14 remains measured but unresolved on physical record bytes; transaction-failure, process-loss, and old-schema migration scenarios are `NOT_CHECKED` because this probe made no schema change.

## C15 — strict `putLatestDraft` scaling and generation isolation

Each sample successfully stored a newer owner draft inside exactly one `readwrite` transaction with `durability: "strict"`. Each transaction performed exactly one `operations.documentKey.getAll`, returning the full same-document occupancy shown below.

| Existing checkpointed rows for the same document and author | End-to-end / strict transaction p50 | End-to-end / strict transaction p95 | End-to-end / transaction p99 (maximum) | Indexed rows returned |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1.8 / 1.7 ms | 2.3 / 2.3 ms | 2.5 / 2.5 ms | 1 |
| 100 | 8.4 / 8.4 ms | 10.0 / 10.0 ms | 10.8 / 10.7 ms | 100 |
| 1,000 | 76.5 / 76.5 ms | 82.8 / 82.8 ms | 84.4 / 84.4 ms | 1,000 |

Stale generation was denied; an equal-generation, different-operation proposal was denied; a foreign author's generation 9,999 did not block an owner generation 1 draft and the foreign record remained intact. These are direct recovery-preservation checks, not a concurrent multi-tab test.

**Proposal: keep the strict transaction and current index for now; record the 1,000-row case as a follow-up trigger.** The stress occupancy costs 82.8 ms p95 and reads all 1,000 same-author checkpointed rows, but no alternative query/index was measured, and these synthetic counts do not establish a representative production distribution. Do not trade away strict completion or generation isolation. A schema/index candidate would need its own before/after comparison plus old-schema and interrupted-migration recovery proof.

## C16 — full and repository-scoped inventory

Each `getAllEntries` and `getAllProposals` sample used one readonly transaction and one store-level `getAll`, returning all 1,000 rows. Serialized JSON array sizes are shown as UTF-8 serialization sizes, not IndexedDB bytes or network transfer.

| Inventory | Rows | JSON array UTF-8 bytes | p50 / p95 end-to-end | p95 request | p99 (maximum) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `getAllEntries` | 1,000 | 2,245,143 | 80.5 / 86.7 ms | 71.9 ms | 86.8 ms |
| `getAllProposals` | 1,000 | 1,451,124 | 66.5 / 79.3 ms | 62.6 ms | 101.8 ms |

The `repositoryKey` scoped methods each returned exactly 100 owner rows for one repository, issuing one indexed request with 100 returned rows. No other repository or author rows leaked. The fixture contained 950 owner and 50 guest entries across ten repositories.

**Proposal: retain full inventory for explicit reconciliation and use the existing scoped methods for repository views; no schema change is indicated.** The measured full scan matches its all-repository purpose, while scoped reads already reduce a repository view to 100 indexed rows. A different startup path or user-visible inventory bottleneck was not measured, so no change to the global APIs is proposed.

## Verification and limits

The real Chromium/Vite probe completed with `status: complete`; both record sizes restored exact content, all C15 invariants held, and the C16 scope checks passed. `node --check` passed for the driver and extracted inline module, and `git diff --check` passed. No production code, journal schema, or migration was changed. Full workspace install/typecheck/test/build/audit and multi-tab, quota, crash, response-loss, old-schema migration, physical storage, and fsync checks are `NOT_CHECKED` for this measurement-only unit.
