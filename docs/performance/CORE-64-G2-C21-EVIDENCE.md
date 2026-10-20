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

## Validation and raw artifacts

Using the frozen offline PNPM store, install reused 348 packages with zero downloads. The contracts build, Core build, and focused modified Core reader test passed (1/1). `git diff --check` passed. Full workspace typecheck/test/build/audit plus browser and OCI checks remain pending the verification batch.

Raw JSON and one-off harnesses are preserved in `/data/c64-g2-supplement-20261021/`: the four `*-first-read-*.json` files, `large-10k-{before,after}.json`, `reader-first-read-n20.mjs`, and `deep-10k-sweep.mjs`. These generated synthetic evidence files are local task artifacts, not repository fixtures.
