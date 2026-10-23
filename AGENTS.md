# Scriptorium

Read [Internal Boundaries and Maintainability](docs/architecture/INTERNAL-BOUNDARIES.md) for the normative ownership and refactoring contract. Read [Modular Workspace Architecture](docs/architecture/MODULAR-WORKSPACE.md) for the current Core/Plugin/Workspace implementation. Read [Full Migration Architecture](docs/architecture/FULL-MIGRATION.md) and [the fixed P00–P13 plan](docs/migration/FULL-MIGRATION-PLAN.md) for Epic #7. [Core Architecture](docs/architecture/CORE.md) remains the baseline where not superseded. Follow the organization-wide `yohn-jp/.github/.github/agent-governance/AGENTS.md` and its applicable skills.

## Authority
1. Explicit current user instructions and accepted Issue / Implementation contract.
2. `docs/architecture/FULL-MIGRATION.md`, the accepted migration plan, and actual repository contracts.
3. Current source code and scoped repository rules.

## Execution
Epic #7 authorizes Sol alone to integrate, commit and push directly to `main`. Workers implement and commit on issue-scoped isolated branches/worktrees; never write `main`. Inari agent usage is currently suspended by organization policy. The completed migration ledger is not reopened. The Modular Workspace goal authorizes Core foreground, composable workspace and optional search/terminology implementation; do not migrate unrelated Arcadia features or publish private project data.

## Validation
Use `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm audit:core`. Run the browser and OCI acceptance checks described in the verification documentation when changing their production paths. Issue #29 authorizes repository verification CI and exact-source release gates after initial Core recovery. Verification never publishes or deploys. Only the gated release workflow may publish; do not synchronize organization templates or change production resources.
