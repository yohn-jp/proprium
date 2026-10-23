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
- [ ] 1. Preserve dependency errors at both Hosted read/write HTTP boundaries. Add failing HTTP regressions, extract safe classification, rerun boundary suites.
- [ ] 2. Add browser response decoders using existing shared contract validation. Reject malformed JSON and unexpected 204; validate critical DTOs before state/recovery consumers. Preserve refresh single-flight and legitimate optional fields. Run transport regressions.
- [ ] 3. Bound MCP session creation/idle retention, including pending initialization, active requests and dispose. Test through actual SDK transport and verify project scoping.
- [ ] 4. Typecheck excluded test sources and add stricter scoped checks for changed boundary modules and JavaScript release tooling. Repair proven errors without broad suppression or unrelated refactors.
- [ ] 5. Verify native Hosted catalog/compose and all shipped modules; maintain clean source/digest and symlink rejection. Wire PR/main checks and require them before existing OCI publication; add exact-source verified Release entrypoint.
- [ ] 6. Reconcile scoped governance, record file/test evidence and external gates, inspect the integrated diff, run final checks, update one non-draft PR. Stop without merge.

## Execution environment
The ChatGPT container cannot resolve github.com and has Node 22 rather than the repository's Node 24. Connected GitHub reads/writes work. Local dependency-dependent/full validation is unavailable; use isolated GitHub runners and report their actual results. Pure dependency-free checks may run locally and are labeled separately.
