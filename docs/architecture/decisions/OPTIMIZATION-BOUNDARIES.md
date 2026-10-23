# Evidence-backed optimization decisions

This record retains durable technical decisions rather than a benchmark campaign timeline. The historical numerical measurements and source identities belong in immutable performance evidence or Git history. A new optimization needs a bounded before/after experiment and an explicit safety equivalence proof; line count and synthetic timing alone are not sufficient.

| Area | Decision | Invariant and condition for reopening |
| --- | --- | --- |
| Journal payload duplication (C14) | Keep recoverable complete text/base/write representations; do not compress or deduplicate by schema rewrite without a compatible migration. | Browser IndexedDB quota/failure handling, exact restoration of text and metadata, crash/reload equivalence and physical persisted bytes must be measured together. |
| Status remote observation (C29) | Do not replace required observation with a stale TTL cache. | A candidate must preserve changed-HEAD detection, remote freshness and unknown-state behavior under concurrent writes and failures, and prove matched cost improvement. |
| Cache consolidation (C31) | Keep bounded independent immutable-revision, hierarchy and historical metadata caches. | A replacement must prove correct eviction, lifecycle memory/RSS bounds and no state-authority loss with real workload measurements. |
| Recent activity persistence (C42) | Preserve atomic replacement with file and directory synchronization. | An alternative must survive partial temp writes, process termination/restart, author isolation and concurrent writes; lower fsync cost alone is not proof. |
| HTTP handler extraction (C45) | Retain the single Fastify authorization, request activity, abort and error projection boundary. | Split only when a real routing contract/test obstacle or direct per-route trace justifies it, with permission/response equivalence and matched latency proof. |

No row authorizes changing existing Git, writer, proposal, retry, browser recovery or Core-only dependency contracts. The measurements underlying these decisions were recorded under the repository's performance history; keeping a decision here is not a claim that a future release was measured.
