# Proprium documentation

These documents define Proprium's architecture and implementation boundaries. The browser Host, Browser Git and WASM plugin runtime are the product runtime. Inherited Scriptorium API, container, Hosted and profile-build entrypoints have been retired; retained module and Core source is not evidence that those paths remain supported.

| Contract | Responsibility |
| --- | --- |
| [Overview](architecture/OVERVIEW.md) | Product boundary, component ownership, local-first invariants |
| [Optional Gateway and Live MCP](architecture/OPTIONAL-GATEWAY-AND-MCP.md) | Browser-alone baseline; optional Go GitHub relay and Live Workspace MCP; binary/Tunnel/security/availability contracts |
| [Git and storage](architecture/GIT-AND-STORAGE.md) | GitHub as remote authority, local Git, durability states, sync/conflict handling |
| [Browser Git implementation](architecture/BROWSER-GIT-IMPLEMENTATION.md) | isomorphic-git + LightningFS, GitHub REST with optional Gateway Smart HTTP fallback, and browser acceptance requirements |
| [Plugin platform](architecture/PLUGIN-PLATFORM.md) | WASM-first installation, packaging, registry, capabilities, UI and lifecycle |
| [WASM plugin ABI](architecture/WASM-PLUGIN-ABI.md) | Component Model/WIT, Worker adapter, grants and versioned messages |
| [Plugin distribution](architecture/PLUGIN-DISTRIBUTION.md) | Immutable signed artifacts, registry, installs, updates and rollback |
| [Delivery and security](architecture/DELIVERY-AND-SECURITY.md) | Static host, Go Gateway, R2 artifacts, privacy and trust boundaries |
| [Live Workspace MCP Gateway](architecture/MCP-GATEWAY.md) | Live-only scope, Host/Gateway ownership, pairing, MCP transport, tools and errors |
| [Gateway configuration and operation](deployment/GATEWAY.md) | Environment settings, non-root operation, Cloudflare Tunnel, binary release and checks |
| [Cloudflare deployment](deployment/CLOUDFLARE.md) | Workers Static Assets, R2 artifact publication and Host release gates |
| [Local development](development/LOCAL-DEVELOPMENT.md) | Browser Host and Gateway setup, checks, mock/live test boundaries |
| [Workspace UX](architecture/WORKSPACE-UX.md) | Desktop/mobile interaction, durable user feedback, extension experience |
| [Compatibility](architecture/COMPATIBILITY.md) | Inherited Scriptorium assets and boundaries of their reuse |
| [Source provenance](architecture/SOURCE-PROVENANCE.md) | Copyright, extraction history and asset/model license requirements |

Legacy Scriptorium-specific Hosted/OCI/release, authoring, module, performance and historical UX documents are not Proprium product authority. They remain available in the original [Scriptorium repository](https://github.com/yohn-jp/scriptorium) and its Git history; immutable evidence already committed in this repository has not been modified.

For repository workflow see [CONTRIBUTING](../CONTRIBUTING.md). Execution evidence belongs in PRs and checks, not architecture documentation.
