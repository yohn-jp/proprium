# Scriptorium

Read [Internal boundaries](docs/architecture/INTERNAL-BOUNDARIES.md) for shared ownership and refactoring invariants. Read [Core architecture](docs/architecture/CORE.md), [Modular Workspace](docs/architecture/MODULAR-WORKSPACE.md) and [Modules](docs/architecture/MODULES.md) for application contracts. [Plugin Platform](docs/architecture/PLUGIN-PLATFORM.md) is a design proposal for external code, not the trusted module runtime contract. Follow the organization-wide `yohn-jp/.github/.github/agent-governance/AGENTS.md` and applicable skills.

For UI and interaction work, read [Design and UX contract](docs/design/UX-CONTRACT.md). It is the canonical presentation and experience contract, including acceptance scenarios; it preserves the existing stack, distinct Desktop/Mobile shells and shared authoring, durability and authorization boundaries. Mockups are not specifications. Keep execution prompts and verification results in PRs or test artifacts, not in maintained product documentation.

## Authority

Explicit user instructions and the accepted implementation contract take precedence over repository architecture, source contracts and scoped rules. Do not expand scope into unrelated Arcadia features or publish private project data. Preserve the closed migration verification inputs under `evidence/migration`; do not reopen the ledger.

## Execution

Use an isolated branch/worktree and submit a PR. Do not write directly to `main`, merge, publish or deploy without explicit authorization. Follow the organization's Inari suspension; use repository contracts and organization skills directly.

## Validation

Use `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm audit:core`. Follow [verification](docs/verification/README.md) for test-source/safety, browser, integration and OCI checks when their paths change. Verification never publishes or deploys; only the gated release workflow publishes. Do not synchronize organization templates or change production resources. Follow the [documentation rules](CONTRIBUTING.md#documentation).
