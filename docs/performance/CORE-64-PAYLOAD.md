# Core 64 payload boundary probe

**Scope:** focused C48/C57 API scratch attachment boundary and persistence evidence. This does not modify the API, Core, or contract limits. C30's Git `execFile` output boundary remains a separate G2 memory-worker measurement.

**State:** the bounded C48/C57 cohort executed under the released lease. The result is `FAIL`; expansion remains `NOT_CHECKED` because the 6/8 MiB requests trigger a `RangeError` in API base64 validation. No production code changed. The complete [raw result](results/core64-payload/payload-2026-10-20T17-26-14-731Z-3239566.json) records the runtime manifest, per-case persistence checks, RSS, and run context.

## Boundaries under test

The [API JSON parser](../../packages/api/src/server.ts#L51) allows 12 MiB; the [scratch route](../../packages/api/src/server.ts#L1089) allows 8 MiB raw attachment bytes; and [`assertChangeOperation`](../../packages/contracts/src/index.ts#L395) limits combined write content to 8 MiB. A 6 MiB raw attachment encodes to exactly 8 MiB base64, before generated Markdown. An 8 MiB raw attachment encodes to 11,184,812 base64 bytes and its synthetic JSON body remains under the HTTP body limit, but its operation content exceeds the 8 MiB write cap. A 10 MiB raw attachment encodes to 13,981,016 bytes before JSON metadata, so the API body limit should reject it before Core. A 32 MiB raw attachment encodes to 44,739,244 bytes and is also rejected at HTTP ingress.

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

The released run completed all six cases under a six-minute hard cap. The worker was pinned to CPUs 8–11 with `taskset`; the Git writer (4–7), C30 memory worker (0–3), and OCI base pull (12–15) overlapped in wall time. Treat latency as observational only; this run supports no adoption or comparative performance claim.

The 4-byte case returned `201`, called `propose`/`approve`/`checkpoint` once each, stored the exact binary bytes and SHA-256 in the checkpoint view, matched the API receipt to the persisted receipt, and left the remote seed unchanged. The 10 MiB and 32 MiB JSON cases returned `413 BODY_TOO_LARGE` with zero Core calls and no state delta. The incomplete upload aborted with zero Core calls and no state delta.

The 6 MiB and 8 MiB requests were below the 12 MiB JSON parser limit but returned `500 INTERNAL_ERROR`. The API logged `RangeError: Maximum call stack size exceeded` at the base64 validation regex in [`createScratch`](../../packages/api/src/server.ts#L1108). Neither reached `propose`; proposal/checkpoint counts and scratch paths were unchanged. This proves those failures did not partially persist data, but it does not satisfy the expected deterministic operation-limit rejection. It is a validation-path failure, not evidence that larger or streamed uploads are safe.

The server's absolute peak RSS (including worker startup and fixture registration) was 114,692 KiB for the small accepted case, 211,084 KiB for 6 MiB, 221,772 KiB for 8 MiB, 115,372 KiB for 10 MiB, 142,356 KiB for 32 MiB, and 119,616 KiB for the aborted upload. The two failing operation-limit cases increased current RSS by about 39 MiB and 52 MiB. These are contended observations and do not establish a performance comparison.

**Verdict:** C48/C57 remain `NOT_CHECKED` for streaming/blob expansion. Keep the current 8 MiB operation and 12 MiB JSON limits. First restore a bounded, deterministic API rejection for the 6/8 MiB inputs, then rerun this same cohort before deciding whether to decline expansion. Do not treat the absence of partial persistence after a `500` as a passing rejection contract.

All large payloads use deterministic synthetic bytes. Each scenario runs in a fresh Node API/Core worker with an isolated Core data directory and the same generated bare remote. The [probe runner](../../scripts/performance/core64-payload-probe.mjs) reuses [`dataset.mjs`](../../scripts/performance/dataset.mjs) to generate its own ten-file short synthetic fixture; it never uses G0's canonical remote. It records the generated bare remote's `refs/heads/main` before the cases and after each case, and fails a sample if that seed commit changes. Each request is delegated to the [real API/Core worker](../../scripts/performance/core64-payload-worker.mjs). A delegating wrapper counts calls to the real Core `propose`, `approve`, and `checkpoint` methods; it does not substitute a store double.

The source-level order is [Core proposal validation before journal write](../../packages/core/src/index.ts#L3614) and [scratch `propose` → `approve` → `checkpoint`](../../packages/api/src/server.ts#L1144). The probe's before/after state assertions will exercise that actual route and store sequence.

The worker samples current RSS and `process.resourceUsage().maxRSS` immediately before the scratch request and after response completion/abort. Each scenario has its own worker process, so the recorded peak is per scenario and includes that worker's API/Core startup and repository registration. Client request-buffer memory is in the separate probe process and is not included in the server Node RSS value. Response status/error code, encoded request bytes, call counts, proposal states, pending checkpoint receipts, and remote/checkpoint scratch paths are saved with the measurement. Post-request pending-checkpoint counts come from Core's [local durability census](../../packages/core/src/index.ts#L2579), which recomputes local receipts without a network fetch.

## Focused execution

The probe binds to the uninstrumented six-root runtime built once for C09 at [`ffd02739`](results/core64-resize/runtime-manifest.json). Its API and contracts source trees must match the probe checkout exactly; all six artifact roots and every manifest SHA-256/byte count are verified before any request. This avoids using stale local `dist` files or rebuilding during the measurement. The frozen Core contains its documented reader-side C09-era changes; the scratch API and contracts sources match G0's `a1587e78`, and Core proposal/approval/checkpoint mutation code is unchanged across those source commits. G0 reports that frozen install, typecheck, full tests, Core-profile build, and `audit:core` passed on `a1587e78`; its verification log is pending its report commit. Reuse that evidence rather than rerunning the full suite.

```sh
SCRIPTORIUM_PERF_RUNTIME_ROOT=/home/sophia/src/scriptorium-c64-resize \
node scripts/performance/core64-payload-probe.mjs --verify-runtime
SCRIPTORIUM_PERF_RUNTIME_ROOT=/home/sophia/src/scriptorium-c64-resize \
node scripts/performance/core64-payload-probe.mjs --small-only
SCRIPTORIUM_PERF_RUNTIME_ROOT=/home/sophia/src/scriptorium-c64-resize \
CORE64_G0_LEASE=released node scripts/performance/core64-payload-probe.mjs --with-heavy
```

`--small-only` exercises the accepted four-byte route path. `--with-heavy` is intentionally refused unless `CORE64_G0_LEASE=released` is set after explicit release; it runs the 6/8/10/32 MiB cases and the partial-body abort sequentially. The runner requires `SCRIPTORIUM_PERF_RUNTIME_ROOT` to point at the pinned C09 tree and verifies its frozen manifest and API/contracts source binding before it generates a fixture. It writes a timestamped JSON result under `docs/performance/results/core64-payload/`. Temporary fixture and Core data directories are removed after each run. The output directory holds only synthetic probe evidence.

Preparation and cohort checks:

```text
node --check scripts/performance/core64-payload-probe.mjs      PASS
node --check scripts/performance/core64-payload-worker.mjs     PASS
node scripts/performance/core64-payload-probe.mjs --plan      PASS
SCRIPTORIUM_PERF_RUNTIME_ROOT=... node scripts/performance/core64-payload-probe.mjs --verify-runtime PASS; ffd02739, pinned manifest SHA-256, all 85 files / 5,095,497 bytes, API/contracts source trees match
env -u CORE64_G0_LEASE node scripts/performance/core64-payload-probe.mjs --with-heavy   REFUSED as intended before the granted run
taskset -c 8-11 timeout 360s ... --with-heavy   COMPLETED; aggregate result FAIL, two createScratch regex stack overflows
```

No package install/build or test suite was run for this evidence cohort. The accepted case exercised real Core mutations; the remaining cases made no Core mutation calls. No production-path test file or production source was edited during this evidence-only commit.

## Decision rule

If the accepted small path preserves exact binary bytes and receipt, the 6/8 MiB cases reject before proposal persistence with no state delta, the 10/32 MiB cases fail at the HTTP parser with no Core mutation calls, and the partial upload abort leaves no state, propose **DECLINED** for streaming/blob expansion in C48/C57. Keep the current 8 MiB operation and 12 MiB JSON limits. Reopen only for a named consumer plus same-fixture evidence of a material gain and a bounded design that preserves the current approval, snapshot, revision, receipt, and recovery guarantees. Unexpected status, any partial state change, missing build/runtime dependency, or unavailable lease remains `NOT_CHECKED` until resolved; do not infer support for larger files from a timeout or an unrelated Core 32 MiB worker result.
