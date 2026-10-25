# Inherited code and the Proprium runtime boundary

**Status: implementation boundary.** Proprium uses a browser-native Host, Browser Git and a WASM Component Model plugin runtime. Scriptorium source is not a second supported product runtime.

| Inherited area | Proprium status |
| --- | --- |
| `app/src/browser/proprium/git` | Browser-owned Git adapter and GitHub synchronization. This is the only Git workspace runtime used by the Host. |
| `app/src/browser/proprium/plugin-runtime` and `app/src/browser/proprium/plugin-artifact.ts` | Browser Worker, WIT component runtime, capability broker and artifact admission. External plugins use this runtime; the Host remains trusted TypeScript. |
| `app/src/browser/proprium/host` | Browser Host UI and workspace. It handles generic repository files and does not require Scriptorium's manuscript hierarchy. |
| `app/src/shells`, `app/src/workspace`, `app/src/editor` and `app/src/storage/journal.ts` | Recovered original Desktop/Mobile UI, dock/floating layouts, CodeMirror, reading/typography and recovery journal. `RestoredEditor` connects these components to Browser Git; the former Node application controller is not activated. |
| `packages/api` | Retired. No Node HTTP application server, Hosted authorization service or server-managed Git path is part of the Proprium runtime. |
| `packages/core` and `packages/module-runtime` | Inherited Scriptorium packages retained as source for provenance and reusable algorithms. They are not imported by or required to run the browser Host. Their Node-backed execution is not Proprium product support. |
| `packages/contracts` | Shared value types and validation used by the recovered UI/recovery journal. It does not provide a server or impose a manuscript hierarchy on repository files. |
| `packages/migration` | Inherited import tooling; migration data is not silently treated as Proprium Core state. |
| `modules/*` | Inherited optional Scriptorium modules. Their presence does not mean they are installed Proprium plugins or part of the default Host. New external plugin execution uses the versioned WASM/WIT platform. |
| Docker, BuildKit, OCI, Hosted and profile build paths | Retired from the repository's product build and release path. Static Host delivery and independently published plugin artifacts have separate build lifecycles. |

The Core work repository format is **generic Git files**, not the Arcadia-specific plot, scene or manuscript hierarchy. Optional migration tooling may inspect Scriptorium exports, but it cannot make those formats mandatory or silently rewrite user files.

Migration preserves legally reusable application code and documented artifact provenance. It does not copy server-only execution into the Host, private source fixtures, copyrighted works, credential material, model weights or historical Scriptorium hosting assumptions. Immutable evidence committed with the fork remains historical evidence; it does not certify the Proprium browser runtime.

## Verification authority

- Existing Scriptorium package tests prove only the inherited behavior and execution mode they exercise. They do not certify Proprium.
- Proprium acceptance requires browser Git, GitHub synchronization, actual WASM plugin lifecycle and admission, static build/delivery, and desktop/mobile browser proofs.
- Do not delete immutable provenance or verification evidence when retiring the implementation paths it records.
- Original Scriptorium documentation and application evolution remain in its own repository. Proprium's product runtime does not include Scriptorium's server or container features.

Canonical target and implementation contracts: [overview](OVERVIEW.md), [Git](GIT-AND-STORAGE.md), [plugins](PLUGIN-PLATFORM.md), [delivery/security](DELIVERY-AND-SECURITY.md), [UX](WORKSPACE-UX.md), and [provenance](SOURCE-PROVENANCE.md).

## Optional server-side compatibility boundary

The Go Gateway is an **optional transport/MCP bridge**, not restoration of Scriptorium's Node API or Hosted runtime. It must never take over Browser Host files, local Git, WASM compute or proposal approval. It replaces the former Cloudflare GitHub relay in the source and release paths; repository removal does not retire a remote deployment. Live MCP provides only a connection to the active Browser Host, **not** Scriptorium's server-owned project or narrative tools. See [Optional Gateway and MCP](OPTIONAL-GATEWAY-AND-MCP.md).
