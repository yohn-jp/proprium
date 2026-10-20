# Core 64 payload boundary probe

**Scope:** focused C48/C57 API scratch attachment boundary and persistence evidence. The fix replaces recursive-regex validation with a bounded linear scan while preserving canonical round-trip validation and existing size caps. It does not change Core or contract limits. C30's Git `execFile` output boundary remains a separate G2 memory-worker measurement.

**State:** the initial baseline exposed a `RangeError` for valid 6/8 MiB attachment JSON. The bounded validator fix passed focused API tests and the same six-case real API/Core cohort. Final verdict: `DECLINED` streaming/blob expansion; keep the existing limits. Both the original [baseline failure](results/core64-payload/payload-2026-10-20T17-26-14-731Z-3239566.json) and [fixed candidate result](results/core64-payload/payload-2026-10-20T17-35-15-272Z-3362716.json) are retained.

## Boundaries under test

The [API JSON parser](../../packages/api/src/server.ts#L51) allows 12 MiB; the [scratch attachment cap](../../packages/api/src/server.ts#L54) allows 8 MiB raw bytes; and [`assertChangeOperation`](../../packages/contracts/src/index.ts#L395) limits combined write content to 8 MiB. A 6 MiB raw attachment encodes to exactly 8 MiB base64, before generated Markdown. An 8 MiB raw attachment encodes to 11,184,812 base64 bytes and its synthetic JSON body remains under the HTTP body limit, but its operation content exceeds the 8 MiB write cap. A 10 MiB raw attachment encodes to 13,981,016 bytes before JSON metadata, so the API body limit should reject it before Core. A 32 MiB raw attachment encodes to 44,739,244 bytes and is also rejected at HTTP ingress.

The 32 MiB HTTP case does **not** exercise Core's 32 MiB Git `execFile` output buffer ([Core helper](../../packages/core/src/index.ts#L867)). That bound applies to a different subprocess output path and belongs to G2's separate C30 memory-worker evidence ([G2 duplicate-contract boundary](CORE-64-G2-PLAN.md#duplicate-contract-boundaries)). This probe establishes nothing about that worker result or the Git output boundary.

| Scenario | Expected API result | Expected real Core calls | Persistence assertion |
| --- | --- | --- | --- |
| 4-byte accepted attachment plus Markdown | `201` | `propose=1`, `approve=1`, `checkpoint=1` | One proposal and pending checkpoint; Markdown and binary exist in checkpoint view only; exact binary byte count/hash and API receipt match Core's checkpoint receipt. |
| 6 MiB raw attachment plus Markdown | `400 invalid_change_operation` | `propose=1`, `approve=0`, `checkpoint=0` | Proposal count, pending checkpoint count, remote files, and checkpoint files unchanged; rejection occurs before Core proposal journal persistence. |
| 8 MiB raw attachment plus Markdown | `400 invalid_change_operation` | `propose=1`, `approve=0`, `checkpoint=0` | Same unchanged-state assertions; distinguishes raw route allowance from operation content allowance. |
| 10 MiB raw JSON request | `413 BODY_TOO_LARGE` | all zero | Rejected before Core mutation methods; state unchanged. |
| 32 MiB raw JSON request | `413 BODY_TOO_LARGE` | all zero | Rejected at the HTTP body limit; does not measure Core Git output buffering. |
| 6 MiB declared upload, partial JSON body then client abort | response or transport result recorded | all zero | Server observes abort; no proposal, checkpoint, or scratch path appears. The request body is intentionally incomplete, so it must not enter the scratch handler. |

## Executed cohort

The baseline run completed all six cases on frozen C09 runtime `ffd02739`, pinned to CPUs 8–11, while other measurement lanes were active. Its 6/8 MiB valid requests returned `500 INTERNAL_ERROR` with `RangeError: Maximum call stack size exceeded` in `createScratch` base64 validation. They made no Core mutation calls and caused no state delta; that was safe from partial persistence but failed the rejection contract. The original `FAIL` evidence remains linked above.

The targeted fix is [candidate commit `effa6d14`](../../commit/effa6d14429d2e86e0a49ea703fd7def6a2bca6c): a linear ASCII alphabet/padding scan followed by the existing Buffer decode/re-encode equality check, which preserves canonical padding and pad-bit rejection. No size cap or contract changed. The task worktree used `pnpm install --offline --frozen-lockfile` (pnpm 12.10.1, Node v24.21.0), then `pnpm --filter @scriptorium/api... build`; this built contracts, module-runtime, Core, and API from the candidate source. The candidate runtime manifest hash is `31e3c3285dfb1b356ebc20e538de717d506966f085ac543932a1dd8b56e6667b` over 63 files / 1,793,696 bytes. Its source commit is `f4bdae88`; the candidate API source tree is `8149908e137ec74b599fc36ff7f6073e3c7928f3`. The fixed run verifies those package artifacts before spawning workers.

Four focused API tests passed: existing small attachment behavior, large canonical one-padding input and byte preservation, large invalid alphabet plus noncanonical/misplaced/missing padding rejection, and an 8 MiB + 1 byte raw-cap rejection while the JSON body remains under 12 MiB. The fixed six-case cohort then passed:

| Case | API result | Core calls | State / binary result |
| --- | --- | --- | --- |
| 4-byte accepted | `201` | propose/approve/checkpoint once each | Exact 4-byte hash and persisted receipt match; two files appear only in checkpoint view. |
| 6 MiB attachment | `400 invalid_change_operation` | propose once; no approve/checkpoint | No proposal, pending checkpoint, or scratch file added. |
| 8 MiB attachment | `400 invalid_change_operation` | propose once; no approve/checkpoint | No proposal, pending checkpoint, or scratch file added. |
| 10 MiB JSON | `413 BODY_TOO_LARGE` | none | No state change. |
| 32 MiB JSON | `413 BODY_TOO_LARGE` | none | No state change; does not exercise Core's separate Git buffer limit. |
| Partial 6 MiB upload abort | client transport reset | none | Request abort observed; no state change. |

Both runs used only task-generated synthetic remotes; the fixed run confirmed source HEAD `7bc240abb70bd6c506a8645a66a3128fddd71842` unchanged before and after every case. In the fixed run, absolute per-worker peak RSS was 115,896 KiB (small accepted), 160,720 KiB (6 MiB), 167,988 KiB (8 MiB), 116,272 KiB (10 MiB), 116,520 KiB (32 MiB), and 120,304 KiB (abort). Latencies are observational only: the worker was pinned to CPUs 8–11 while the Git writer (4–7), C30 memory worker (0–3), and OCI base pull (12–15) overlapped in wall time. No adoption or comparative performance claim is based on timing or RSS differences.

**Verdict:** `DECLINED` streaming/blob expansion for C48/C57. The real route preserves binary bytes and receipts for the accepted path, rejects operation-sized payloads before proposal persistence, rejects oversized JSON before Core, and leaves no partial state on abort. Keep the 8 MiB operation and 12 MiB JSON limits. Reopen only for a named consumer plus same-fixture evidence of material benefit and a design that preserves approval, snapshot, revision, receipt, and recovery guarantees.

All large payloads use deterministic synthetic bytes. Each scenario runs in a fresh Node API/Core worker with an isolated Core data directory and the same generated bare remote. The [probe runner](../../scripts/performance/core64-payload-probe.mjs) reuses [`dataset.mjs`](../../scripts/performance/dataset.mjs) to generate its own ten-file short synthetic fixture; it never uses G0's canonical remote. It records the generated bare remote's `refs/heads/main` before the cases and after each case, and fails a sample if that seed commit changes. Each request is delegated to the [real API/Core worker](../../scripts/performance/core64-payload-worker.mjs). A delegating wrapper counts calls to the real Core `propose`, `approve`, and `checkpoint` methods; it does not substitute a store double.

The source-level order is [Core proposal validation before journal write](../../packages/core/src/index.ts#L3614) and [scratch `propose` → `approve` → `checkpoint`](../../packages/api/src/server.ts#L1163). The probe's before/after state assertions exercised that actual route and store sequence.

The worker samples current RSS and `process.resourceUsage().maxRSS` immediately before the scratch request and after response completion/abort. Each scenario has its own worker process, so the recorded peak is per scenario and includes that worker's API/Core startup and repository registration. Client request-buffer memory is in the separate probe process and is not included in the server Node RSS value. Response status/error code, encoded request bytes, call counts, proposal states, pending checkpoint receipts, and remote/checkpoint scratch paths are saved with the measurement. Post-request pending-checkpoint counts come from Core's [local durability census](../../packages/core/src/index.ts#L2579), which recomputes local receipts without a network fetch.

## Focused execution

The baseline uses the uninstrumented six-root C09 runtime at [`ffd02739`](results/core64-resize/runtime-manifest.json). The fixed run instead uses the task worktree's candidate package builds and records a SHA-256 inventory of contracts, module-runtime, Core, and API dist before requests. This keeps the original failure evidence tied to its exact runtime and the corrected result tied to its own built artifacts.

```sh
SCRIPTORIUM_PERF_RUNTIME_ROOT="$PWD" node scripts/performance/core64-payload-probe.mjs --verify-runtime
SCRIPTORIUM_PERF_RUNTIME_ROOT="$PWD" node scripts/performance/core64-payload-probe.mjs --small-only
taskset -c 8-11 timeout 360s env TMPDIR=/data \
  SCRIPTORIUM_PERF_RUNTIME_ROOT="$PWD" CORE64_G0_LEASE=released \
  SCRIPTORIUM_PERF_CPUSET=8-11 SCRIPTORIUM_PERF_HARD_TIMEOUT_SECONDS=360 \
  'SCRIPTORIUM_PERF_CONCURRENT_LANES=Git writer CPU 4-7;C30 memory worker CPU 0-3;OCI base pull CPU 12-15' \
  node scripts/performance/core64-payload-probe.mjs --with-heavy
```

`--small-only` exercises the accepted four-byte route path. `--with-heavy` is refused unless `CORE64_G0_LEASE=released` is set after explicit release; it runs the 6/8/10/32 MiB cases and partial-body abort sequentially. For the corrected run, `SCRIPTORIUM_PERF_RUNTIME_ROOT` must point to this committed, clean-source candidate worktree; the runner verifies the package source commit and hashes each candidate dist file before making requests. It writes a timestamped JSON result under `docs/performance/results/core64-payload/`. Temporary fixture and Core data directories are removed after each run. The output directory holds only synthetic probe evidence.

Preparation and cohort checks:

```text
node --check scripts/performance/core64-payload-probe.mjs      PASS
node --check scripts/performance/core64-payload-worker.mjs     PASS
node scripts/performance/core64-payload-probe.mjs --plan      PASS
SCRIPTORIUM_PERF_RUNTIME_ROOT=... node scripts/performance/core64-payload-probe.mjs --verify-runtime PASS; ffd02739, pinned manifest SHA-256, all 85 files / 5,095,497 bytes, API/contracts source trees match
`pnpm install --offline --frozen-lockfile` in the task worktree      PASS; pnpm 12.10.1, 348 packages reused, no downloads
`pnpm --filter @scriptorium/api... build`                            PASS; contracts/module-runtime/Core/API
focused API server test pattern                                      PASS; 4 tests, 0 failures
candidate `--verify-runtime`                                         PASS; 63 artifact hashes / 1,793,696 bytes
fixed six-case cohort on CPUs 8–11                                  PASS; all cases accounted for, source remote unchanged
```

The focused API test command was:

```sh
taskset -c 8-11 timeout --signal=TERM --kill-after=10s 180s env TMPDIR=/data \
  node --test --test-name-pattern='large canonical base64|malformed large base64|one byte over the raw cap|stores scratch text' \
  packages/api/dist/server.test.js
```

The canonical typecheck, full test suite, Core-profile build, and `audit:core` were subsequently run against the rebased candidate and all passed; see the [verification record](results/core64-payload/verification.md). The full-profile, browser, and OCI combined checks remain part of central verification. No size contract or Core code changed.

## Decision rule

The initial `500` is retained as the reason for the focused validator fix; it is not counted as a passing rejection. After the linear validator, the real route met the exact binary, receipt, operation rejection, HTTP cap, and no-partial-persistence assertions on the same fixture. The final C48/C57 proposal is **DECLINED** for streaming/blob expansion; the current 8 MiB operation and 12 MiB JSON limits remain.
