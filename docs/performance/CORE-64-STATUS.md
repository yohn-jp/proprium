# Core 64 status and recent activity evidence

This leaf covers C41, C42, and C45 from the fixed Core-64 goal. The branch starts at 53099848; the API source paths used here match the runtime tree at a1587e78. G0's post-W1 baseline is complete. Its current C02/C21 verification batch has the active workload slot, so this branch remains at probe preparation with no API measurement, test, or build run.

## Prepared probes

The C42 probe imports the built, real RecentActivityStore implementation and uses only generated private temporary directories, synthetic GitHub repository identities, and synthetic author scopes. It reports total upsert wall and CPU time, bounded operation samples, JSON parse/stringify time, state read and temporary-file write time/bytes, file and directory sync time/calls, rename time/calls, metadata filesystem calls, and /proc/self/io deltas. The cases are one upsert, a 100-write concurrent desktop/mobile burst for one author, and a 100-write concurrent burst across 100 author scopes. Each case restarts the store and checks representative owners plus a non-existent author. Instrumentation runs only in the probe process; no production timing hooks are added.

The C42 crash probe starts from a committed synthetic cursor, invokes the existing upsert primitive in a child, injects a half-record write into its private temporary file, and sends the parent a handoff before the child can sync or rename. The parent sends SIGKILL, starts a fresh store, verifies that the previous canonical cursor remains readable, performs another upsert, and verifies the restarted state again. This exercises the atomic replacement boundary with an intentionally partial temporary record.

The C41 probe starts the actual local API handler with signed runtime-control credentials, an in-memory fake Core store, and generated persistence rows. It verifies two remote observations per stable status request, confirms the persistence reader stays pinned to the first observation, records local synthetic request time for 1 and 100 rows, and changes the second observation in a controlled race to require an unknown persistence result. Those times describe a local synthetic fixture and include loopback HTTP, token verification, and the fake scan. Hosted GitHub and k3s status/reconcile measurements remain NOT_CHECKED because no authorized hosted fixture was supplied.

## C45 decision

The source has a narrow transport-to-handler path but one shared route and error boundary. In packages/api/src/server.ts, createServer constructs Fastify with logging disabled at line 566. handle derives path/method/query and performs early platform/status/health routing at lines 1441–1482, then applies hosted authentication, write permission, shutdown/quiesce admission, activity tracking, and request abort handling before the large route chain at lines 1535–1595 and onward. routeHandler at lines 2206–2235 counts requests and active work, awaits handle, calls the shared sendError for failures before headers, destroys a response after headers, and decrements counters in finally. Both Fastify root/wildcard routes point to routeHandler at lines 2236–2238; the historical Node server forwards requests to Fastify at lines 2240–2243.

This boundary means a route extraction must receive or recreate shared authentication, activity, abort, and error behavior. The C45 acceptance in CORE-64-GOAL.md requires route/path/contract/permission/error-serialization tests and a request p95 comparison for an affected route. The G3 plan allows a split only for a selected measured candidate that needs a narrow seam, with the shared authorization/error boundary retained. Current timing records completed requests by path and status; it has no direct dispatch span or route-handler call trace. The code size observation therefore does not establish runtime cost or a verification bottleneck. Verdict: defer extraction. No route timing is claimed. Reconsider only when direct traces or route-specific evidence attribute a meaningful cost or verification blocker to this boundary.

## Next measurement slot

Wait until the active C02/C21 verification batch releases the workload slot. The probes import built workspace output, so build only their direct workspace prerequisites first, in dependency order:

    pnpm --filter @scriptorium/contracts build
    pnpm --filter @scriptorium/module-runtime build
    pnpm --filter @scriptorium/core build
    pnpm --filter @scriptorium/api build

Then collect the bounded C41/C42 evidence and run the focused API contract suite:

    node scripts/performance/core64-status-authority.mjs docs/performance/results/core64-status/authority.json 20
    C64_STATUS_REPEATS=10 node scripts/performance/core64-status-store.mjs bench docs/performance/results/core64-status/store.json
    node scripts/performance/core64-status-store.mjs crash docs/performance/results/core64-status/crash-recovery.json
    pnpm --filter @scriptorium/api test

C64_STATUS_REPEATS may be set from 5 through 30; at 10 it records ten fresh single-write runs and ten 100-write runs for each burst case. The status probe sample count may be set from 5 through 100; at 20 it records 20 requests per fixture size (1 and 100 persistence rows) plus one changed-remote control. The crash probe performs one injected partial temporary write followed by one SIGKILL and restart. Outputs use only synthetic data in private temporary directories. The C42 phase wrappers and /proc/self/io deltas add measurement overhead; keep phase values as attribution evidence and compare only runs made with identical probes and environment. Record the source revision, host, Node version, raw distributions, focused test outcome, and limits after execution. Hosted status and k3s reconcile remain NOT_CHECKED without a real authorized fixture.

The probe prerequisites above and focused API test belong to the next bounded slot. After measurements, run the fixed whole gates for this code-bearing leaf: pnpm install --frozen-lockfile, pnpm typecheck, pnpm test, SCRIPTORIUM_PROFILE=core pnpm build, and pnpm audit:core. A future production persistence change would additionally require phase evidence that justifies it, retained private scope and bounded parsing, atomic replacement and sync ordering, crash/restart proof, and coordination with the G3 owner before editing recent-activity-store.ts.

## Current evidence state

- C41 paired remote observations and pinned reader are present in the implementation. Existing signed-status tests cover stable status; the prepared controlled probe checks observation count, pin, and unknown-on-revision-race behavior. Local synthetic measurement and focused tests await the next slot. Hosted and k3s observations remain NOT_CHECKED.
- C42 still uses bounded full-state read/modify, private temp-file write, file sync, rename, and parent-directory sync. Phase distributions and kill-9 recovery await the next slot. No persistence optimization is justified before those results.
- C45 is deferred by the source-boundary and fixed-acceptance evidence above. No direct dispatch attribution or route-specific p95 comparison supports extraction.
