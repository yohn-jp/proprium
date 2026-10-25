# Contributing to Proprium

The canonical proposed design is indexed at [docs/README.md](docs/README.md). [COMPATIBILITY](docs/architecture/COMPATIBILITY.md) separates inherited Scriptorium code from Proprium's intended runtime.

- Work on an isolated branch and submit a PR; do not alter main directly.
- Treat architecture documents as target contracts, not claims that the inherited source is conformant.
- Limit changes to the accepted scope. Keep author workspaces, Git credentials, tokens, model weights, cached indexes, and private material out of commits and test fixtures.
- Preserve GitHub remote authority, browser-local failure semantics, host-owned writes, plugin capability boundaries, and current-data provenance.
- Record exact checks performed and checks unavailable. Passing legacy Node/OCI tests does not certify mobile Safari, browser Git, WASM isolation, or a static Proprium deployment.
- Follow the [organization agent governance](https://github.com/yohn-jp/.github/blob/main/.github/agent-governance/AGENTS.md).

## Browser Host checks

The product build and canonical local checks target the Proprium Browser Host:

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck:browser
pnpm test:browser:unit
pnpm test:browser:e2e
pnpm build:browser
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
~~~

`pnpm build` emits the static Proprium Host at `dist/proprium/`; it does not invoke Scriptorium profile builds or the retired Node server. `pnpm verify:browser` runs typechecking, focused unit tests, a static build and Wrangler dry-run. CI also runs the Chromium and WebKit acceptance suite. The dry-run does not contact or change a Cloudflare account.

These checks exercise the browser-native runtime. Tests of preserved inherited libraries remain limited to the packages and execution mode they actually cover; they do not certify browser storage behavior, live GitHub sync, mobile browser behavior, WASM isolation or a public static deployment.

## Documentation

Maintain documentation as durable product/architecture contracts: responsibilities, invariants, declared limitations, and acceptance conditions. Keep dates, branch/commit reports, Issues/PR numbers, progress logs, campaign phases, and raw test results in PRs/checks rather than the product documents. If a legacy document is retired, update every maintained documentation link to it. Do not delete immutable provenance/verification evidence or reinterpret the original Scriptorium codebase as already migrated.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.
