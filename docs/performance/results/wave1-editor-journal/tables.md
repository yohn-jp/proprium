# Wave 1 Editor / Journal measurements

All timing values are milliseconds. Each browser capture used 20 key samples; p99 is the maximum for n=20. Input timing is the canonical `keydown` (`key === "a"`) frame-opportunity cohort from `summarizeBrowser()`.

## 1 MiB input phase

| Capture | Typing p50 / p95 / p99 | React commits | Long Tasks n / p95 | Strict writes n / p50 / p95 / p99 | IDB reads / returned rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| Wave 0 base | 596.2 / 641.0 / 645.5 | 56 | 63 / 637 | 22 / 98.4 / 218.3 / 2962.6 | 74 / 93 |
| Wave 0 base repeat | 575.6 / 663.1 / 694.5 | 58 | 64 / 615 | 23 / 115.3 / 200.5 / 2961.9 | 77 / 97 |
| C01 repeat | 579.4 / 599.1 / 603.2 | 57 | 64 / 605 | 22 / 90.9 / 219.7 / 2748.4 | 74 / 93 |
| C01 final | 592.6 / 622.9 / 634.8 | 57 | 63 / 607 | 22 / 101.8 / 265.5 / 2634.3 | 74 / 93 |
| C04 final | 513.2 / 536.7 / 547.4 | 92 | 73 / 531 | 22 / 144.3 / 673.8 / 686.9 | 74 / 93 |
| C13 final | 521.8 / 551.1 / 620.7 | 100 | 77 / 562 | 23 / 151.6 / 238.0 / 1846.2 | 31 / 28 |

Strict-write counts reflect the actual 350 ms autosave schedule and are not fixed-rate per-key comparisons. Read and returned-row counts are direct harness counters within the input phase.

## C04 to C13 by input size

| Manuscript | C04 typing p50 / p95 / p99 | C13 typing p50 / p95 / p99 | React commits C04 → C13 | IDB reads / returned rows C04 → C13 |
| --- | ---: | ---: | ---: | ---: |
| 1 KiB | 8.0 / 9.0 / 11.9 | 8.1 / 9.0 / 11.2 | 15 → 15 | 8 / 3 → 4 / 1 |
| 100 KiB | 51.6 / 56.8 / 59.2 | 50.6 / 56.2 / 58.0 | 11 → 11 | 6 / 5 → 2 / 1 |
| 1 MiB | 513.2 / 536.7 / 547.4 | 521.8 / 551.1 / 620.7 | 92 → 100 | 74 / 93 → 31 / 28 |

## CPU and memory boundaries

| Capture | TaskDuration delta seconds | ScriptDuration delta seconds | End-of-input renderer RSS bytes | End-of-input JS heap bytes | After 35s visible-idle renderer RSS bytes | After idle JS heap bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Wave 0 base | 35.275767 | 28.297072 | 5,475,459,072 | 118,388,980 | 409,309,184 | 38,520,820 |
| Wave 0 base repeat | 34.423725 | 27.267360 | 5,461,630,976 | 145,502,504 | 416,329,728 | 38,630,484 |
| C01 repeat | 32.735211 | 26.960254 | 6,532,657,152 | 319,931,728 | 407,097,344 | 38,491,148 |
| C01 final | 33.300216 | 26.996541 | 6,652,149,760 | 310,988,336 | 419,766,272 | 38,510,244 |
| C04 final | 33.012280 | 26.430416 | 6,382,071,808 | 237,249,808 | 405,692,416 | 38,704,812 |
| C13 final | 33.340403 | 26.739245 | 4,304,035,840 | 154,861,484 | 395,542,528 | 37,398,872 |

The CDP CPU deltas compare the `input.102400` and `input.1048576` endpoint snapshots. They include scene-open and cursor setup before the latter phase, so pure phase-local CPU is `NOT_CHECKED`. RSS is an endpoint snapshot, not a continuous peak. Post-idle values are similar across captures; the C01 and C04 end-of-input memory increases remain a real observed tradeoff in these one-worker captures.
