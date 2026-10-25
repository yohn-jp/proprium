# Proprium

**A browser-native, local-first, Git-native workspace with WASM-first plugins.**

Proprium is intended to run editing, document processing, local Git operations, and optional plugin computations on the user's device. GitHub remains the authoritative remote for committed work; the browser holds a disposable local working copy. A static site can deliver the host, while independently built plugins and large assets can be distributed as immutable artifacts (for example, via Cloudflare R2). No continuously running Proprium application server or container build is part of the target user runtime.

**Implementation status: architecture contract, not a shipped product.** This repository was derived from Scriptorium and still contains its Node.js server, API, OCI packaging, writing-specific modules, and associated tests. The existence of that code does **not** establish that Proprium already works offline, runs Git in mobile browsers, safely executes external WASM plugins, or synchronizes directly with GitHub. Those capabilities require implementation and browser-level verification. Do not deploy the inherited server as if it were a verified Proprium service.

## Architectural authority

- [Architecture and ownership](docs/architecture/OVERVIEW.md)
- [GitHub authority, browser workspaces and sync](docs/architecture/GIT-AND-STORAGE.md)
- [WASM-first plugin platform](docs/architecture/PLUGIN-PLATFORM.md)
- [Static delivery, privacy and security](docs/architecture/DELIVERY-AND-SECURITY.md)
- [Desktop and mobile workspace UX](docs/architecture/WORKSPACE-UX.md)
- [Inherited code and migration boundaries](docs/architecture/COMPATIBILITY.md)
- [Source provenance and licenses](docs/architecture/SOURCE-PROVENANCE.md)

The complete documentation index is at [docs/README.md](docs/README.md).

## Contributing

Until the new runtime exists, the commands in the inherited root package exercise **legacy Scriptorium code**, not the Proprium target architecture. This documentation change does not modify application code, build scripts, tests, workflows, container definitions, deployment, or release artifacts. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before making code changes.

No changes are made to the original [Scriptorium repository](https://github.com/yohn-jp/scriptorium).
