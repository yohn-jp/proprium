# Contributing to Scriptorium

Scriptorium is a Git-backed writing application. Consult [Full Migration Architecture](docs/architecture/FULL-MIGRATION.md), the [fixed P00–P13 plan](docs/migration/FULL-MIGRATION-PLAN.md), and the applicable [Core Architecture](docs/architecture/CORE.md) before proposing a change.

- Open a scoped Issue and identify the acceptance criteria.
- Work from `main` on an issue-scoped branch (`feat/<issue>-<slug>`, `fix/<issue>-<slug>`, etc.).
- Keep changes within the accepted Issue; use a PR instead of writing directly to `main`.
- Epic #7 explicitly authorizes Sol alone to integrate and push directly to `main`; its workers commit only in isolated branches/worktrees.
- Describe contract changes, dependencies, and validation actually executed.
- Follow the current organization agent/governance contract in `yohn-jp/.github`.
- Do not introduce optional NLP or embedded LLM dependencies into the minimal Core.
- Do not commit work repositories, manuscripts, tokens, caches, embeddings, or model artifacts.

Install with `pnpm install --frozen-lockfile`; run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm audit:core`. Follow the browser and image checks under `docs/verification` for changes affecting the user journey or packaging. Do not add, synchronize, or run CI/GitHub Actions or organization templates as part of the initial recovery.

For security concerns, use [SECURITY.md](SECURITY.md).
