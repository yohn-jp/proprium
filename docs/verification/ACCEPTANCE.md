# Initial Core acceptance

Verified on 2026-10-16 against the integrated application and actual production image. Runtime implementation is main commit `2067a9292d4f4670e0824ead59955fca2a8613e0`; later acceptance-test and documentation commits do not change those runtime files. The coordinator independently reran the browser flows after integrating the tests and compared the container's compiled Core, API and app hashes to the current checkout. The final main commit is reported in the delivery response.

## Executed checks

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm typecheck` | Pass: Core, browser app, API |
| `pnpm test` | Pass: 13 Core tests, 4 HTTP/auth tests, 3 draft tests |
| `pnpm build` | Pass: compiled Core/API and static browser app |
| `pnpm audit:core` | Pass: installed dependency and compiled-import audit |
| Chromium browser acceptance with isolated local Git remote | Pass: actual compiled Core/API/app; one full journey |
| Chromium browser acceptance against the OCI container and real GitHub remote | Pass: one full journey; successful remote push independently confirmed |
| Pinned Dockerfile build as an OCI image and real container startup | Pass: rootless Podman 5.8.8, linux/amd64 |
| Production dependency closure | `yaml@2.9.1` only; no development tools or NLP/LLM packages |
| Publication review | No workflows/templates, private runtime data, model artifacts, or Arcadia Git ancestry in main |

The HTTP tests isolate the handler with a small store double; they prove authentication and transport behavior. Core tests use actual temporary Git repositories. Browser acceptance uses the composed production packages, and the external run uses the actual OCI runtime and GitHub. These are distinct checks; a mock is not evidence of persistence or synchronization.

## Acceptance mapping

- **Repository registration and isolation:** production accepts HTTPS GitHub URLs, assigns opaque project IDs, and retains a persistent registry. Empty and existing compatible repositories are covered. Invalid IDs, traversal, symlink crossings, Git metadata targets and wildcard pathspecs are rejected or treated literally before writes.
- **Work navigation and writing:** the browser opens volume/chapter/scene YAML and its linked manuscript. A second browser context edits and saves the manuscript, reloads, and sees the durable text. Core tests preserve unknown YAML/frontmatter and unrelated staged files.
- **Draft protection:** scene navigation and reload retain the first writer's unsaved draft. The original base revision survives recovery. A delayed conflict reread while navigating to another scene cannot overwrite the prior draft or display the wrong scene's conflict.
- **Conflicting updates:** the second writer commits; the first writer's stale PUT returns 409, leaves canonical text unchanged, and retains its draft even through reload. Core tests also run simultaneous updates through one store and through independent stores sharing the same data directory, proving a single committed winner.
- **History and sync:** history includes the new save and correctly handles empty commit subjects. Local tests cover push, upstream fast-forward, dirty-state reporting and divergent histories. The live OCI browser flow synchronizes to GitHub and reports a clean tree with ahead/behind both zero. The coordinator compares the GitHub ref and file contents with container state; frontmatter remains present.
- **Core-only production:** no model credentials, optional NLP packages, inference runtime, analysis jobs or downloaded models are needed. The final image includes only the required compiled assets and production JavaScript closure. It starts as UID 1000, serves health and all static module assets, and can write its persistent `/data` volume.
- **Public foundation:** PR #3's existing commits were fast-forwarded into main. README, MIT license, security/contribution guidance, architecture and [migration ownership map](../architecture/MIGRATION.md) describe the shipped single-owner runtime. Arcadia Loom was not modified.

The GitHub test uses only synthetic fixtures on temporary branch `acceptance/core-20261016` in the target repository. The branch is deleted after final verification. Live tracing is disabled so authentication tokens are not retained in test artifacts. No real writing or credentials are committed. GitHub Actions, CI and organization-template synchronization were neither added nor executed.

## Reproducing browser checks

With a standard host browser installation:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

On the verification NixOS host:

```sh
nix shell nixpkgs#chromium --command bash -c \
  'chromium_bin=$(command -v chromium); SCRIPTORIUM_E2E_CHROMIUM="$chromium_bin" pnpm test:e2e --trace off'
```

For an existing OCI instance, set `SCRIPTORIUM_E2E_BASE_URL`, `SCRIPTORIUM_AUTH_TOKEN`, `SCRIPTORIUM_E2E_REPOSITORY_URL` and `SCRIPTORIUM_E2E_REPOSITORY_BRANCH` before the same command. The disposable remote must contain `Volume One`, `Chapter One`, `Scene One` / `scene-1`, and `Scene Two` / `scene-2`, with the latter body including `The second line of the story.`. The test creates commits and pushes to that branch; use synthetic data and a disposable branch. GitHub credentials are supplied only to the application container. Use `--trace off` for credential-bearing live runs.

See [OCI.md](OCI.md) for the exact image ID, manifest digest, base image pin, runtime dependency manifest and host-specific build setup. The image is built and verified locally; registry publication is not claimed.

## Scope and remaining work

No initial Core acceptance item remains open. The application intentionally serves one trusted owner per instance. Creating a full work hierarchy, multi-user hosting, optional analysis add-ons, CI, release automation and image registry publication remain outside this accepted recovery. Git divergence and abandoned writer locks require the explicit recovery procedures in README/SECURITY; Core does not silently resolve them by overwriting data.
