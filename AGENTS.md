# Scriptorium

Read [Core Architecture](docs/architecture/CORE.md) for product ownership and design authority. Follow the organization-wide `yohn-jp/.github/.github/agent-governance/AGENTS.md` and its applicable skills.

## Authority
1. Explicit current user instructions and accepted Issue / Implementation contract.
2. `docs/architecture/CORE.md` and actual repository contracts.
3. Current source code and scoped repository rules.

## Execution
Work on issue-scoped isolated branches; never commit implementation directly to `main`. Inari agent usage is currently suspended by organization policy. Do not migrate unrelated Arcadia features or publish private project data.

## Validation
Use `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm audit:core`. Run the browser and OCI acceptance checks described in the verification documentation when changing their production paths. Never run or synchronize GitHub Actions, CI workflows, or organization templates for this initial Core recovery.
