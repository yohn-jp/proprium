# Epic #7 P00 baseline

Checked 2026-10-17. Target baseline `01403182e9f73dec29d04954e3091c235cd1aac0`; source remote main and separate read-only clone `/tmp/scriptorium-source-7` both `edc033c2c9466274a334299dadfa426661d957d9`. No baseline drift. Existing `/home/sophia/src/arcadia-loom` worktree was behind and left untouched.

PR #8 was OPEN at `016a69cb924cbe1f9aed9af18f2f31143dff9676`, exactly three documentation files over target main. Its accepted documents were fast-forwarded and pushed without rewriting history. No PR state or CI was changed. Existing untracked `.codegraph/` remains untouched.

| Check | Result |
| --- | --- |
| Node / pnpm | 24.21.0 / 12.10.1 |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: 13 Core, 4 HTTP, 3 browser-draft unit tests |
| `pnpm build` | PASS |
| `pnpm audit:core` | PASS: 10 installed package versions including development dependencies; runtime is YAML only |
| `pnpm test:e2e` default downloaded Chromium | Environment failure: missing `libglib-2.0.so.0` |
| `SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium pnpm test:e2e` | PASS: 1 real browser scenario, local bare Git remote |
| OCI | Separate environment record; not inferred from the historical OCI report |

The commands above ran on the unchanged baseline runtime tree after documentation integration. This certifies existing MVP behavior only, including its old save and draft semantics. It does not certify the new checkpoint/publication contract or any migrated module. Raw local logs are `/tmp/scriptorium-baseline-{typecheck,test,build,audit,browser-nix}.log` (ephemeral, not delivery artifacts).

The frozen transport-neutral contract v1 lives in `packages/contracts/src/index.ts`. Its executable boundary rejects unsafe paths, absent revision preconditions, duplicate writes and oversized recovery payloads. Two focused tests prove recovery round trip and snapshot identity separation. Core owns filesystem/symlink checks and author approval; a module action can propose, read a pinned snapshot, or run a bounded job, and receives no direct approval authority.
