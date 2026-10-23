# Verification

Run from the repository root with Node.js and pnpm versions satisfying `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:tests
pnpm typecheck:safety
pnpm test
pnpm build
pnpm audit:core
```

`pnpm test` runs workspace suites and root script tests. `typecheck:tests` includes test sources, and `typecheck:safety` applies stricter scoped compiler checks. Core dependency auditing requires a Core build; use `SCRIPTORIUM_PROFILE=core pnpm build` if a Full build replaced the outputs.

## Browser checks

Install the configured browsers and run acceptance against each profile:

```sh
pnpm exec playwright install chromium webkit
SCRIPTORIUM_PROFILE=core pnpm test:e2e
SCRIPTORIUM_PROFILE=full pnpm test:e2e
```

On a supported host, `SCRIPTORIUM_E2E_CHROMIUM` selects a system Chromium executable. The Playwright configuration and test sources define browser/display requirements and conditional cases. A skipped case is not a passed check. Physical-device keyboards, OS IME and native gestures require device testing beyond synthetic composition events.

Browser acceptance covers editing, conflicts, recovery, shell switching, module contributions, workspace layouts, terminology and job review. Tests use generated repositories and isolated browser state. Do not point fixture-driven tests at author work.

## OCI and integration checks

[OCI verification](OCI.md) checks packaging and startup. [Integration verification](INTEGRATION.md) describes MCP, import, actual model execution and GitHub/container recovery. Hosted producer checks run with:

```sh
pnpm verify:hosted
```

That command verifies local producer/catalog/build composition contracts; it does not certify a deployed Hosted instance or publish a release. It requires a usable OCI engine and capacity for disposable local builds.

`pnpm verify` runs frozen installation, production/test-source/safety type checks, tests, Core and Full builds, Core auditing, browser and OCI checks, MCP, Diagnostics persistence and legacy import acceptance. It requires the configured browsers, OCI engine and tokenizer artifacts. Separate real-provider, real-model and remote/container recovery checks require their own inputs and commands.

## Repository CI and release

`.github/workflows/verify.yml` partitions workspace unit tests, type checks, safety, builds, auditing, browser tests, OCI checks and Hosted Native composition into independent jobs. `scripts/ci-contract.mjs` is the canonical job inventory; coverage checks reject omitted workspaces and test sources. Certification requires every declared leaf job to succeed at the same source SHA.

Local verification and CI are separate results. Record exact commands, source identity, exits and skipped or blocked cases in PR checks and machine artifacts. Keep logs, traces and generated reports outside product documentation. Verification does not publish or deploy; [release publication](OCI-RELEASE.md) uses the gated workflow.
