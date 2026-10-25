# Proprium

**A browser-native, local-first, Git-native workspace with WASM-first plugins.**

Proprium runs editing, local Git operations and optional plugin computation in the browser. GitHub remains the authoritative remote for committed work; browser workspaces are local copies. The Host is built for static delivery, and independently built plugins and large assets can be distributed as immutable artifacts such as Cloudflare R2 objects. The product runtime has no Node application server, container or Hosted profile.

The browser Host is implemented under `app/src/browser/proprium/host`, using the Browser Git adapter and WASM Component Model runtime in `app/src/browser/proprium`. The retired Scriptorium API, OCI, Hosted and profile-build entrypoints are not part of the Proprium product. Retained Core and module packages are inherited source; they do not establish additional supported runtimes.

Browser, GitHub and plugin security claims depend on the acceptance checks for the supported browsers and release build. A passing legacy Node test does not certify browser storage, mobile Git, WASM isolation or static delivery.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository workflow and verification guidance.

No changes are made to the original [Scriptorium repository](https://github.com/yohn-jp/scriptorium).
