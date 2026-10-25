# Proprium documentation

These documents define the **target architecture** for Proprium, not the current state of the forked implementation. The checked-in Node/API/container code still reflects Scriptorium until explicitly replaced.

| Contract | Responsibility |
| --- | --- |
| [Overview](architecture/OVERVIEW.md) | Product boundary, component ownership, local-first invariants |
| [Git and storage](architecture/GIT-AND-STORAGE.md) | GitHub as remote authority, local Git, durability states, sync/conflict handling |
| [Plugin platform](architecture/PLUGIN-PLATFORM.md) | WASM-first installation, packaging, registry, capabilities, UI and lifecycle |
| [Delivery and security](architecture/DELIVERY-AND-SECURITY.md) | Static host, R2 artifacts, cache, privacy, supply chain and trust boundaries |
| [Workspace UX](architecture/WORKSPACE-UX.md) | Desktop/mobile interaction, durable user feedback, extension experience |
| [Compatibility](architecture/COMPATIBILITY.md) | Inherited Scriptorium assets and boundaries of their reuse |
| [Source provenance](architecture/SOURCE-PROVENANCE.md) | Copyright, extraction history and asset/model license requirements |

Legacy Scriptorium-specific Hosted/OCI/release, authoring, module, performance and historical UX documents are not Proprium product authority. They remain available in the original [Scriptorium repository](https://github.com/yohn-jp/scriptorium) and its Git history; immutable evidence already committed in this repository has not been modified.

For repository workflow see [CONTRIBUTING](../CONTRIBUTING.md). Execution evidence belongs in PRs and checks, not architecture documentation.
