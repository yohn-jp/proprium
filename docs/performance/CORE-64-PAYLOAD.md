# Core 64 payload boundary probe

**Scope:** focused C48/C57 API scratch attachment boundary and persistence evidence. This does not modify the API, Core, or contract limits. C30's Git `execFile` output boundary remains a separate G2 memory-worker measurement.

**State:** executable probe prepared on `perf/c64-g4`; only JavaScript syntax checks and `--plan` were run. No HTTP payload case or RSS measurement has run. Heavy cases remain gated on G0's explicit measurement-lease release.

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

All large payloads use deterministic synthetic bytes. Each scenario runs in a fresh Node API/Core worker with an isolated Core data directory and the same generated bare remote. The [probe runner](../../scripts/performance/core64-payload-probe.mjs) reuses [`dataset.mjs`](../../scripts/performance/dataset.mjs) to generate the existing ten-file short synthetic fixture, then delegates each request to the [real API/Core worker](../../scripts/performance/core64-payload-worker.mjs). A delegating wrapper counts calls to the real Core `propose`, `approve`, and `checkpoint` methods; it does not substitute a store double.

The source-level order is [Core proposal validation before journal write](../../packages/core/src/index.ts#L3614) and [scratch `propose` → `approve` → `checkpoint`](../../packages/api/src/server.ts#L1144). The probe's before/after state assertions will exercise that actual route and store sequence.

The worker samples current RSS and `process.resourceUsage().maxRSS` immediately before the scratch request and after response completion/abort. Each scenario has its own worker process, so the recorded peak is per scenario and includes that worker's API/Core startup and repository registration. Client request-buffer memory is in the separate probe process and is not included in the server Node RSS value. Response status/error code, encoded request bytes, call counts, proposal states, pending checkpoint receipts, and remote/checkpoint scratch paths are saved with the measurement. Post-request pending-checkpoint counts come from Core's [local durability census](../../packages/core/src/index.ts#L2579), which recomputes local receipts without a network fetch.

## Focused execution

The current G4 worktree has no `node_modules` or compiled package outputs. G0 reports that frozen install, typecheck, full tests, Core-profile build, and `audit:core` passed on runtime `a1587e78`; its verification log is pending its report commit. Reuse that evidence rather than rerunning the full suite. The small-only case does not carry the heavy payload and can validate the route independently; the heavy matrix must wait for G0's explicit release. Once dependencies are available, build only the probe's direct runtime dependencies:

```sh
pnpm install --frozen-lockfile
pnpm --filter @scriptorium/contracts build
pnpm --filter @scriptorium/module-runtime build
pnpm --filter @scriptorium/core build
pnpm --filter @scriptorium/api build
node scripts/performance/core64-payload-probe.mjs --small-only
CORE64_G0_LEASE=released node scripts/performance/core64-payload-probe.mjs --with-heavy
```

`--small-only` exercises the accepted four-byte route path. `--with-heavy` is intentionally refused unless `CORE64_G0_LEASE=released` is set after explicit release; it runs the 6/8/10/32 MiB cases and the partial-body abort sequentially. It writes a timestamped JSON result under `results/core64-payload/`. Temporary fixture and Core data directories are removed after each run. The output directory holds only synthetic probe evidence.

Preparation checks completed:

```text
node --check scripts/performance/core64-payload-probe.mjs      PASS
node --check scripts/performance/core64-payload-worker.mjs     PASS
node scripts/performance/core64-payload-probe.mjs --plan      PASS
env -u CORE64_G0_LEASE node scripts/performance/core64-payload-probe.mjs --with-heavy   REFUSED as intended; no fixture or request created
```

No HTTP request, Core operation, package install/build, test, or RSS sample has been run by this worker yet. The exact script assertions are the focused verification; no production-path test file or production source was edited.

## Decision rule

If the accepted small path preserves exact binary bytes and receipt, the 6/8 MiB cases reject before proposal persistence with no state delta, the 10/32 MiB cases fail at the HTTP parser with no Core mutation calls, and the partial upload abort leaves no state, propose **DECLINED** for streaming/blob expansion in C48/C57. Keep the current 8 MiB operation and 12 MiB JSON limits. Reopen only for a named consumer plus same-fixture evidence of a material gain and a bounded design that preserves the current approval, snapshot, revision, receipt, and recovery guarantees. Unexpected status, any partial state change, missing build/runtime dependency, or unavailable lease remains `NOT_CHECKED` until resolved; do not infer support for larger files from a timeout or an unrelated Core 32 MiB worker result.
