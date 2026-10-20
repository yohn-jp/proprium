# Core 64 lifecycle invariant certification

**Scope:** Finalize evidence-only dispositions for C51 and C56. C52 and C55 remain pending the next browser verification slot. No product code or tests are changed by this evidence commit.

**Source base:** `53099848caa237a69c098c6f83bad00d9368184d` (`perf/c64-lifecycle`). The G0 test run used runtime `a1587e784788fa87d86c0eb7ab175d7a28a3209f`; current final main is `79c22d6688a7e70ab9758ea75ff756f6d6de9b6b`. The relevant implementation and test files cited below are byte-identical at all three commits.

**Verification provenance:** G0's [`pnpm test` result](G0-CORE-64-BASELINE.md#verification-and-reusable-runtime) was 419 passed, 1 existing opt-in semantic CPU case skipped, and 0 failed. Its raw `test.log` is `/data/scriptorium-core64-g0-a1587e78-20261020-2318/logs/test.log`; the [G0 manifest](results/core64-g0/MANIFEST.json) records its SHA-256 as `fd07ff0a9e353309e4f0b2221ac1e5ae6bff24c91f5d8104114ec20d1b5cfd06`. The exact test names and assertions below appear in that run. This unit inspected the log and source but did not rerun tests or builds.

## C51 — `VERIFIED_EXISTING`

Retain the existing repository, snapshot, read-set, approval, publish-reconciliation, and runtime-epoch checks. The tests provide evidence for the current paths; no performance shortcut or mutation-path change is justified.

- [`serializes simultaneous stale-revision saves through one CoreStore`](../../packages/core/src/index.test.ts#L297): two saves use the same revision; assertions require exactly one winner, one `revision_conflict`, the winner's text to remain current, and one history entry. G0 log line 425.
- [`checkpoint rejects a semantic read scope changed after author approval`](../../packages/core/src/transactions.test.ts#L1141): after a new child is committed remotely, checkpoint must fail with `scope_precondition_conflict`; no pending receipt is created and the original project file remains unchanged. G0 log line 471.
- [`author approval binds to the exact operation payload`](../../packages/core/src/transactions.test.ts#L1410): changed content cannot checkpoint with the original approval, reuse of the approved proposal ID with changed content fails, and the original proposal stays approved. G0 log line 479.
- [`a lost push response is confirmed from the fetched publication ancestor`](../../packages/core/src/transactions.test.ts#L1365): after the remote accepts a checkpoint but kills the push caller, Core returns `confirmed`, acknowledges only the expected operation, and verifies the commit is an ancestor of the published remote head. G0 log line 477.
- [`a rejected receive hook leaves the checkpoint pending and unacknowledged`](../../packages/core/src/transactions.test.ts#L1386): the publish result is a conflict with no acknowledgements; the remote head stays unchanged while the checkpoint remains pending and readable locally. G0 log line 478.
- [`module disable bounds a non-cooperative action drain and rejects late proposals`](../../packages/module-runtime/src/module-runtime.test.ts#L1328): after disable times out, the resumed action returns `action_cancelled`, the host proposal callback count stays zero, and module status is disabled. G0 log line 48.
- [`binds hosted API access and signed lifecycle controls to one repository and runtime epoch`](../../packages/api/src/server.test.ts#L587): read grants cannot submit proposals (`403 WRITE_PERMISSION_REQUIRED`), repository access is confined to the assigned project, control routes require signed controls, and quiesce/resume requests are bound to the configured runtime epoch and operation identity. G0 log line 541.

The source path complements those cases: [Core validates the proposal snapshot and each operation before journaling](../../packages/core/src/index.ts#L3614), [approval rechecks the observed snapshot and read scopes](../../packages/core/src/index.ts#L3715), and project mutation is serialized by the Core project lock. The broader [G4 contract evidence](CORE-64-G4-EVIDENCE.md#c51--mutation-safety-is-a-fixed-invariant-not-an-optimization-target) records those checks and the scope boundary.

## C56 — `VERIFIED_EXISTING` for trusted built-in modules

Retain the read/propose port boundary and host-only approval, checkpoint, reconcile, and publish authority. G0's passing tests support these built-in module boundaries in the tested contexts.

- [`ModuleActionContext`](../../packages/contracts/src/index.ts#L179) gives modules a snapshot reader, constrained action composition, owner-checked linked readers, proposal submission, and worker invocation. [`MutationCoordinator`](../../packages/contracts/src/index.ts#L142) keeps author approval and Core mutation methods on the host side.
- [`module actions compose through namespaced host actions and owner-checked linked readers`](../../packages/module-runtime/src/module-runtime.test.ts#L927): enabled-idle loader count remains zero until action invocation; linked reads require the requested owner repository ID and expose only the linked reader's paths. G0 log line 41.
- [`HTTP contributions are hidden until activation and public reads cannot propose`](../../packages/module-runtime/src/module-runtime.test.ts#L1043): a public read handler attempting proposal gets 403 and the proposal callback count stays zero; public context exposes no private actions, nested invocation returns `public_action_unavailable`, linked access returns `public_access_restricted`, and neither private module import nor linked-reader callback runs. G0 log line 43.
- [`owner compute HTTP contributions can compose reads, compute, and jobs but cannot propose`](../../packages/module-runtime/src/module-runtime.test.ts#L1133): both nested propose-action invocation and direct proposal submission return `action_effect_denied`; propose-action and host proposal callback counts stay zero. G0 log line 44.
- The hosted API test above also checks representative read/write cases: a read grant can call a declared read action but cannot propose; a write cookie without CSRF is rejected and a same-origin CSRF-protected write succeeds. This is targeted coverage, not a complete permission matrix.
- [`rejects manuscript paths that escape the project or pass through a symlink`](../../packages/core/src/index.test.ts#L448) and [`rejects .git manuscript paths without corrupting an active dotted branch ref`](../../packages/core/src/index.test.ts#L509) cover path escape and Git metadata protections. Both passed in G0 log lines 431 and 433.

These tests establish restrictions for the current trusted, in-process module API. They do not establish process isolation for arbitrary third-party plugin code. An external plugin sandbox and untested permission combinations remain `NOT_CHECKED` and are outside this goal.

## C52 and C55 — pending

G0's Core and full builds, Core audit, profile generation tests, and module-runtime tests are evidence for the compile-profile boundary and in-process enabled-state transitions. They do not measure zero module-attributed browser timers, network requests, or workers for every installed-disabled configuration. A full-profile real-browser lifecycle regression for contribution lazy mount, snapshot rejection, abort/dispose, and late callback cleanup remains pending. The prepared `tests/e2e/core64-lifecycle.acceptance.spec.ts` is uncommitted and unrun until the scheduler releases the browser slot; no result is claimed.

No new heavy checks were run because the C02/C21 verification batch is active. The planned browser command is recorded in the prepared test/report for the next slot.
