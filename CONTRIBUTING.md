# Contributing to Proprium

The architecture contracts are indexed at [docs/README.md](docs/README.md). [COMPATIBILITY](docs/architecture/COMPATIBILITY.md) records the retired Scriptorium runtime paths and identifies inherited source that is not part of the Browser Host.

- Work in an isolated branch/worktree and submit a PR unless the accepted task explicitly authorizes another integration path; do not bypass branch protection.
- Treat architecture documents as product invariants. Check implementation claims against browser tests and any required live-provider evidence.
- Limit changes to the accepted scope. Keep author workspaces, Git credentials, tokens, model weights, cached indexes, and private material out of commits and test fixtures.
- Preserve GitHub remote authority, browser-local failure semantics, host-owned writes, plugin capability boundaries, and current-data provenance.
- Record exact checks performed and checks unavailable. Tests of preserved legacy Node packages do not certify mobile Safari, browser Git, WASM isolation, or a public static deployment.
- Follow the [organization agent governance](https://github.com/yohn-jp/.github/blob/main/.github/agent-governance/AGENTS.md).

## Browser Host checks

The product build and canonical local checks target the Proprium Browser Host:

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck:browser
pnpm test:browser:unit
pnpm test:ui:unit
pnpm test:browser:e2e
pnpm test:browser:static:e2e
pnpm test:browser:adapters
pnpm build:browser
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
~~~

`pnpm build` emits the static Proprium Host at `dist/proprium/`; it does not invoke Scriptorium profile builds or the retired Node server. `pnpm verify:browser` runs typechecking, focused unit tests, a static build and Wrangler dry-run. CI also runs the Chromium and WebKit acceptance suite. The dry-run does not contact or change a Cloudflare account.

Gateway source lives in `gateway/`. Use the repository-pinned Go toolchain and run `cd gateway && go test -race ./... && go vet ./...`. `.github/workflows/verify-gateway.yml` runs those checks, cross-builds five CGO-free platform binaries, exercises installation with a real systemd user manager, packages and verifies the distribution bundles, and uploads commit-named build artifacts on push and pull requests; these artifacts are not Releases. The Browser Verification E2E job also starts the Gateway beside the Host and exercises Live MCP in Chromium and mobile WebKit. `.github/workflows/release-proprium-gateway.yml` also runs on pushes to `main` and automatically publishes a versioned Gateway GitHub Release after verification succeeds; manual dispatch requires an existing canonical Gateway tag on `main`. See [Gateway operations](docs/deployment/GATEWAY.md) for asset verification, bootstrap and release contents. The local manager tests do not exercise a real Cloudflare Tunnel, Access policy or production OAuth/MCP provider path.

The Linux amd64/arm64 `proprium` CLI manages installation, configuration and one systemd user service for the Gateway and its pinned `cloudflared` executable. Changes to release acquisition or service lifecycle must preserve same-release digest/checksum/manifest verification, user-owned XDG paths, private secret-file handling, update rollback and active MCP maintenance protection. Managed CLI installation and service operations are unsupported on Windows and macOS, although Gateway runtime bundles are published for those platforms. Local CLI validation cannot establish Cloudflare account state, public Tunnel behavior or production OAuth/MCP operation.

These checks exercise the browser-native runtime. Tests of preserved inherited libraries remain limited to the packages and execution mode they actually cover; they do not certify browser storage behavior, live GitHub sync, mobile browser behavior, WASM isolation or a public static deployment.

## Documentation

Maintain documentation as durable product/architecture contracts: responsibilities, invariants, declared limitations, and acceptance conditions. Keep dates, branch/commit reports, Issues/PR numbers, progress logs, campaign phases, and raw test results in PRs/checks rather than the product documents. If a legacy document is retired, update every maintained documentation link to it. Do not delete immutable provenance/verification evidence or reinterpret the original Scriptorium codebase as already migrated.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.


For changes to the Authoring Plugin Canon, run `node scripts/verify-authoring-canon.mjs`. When the read-only Scriptorium and Arcadia Loom sibling checkouts are available, run `node scripts/verify-authoring-canon.mjs --sources /path/to/source-parent` to also verify pinned source paths and action registrations. The checker verifies feature-to-acceptance traceability, links and the required dependency DAG; it does not certify implemented plugins or browser behavior. Review the actual action/data/UX contracts and all applicable acceptance scenarios alongside its result.
