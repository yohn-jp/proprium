# G4 contract and necessity evidence

**Scope:** C37, C48–C53, C55–C57. C54 remains with G2.

**Inspected base:** `a1587e784788fa87d86c0eb7ab175d7a28a3209f`.

**Worktree:** `perf/c64-g4`.

**State:** Read-only assessment. No product code or tests were changed. Initial G1–G3 consumer plans were reviewed at `main@7008feef2294e1176cda2799ec0384e4ee7585c0`. These are plan-level findings, not post-G0 measurements or implementation verification.

## Cross-gate consumer necessity

The initial G1 plan selects C02 cursor-only sentence-position work as its first independent leaf; the G2 plan evaluates C21/C54 around the existing `SnapshotReader` and `DocumentSource`; and G3's likely first leaf is recent-activity polling in the existing hook, with project-event subscription deferred. None identifies a consumer that requires a new generic hierarchy, operation type, module manifest, plugin SDK, large-blob API, or shared SSE protocol. G2 may still measure whether the existing `DocumentSource` adapter benefits from a small optional Core reader capability. That question does not justify a new public abstraction in advance.

Evidence: [G1 plan](CORE-64-G1-PLAN.md#proposed-first-independent-leaf-and-sequence), [G2 C21/C54 plan](CORE-64-G2-PLAN.md#candidate-evidence-and-smallest-next-unit), and [G3 C39/C43 plan](CORE-64-G3-PLAN.md#candidate-triage). These plans settle current consumer necessity for speculative G4 generalizations; future measured results may reopen only the named gap and smallest affected contract.

## Existing contracts and candidate decisions

### C37 — Generic file access already sits below the scene hierarchy

`SnapshotReader` reads and lists arbitrary safe repository paths at one `SnapshotId`; Core's `makeReader` binds those operations to the selected immutable Git commit. `ChangeOperation` writes generic paths with per-file revisions, and the existing transaction suite saves Markdown plus a binary attachment through the same multi-file checkpoint path. The scene tree and editor remain volume/chapter/scene-oriented, so this evidence establishes generic storage access, not a general file-browser UI.

Evidence: [`SnapshotReader` and `DocumentSource`](../../packages/contracts/src/index.ts#L84), [`CoreStore.makeReader`](../../packages/core/src/index.ts#L2417), [pinned snapshot enumeration/read test](../../packages/core/src/transactions.test.ts#L130), and [generic Markdown plus attachment checkpoint test](../../packages/core/src/transactions.test.ts#L1928).

**Decision proposal:** decline a general hierarchy/API rewrite for this gate. G1's cursor-only leaf and G2's existing reader evaluation do not require it. Reconsider a narrow adapter only for a named consumer with a demonstrated correctness or performance gap.

### C48 and C57 — The encoded payload limits reject oversize writes before persistence

The API JSON parser caps request bodies at 12 MiB. Independently, `assertChangeOperation` caps the combined `content.length` of all writes at 8 MiB; base64 is ASCII, so its character count equals its encoded byte count. A raw 6 MiB attachment encodes to exactly 8 MiB before the accompanying scratch Markdown. The scratch route permits up to 8 MiB of raw attachment bytes, so its raw-byte check alone does not guarantee that the resulting operation passes the stricter operation-content cap. A 10 MiB attachment encodes to 13,981,016 bytes and its JSON request exceeds the body cap before reaching the route; the 32 MiB case encodes to 44,739,244 bytes.

The arithmetic was checked with this small standalone command (no HTTP load or RSS measurement):

```sh
node --input-type=module -e 'const MiB = 1024 ** 2; for (const rawMiB of [6, 8, 10, 32]) { const raw = rawMiB * MiB; const b64 = 4 * Math.ceil(raw / 3); console.log({ rawMiB, base64Bytes: b64, operationLimitBytes: 8 * MiB, jsonLimitBytes: 12 * MiB }); }'
```

The existing API scratch test uses a four-byte attachment and a fake store, so it does not prove the large-payload interaction end to end. On the real Core path, `propose` validates every operation before writing its proposal journal; the scratch route calls `propose` before `approve` and `checkpoint`. Therefore this size mismatch is a contract-safe rejection before approval/checkpoint, not evidence of a partial file save. The exact Core rejection path was inspected but not executed here: `tsx` is not installed in this isolated worktree.

Evidence: [`MAX_JSON_BYTES`](../../packages/api/src/server.ts#L51), [`MAX_SCRATCH_ATTACHMENT_BYTES`](../../packages/api/src/server.ts#L54), [JSON parser](../../packages/api/src/server.ts#L620), [scratch attachment checks and operation construction](../../packages/api/src/server.ts#L1089), [`assertChangeOperation` aggregate cap](../../packages/contracts/src/index.ts#L395), [Core proposal validation before journal write](../../packages/core/src/index.ts#L3614), and [small attachment API test](../../packages/api/src/server.test.ts#L2337).

**Decision proposal:** preserve the current bounded-operation validation and decline a streaming/blob API for this gate. G1–G3 identify no consumer that needs one, and arithmetic alone does not establish a performance benefit. The raw/base64 route boundary, API-to-real-Core persistence behavior, peak RSS, and abort/recovery behavior remain `NOT_CHECKED`. Reconsider only if a named consumer needs a file beyond the accepted operation size and same-fixture measurements show a useful gain.

Smallest contract-level test proposal (not added or run), using the existing `operation` fixture in `packages/contracts/src/index.test.ts`:

```ts
const encoded = Buffer.alloc(6 * 1024 * 1024).toString("base64");
assert.throws(() => assertChangeOperation({
  ...operation,
  writes: [
    { path: "meta/scratch/file.bin", revision: null, content: encoded, encoding: "base64" },
    { path: "meta/scratch/note.md", revision: null, content: "x" },
  ],
}), /Operation payload exceeds limit/);
```

The next focused route-boundary check should POST a synthetic scratch request with a 6 MiB raw attachment and non-empty Markdown through the API to a real Core store, expect proposal validation to reject it, and verify that no proposal or checkpoint was persisted and neither scratch file appeared. It should also verify that a 10 MiB base64 JSON request fails at the 12 MiB parser boundary before the handler. Record peak RSS for those cases only under the next measurement lease; keep the existing limits until a measured consumer and safe alternative are demonstrated. The inspected call order is `propose` → `approve` → `checkpoint`; Core validates operation size before its proposal-journal write. Source inspection therefore indicates a contract-safe rejection before persistence on the real Core path, with no evidence of a partial file save; the integration behavior itself remains `NOT_CHECKED` here.

### C49 — The two SSE streams have different ownership and events

`/api/projects/events` publishes manual sync outcomes, including started/completed/failed phases; `/api/jobs/events` publishes worker job history/progress and requires an owner session. Existing API tests cover project event scope and shutdown closure, and job progress/history delivery. They do not measure connection count, replay, or backpressure costs.

Evidence: [project event route](../../packages/api/src/server.ts#L1610), [job event route](../../packages/api/src/server.ts#L1621), [project sync event test](../../packages/api/src/server.test.ts#L2002), and [worker job SSE test](../../packages/api/src/server.test.ts#L1427).

**Decision:** keep the streams separate. A common envelope or protocol rewrite has no measured performance case. Reconsider if a consumer or same-load connection/replay measurement identifies a concrete cost while preserving owner scope, event meaning, and shutdown cleanup.

### C50 — Generic operation types already coexist with scene adapters

`SnapshotId`, `SnapshotReader`, `FileRevision`, `FileChange`, and `ChangeOperation` carry repository paths and revisions without scene-specific fields. Core retains scene-specific navigation/read/save adapters and also checkpoints generic scratch files and module metadata. This is a usable boundary for current file operations; it does not justify introducing a public plugin SDK or changing the hierarchy model.

Evidence: [transport-neutral file and operation contracts](../../packages/contracts/src/index.ts#L30), [generic multi-file checkpoint test](../../packages/core/src/transactions.test.ts#L1928), and [generic module metadata guard test](../../packages/core/src/transactions.test.ts#L1970).

**Decision proposal:** decline type/adapter redesign for this gate. Initial G1–G3 consumer plans expose no missing contract; if a measured reader consumer later needs one, prefer the narrowest optional adapter over generalizing scene persistence.

### C51 — Mutation safety is a fixed invariant, not an optimization target

The operation contract binds repository identity, base remote commit, generation, file reads and expected revisions, optional directory-scope revisions, and writes. Core revalidates the operation and snapshot at proposal time, revalidates approval/read scopes, and journals only after the checks. Existing tests cover concurrent stale saves, changed hierarchy membership, semantic-scope changes after approval, exact approval payload binding, non-fast-forward retries, lost push responses, rejected pushes, and binary restoration.

Evidence: [`ChangeOperation` and receipt types](../../packages/contracts/src/index.ts#L30), [proposal checks and journal ordering](../../packages/core/src/index.ts#L3614), [approval revalidation](../../packages/core/src/index.ts#L3715), [project lock implementation](../../packages/core/src/index.ts#L4420), [stale concurrent save test](../../packages/core/src/index.test.ts#L297), [scope-change checkpoint test](../../packages/core/src/transactions.test.ts#L1141), [exact approval binding test](../../packages/core/src/transactions.test.ts#L1410), [lost push response test](../../packages/core/src/transactions.test.ts#L1365), [rejected receive hook test](../../packages/core/src/transactions.test.ts#L1386), and [hosted runtime epoch test](../../packages/api/src/server.test.ts#L587).

**Decision:** preserve read-set/write-set, expected revisions, author approval, receipts, single-writer coordination, and epoch/fence checks unchanged. No performance shortcut may bypass these checks.

### C52 — Build profile closure is enforced; runtime idleness is only partly covered

The profile generator produces empty module loader catalogs for Core and verifies the deployed Core closure. Existing runtime coverage verifies disabled modules are not imported and that enabling an absent module requires redeployment. These checks support the compile-profile boundary, but they do not establish zero timers/network/workers for every installed-disabled combination or certify all full-profile runtime states.

Evidence: [Core profile closure test](../../scripts/profile-build.test.mjs#L12), [disabled-module import test](../../packages/module-runtime/src/module-runtime.test.ts#L88), and [`audit:core` entrypoint](../../package.json#L15).

**Decision:** keep the profile boundary. Final profile/runtime certification belongs to the existing G5 validation path; do not add generic toggling machinery in G4. Runtime cases without direct evidence remain `NOT_CHECKED`.

### C53 — Nine hard-coded module IDs have no measured maintenance bottleneck

The current set is deliberately enumerated by the public `ModuleId` type, runtime validator, profile generator, and build/package catalogs. The evidence contains no measured module-addition cost, registry drift, or runtime cost caused by those lists. Generalizing them to a dynamic manifest is broader than a demonstrated performance gap and would overlap the separately scoped public plugin platform.

Evidence: [`ModuleId`](../../packages/contracts/src/index.ts#L6), [runtime ID set](../../packages/module-runtime/src/runtime-error.ts#L3), and [profile generator module allowlist](../../scripts/profile-build.mjs#L10).

**Decision proposal:** decline dynamic-manifest generalization for this gate. Reconsider when an accepted in-scope module addition is demonstrably blocked by inconsistent registries or repeated correctness failures. Do not implement a public plugin platform under C53.

### C55 — Browser contribution lifecycle is implemented in code, without a focused host test

The browser host mounts only the selected contribution through its loader, gives it an `AbortSignal` and pinned snapshot, rejects action results from a different snapshot, aborts on cleanup, and calls `dispose` after unmount. No focused `ContributionHost`/`MountedContribution` test file exists in `app/src`; module-runtime cancellation tests cover server actions/workers, not this browser lifecycle.

Evidence: [browser contribution host](../../app/src/contributions/ContributionHost.tsx#L39), [lazy mount and snapshot checks](../../app/src/contributions/ContributionHost.tsx#L103), [abort and dispose cleanup](../../app/src/contributions/ContributionHost.tsx#L165), and [module disable/late proposal runtime test](../../packages/module-runtime/src/module-runtime.test.ts#L1328).

**Decision:** preserve the existing lifecycle and capability boundary. Do not add a stable capability adapter without a named consumer. Revisit browser-specific regression coverage only if a production change touches this path or a G1 workspace consumer exposes a lifecycle gap.

### C56 — Modules receive read/propose ports, not Core filesystem or approval authority

`ModuleActionContext` exposes a snapshot reader, constrained host actions, owner-checked linked readers, and proposal submission; it exposes no Core project root or Git writer. `MutationCoordinator` is explicitly host-only and includes approval/checkpoint/publish ports. Core path tests reject traversal, `.git`, and symlink escape. Module runtime tests cover public-route proposal denial, owner-context effect limits, owner-checked linked readers, and rejection of late proposals after disable. These are trusted built-in modules; the separate external plugin sandbox/platform is not part of this Goal.

Evidence: [proposal-only module port](../../packages/contracts/src/index.ts#L132), [host-only mutation port](../../packages/contracts/src/index.ts#L142), [module action context](../../packages/contracts/src/index.ts#L179), [path traversal and symlink tests](../../packages/core/src/index.test.ts#L448), [public-read proposal denial test](../../packages/module-runtime/src/module-runtime.test.ts#L1043), [owner compute effect-limit test](../../packages/module-runtime/src/module-runtime.test.ts#L1133), and [late-proposal disable test](../../packages/module-runtime/src/module-runtime.test.ts#L1328).

**Decision:** retain the boundary. Do not expose unrestricted filesystem access or claim the current in-process modules are a security sandbox.

## Focused checks and execution record

No package tests or builds were run for this documentation-only assessment. The exact references above identify the existing focused cases. If a later G4 change touches a production path, these focused commands select the relevant tests:

```sh
pnpm --dir packages/contracts exec node --import tsx --test --test-name-pattern='untrusted recovery|scope guards|document source' src/index.test.ts
pnpm --dir packages/core exec node --import tsx --test --test-name-pattern='manuscript snapshots|stale chapter deletion|semantic read scopes|lost push response|rejected receive hook|scratch Markdown|generic operations' src/transactions.test.ts
pnpm --dir packages/core exec node --import tsx --test --test-name-pattern='simultaneous stale-revision saves|traversal and symlinks' src/index.test.ts
pnpm --dir packages/module-runtime exec node --import tsx --test --test-name-pattern='disabled modules are not imported|HTTP contributions are hidden|owner compute HTTP|module disable bounds' src/module-runtime.test.ts
node --test --test-name-pattern='Core profile generation|Full package waits' scripts/profile-build.test.mjs scripts/profile-package.test.mjs
pnpm --dir packages/api run build
pnpm --dir packages/api exec node --test --test-name-pattern='publishes real supervised worker jobs|streams owner-scoped events|stores scratch text' dist/server.test.js
pnpm audit:core
```

These commands select existing test cases; they do not close the missing large-payload API/Core integration case until that focused test is added. The package commands are only relevant when a change touches those paths; API build/test and `audit:core` are required only for an accepted API/profile change. The bounded base64 arithmetic above ran successfully. The attempted direct validator reproducer did not run because `tsx` is absent from this worktree; that execution is not claimed as verification.

G0 reports that frozen install, typecheck, full `pnpm test`, Core-profile build, and `pnpm audit:core` all exited 0 on runtime `a1587e78`; its verification log evidence is pending its report commit. This G4 worker did not run those checks. Native browser disable-lifecycle, full-profile/OCI acceptance, large-payload route integration, and RSS measurement have not been captured. G0 owns the full/heavy measurement lease; the documentation assessment did not rerun its suite.

## Proposed G4 ledger dispositions and unchecked evidence

| Candidate | Current-gate disposition proposal | Evidence that remains `NOT_CHECKED` |
| --- | --- | --- |
| C37 | Decline general hierarchy/API rewrite; no G1–G3 consumer requires it. | Generic hierarchy usability/performance for a future named workspace consumer; focused referenced tests were inspected, not run by G4. |
| C48 | Keep the operation and JSON limits; decline streaming/blob API absent a measured consumer. Treat the 6 MiB attachment plus Markdown case as a focused boundary check, not a partial-save claim. | API-to-real-Core rejection, no proposal/checkpoint/file persistence, and peak RSS at the route boundary; 10/32 MiB RSS and abort/recovery behavior. |
| C49 | Keep project and job SSE separate; no common envelope proposal. | Connection-count, replay, and backpressure measurements; referenced API tests were inspected, not run by G4. |
| C50 | Decline type/adapter redesign; existing path-based contracts serve current generic writes. | A measured consumer blocked by those contracts; referenced contract/Core tests were inspected, not run by G4. |
| C51 | Preserve mutation safety invariants unchanged. | Referenced stale-save, scope, approval, push-retry, and runtime-epoch cases were inspected, not run by G4. G0's full-suite pass is reported separately above. |
| C52 | Preserve compile-profile boundary; no generic toggling machinery. | Full-profile test/build and universal installed-disabled runtime idleness (timers/network/workers); G0's Core-profile audit/build pass does not establish these cases. |
| C53 | Decline dynamic module manifest/generalization; no measured registry burden. | Module-addition effort, registry drift, and runtime cost measurements. |
| C55 | Preserve lazy mount, snapshot check, abort, and dispose lifecycle. | Focused browser host regression: no such test was found; native browser disable-lifecycle was not captured. |
| C56 | Preserve read/propose versus host-only mutation authority; do not claim an external-code sandbox. | Referenced Core/module-runtime cases were inspected, not run by G4; external plugin sandboxing is outside this goal and unchecked. |
| C57 | Preserve bounded operation writes; no larger attachment mechanism now. | Browser attachment mutation workload, API/Core route-boundary integration, and peak RSS; no streaming necessity measurement. |

This report settles current-gate necessity from the initial G1–G3 consumer plans and source/test inspection. No G4 focused test, build, audit, browser, OCI, route integration, or RSS run is claimed.
