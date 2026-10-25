# Contributing to Proprium

The canonical proposed design is indexed at [docs/README.md](docs/README.md). [COMPATIBILITY](docs/architecture/COMPATIBILITY.md) separates inherited Scriptorium code from Proprium's intended runtime.

- Work on an isolated branch and submit a PR; do not alter main directly.
- Treat architecture documents as target contracts, not claims that the inherited source is conformant.
- Limit changes to the accepted scope. Keep author workspaces, Git credentials, tokens, model weights, cached indexes, and private material out of commits and test fixtures.
- Preserve GitHub remote authority, browser-local failure semantics, host-owned writes, plugin capability boundaries, and current-data provenance.
- Record exact checks performed and checks unavailable. Passing legacy Node/OCI tests does not certify mobile Safari, browser Git, WASM isolation, or a static Proprium deployment.
- Follow the [organization agent governance](https://github.com/yohn-jp/.github/blob/main/.github/agent-governance/AGENTS.md).

## Existing tooling

The inherited Node/pnpm monorepo still exposes **legacy Scriptorium** checks such as:

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm audit:core
~~~

Use them when changing the inherited implementation. They are not a verification plan for the proposed browser-native runtime. Do not remove or weaken historical tests merely to align them with documentation. New components will need targeted browser, mobile, Git/sync, artifact and sandbox acceptance tests before claiming support.

## Documentation

Maintain documentation as durable product/architecture contracts: responsibilities, invariants, declared limitations, and acceptance conditions. Keep dates, branch/commit reports, Issues/PR numbers, progress logs, campaign phases, and raw test results in PRs/checks rather than the product documents. If a legacy document is retired, update every maintained documentation link to it. Do not delete immutable provenance/verification evidence or reinterpret the original Scriptorium codebase as already migrated.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.
