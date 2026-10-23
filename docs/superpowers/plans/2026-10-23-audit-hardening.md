# Audit hardening implementation plan

> Execute inline using superpowers:executing-plans. Scope and approval: Issue #29 and the owner's instruction to address the audit in one PR. No additional design approval is required for this accepted work.

Goal: close the audited runtime defects and protect subsequent source/release changes without rewriting Git or journal authority.
Architecture: retain existing HTTP, MCP SDK, TypeScript, profile build and Hosted Producer paths. Extract only changed response validation/error classification/lifetime logic. Verification is read-only; publication uses the existing OCI path after exact-source gates.
Tech stack: Node 24, pnpm 12.10.1, TypeScript 5.9, React/Ionic, native node:test, GitHub Actions.
Spec: https://github.com/yohn-jp/scriptorium/issues/29
Base: 7f698cb943e672c90ec3c60a484124e12fad5ac0

## Constraints
- One issue-scoped branch/PR. No main writes, merge, existing tag changes, release/image publication, production changes, or secrets.
- Preserve authentication, clean source, signed evidence, native catalog/compose, Git checkpoint/publish and browser recovery semantics.
- Existing initial-recovery CI prohibition is superseded only for the approved verification/release-gate work.
- Never treat a configured check as executed, a failed environment as success, or a workflow as an account-level restriction on administrators.

## Review focus
Malformed/empty successful HTTP responses; 502/503 dependency outages; MCP capacity reservations during concurrent initialization and active streams; clean native Hosted module outputs; exact SHA equality across verification and release publication.

## Tasks
- [x] 1. Preserve dependency errors at both Hosted read/write HTTP boundaries. Add failing HTTP regressions, extract safe classification, rerun boundary suites.
- [x] 2. Add browser response decoders using existing shared contract validation. Reject malformed JSON and unexpected 204; validate critical DTOs before state/recovery consumers. Preserve refresh single-flight and legitimate optional fields. Run transport regressions.
- [x] 3. Bound MCP session creation/idle retention, including pending initialization, active requests and dispose. Test through actual SDK transport and verify project scoping.
- [x] 4. Typecheck excluded test sources and add stricter scoped checks for changed boundary modules and JavaScript release tooling. Repair proven errors without broad suppression or unrelated refactors.
- [x] 5. Verify native Hosted catalog/compose and all shipped modules; maintain clean source/digest and symlink rejection. Wire PR/main checks and require them before existing OCI publication; add exact-source verified Release entrypoint.
- [x] 6. Reconcile scoped governance, record file/test evidence and external gates, inspect the integrated diff, run final checks, update one non-draft PR. Stop without merge.

## Execution environment
The original execution used a Node 22 container without package/GitHub DNS. The continuation uses Node 24.21.0 and pnpm 12.10.1 with working network/package stores. Its issue worktree is `/data/scriptorium-29-audit-hardening` because the root filesystem filled during the initial dependency copy. GitHub verification uses Node 24.22.0. See [audit evidence](../../verification/AUDIT-HARDENING-29.md) and PR #30 for commands, exact revisions, results and remaining NOT_CHECKED boundaries.

Implementation and local verification are complete. Final exact-HEAD CI certification and delivery status are recorded in PR #30; local completion does not substitute for the required remote jobs.
