# Inherited code and target compatibility boundary

**Status: inventory/ownership guidance, not an implementation progress report.**

Proprium began from [Scriptorium](https://github.com/yohn-jp/scriptorium). Its existing TypeScript monorepo, Git-backed authoring code, Node API, container packaging, CI and optional modules remain physically present at this fork until deliberately changed. Retiring Scriptorium-specific **documentation** does not delete those files, establish static-only deployment, or certify the new runtime.

| Inherited area | Potentially reusable responsibility | Target boundary |
| --- | --- | --- |
| app / Editor / Desktop and Mobile shells | Editing, Japanese typography, layout and interaction components | Browser Host UI with distinct mobile and desktop experiences; no mandatory API for editing |
| app / BrowserJournal and draft logic | Local temporary work/recovery conventions | Noncanonical browser worktree/cache; no stronger durability claim |
| packages/contracts | Snapshot identity, file revision, mutation/proposal types | Browser-neutral Host ports and public versioned plugin contracts; no leaking private TypeScript ABI |
| packages/core | Git-backed document reads, operations and safe publication semantics | Must replace Node filesystem, subprocess Git and server-managed clone assumptions with browser-local Git |
| packages/api | Server HTTP/auth admission, session and static serving | Not in target runtime; transport-only functionality may survive if justified and optional |
| packages/module-runtime | Metadata, dependency resolution, capabilities and cancellation patterns | WASM-first browser Plugin Manager; replace Node child-process supervisor and container profiles |
| modules | Search, story, NLP, semantic, diagnostics, speaker, assistant, publishing and MCP algorithms | Classify each by browser compatibility, local compute, permitted external services and public Plugin API |
| Dockerfile, buildkit, hosted scripts and OCI CI | Legacy packaging/verification | Do not treat as Proprium deployment requirements; removal is a later implementation change |
| Atlas/Story Knowledge external repository | Existing independent browser Host, graph and canvas experiments | Separate product integration; deliberately deferred |

The core work repository format is **generic Git files**, not the Scriptorium-only Arcadia hierarchy. Optional writer-specific editors may interpret legacy structures without making those structures mandatory.

Migration shall preserve legally reusable application code and documented artifact provenance; do not blindly transplant server-only dependencies, private source fixtures, copyrighted works, credential material or historical Scriptorium hosting assumptions. An existing test may continue to pass while the new browser product remains unimplemented.

## Verification authority

- Existing package scripts and tests prove behavior only for the inherited source revision and execution mode they actually exercise.
- New product implementation requires browser-native Git/permission/storage tests, actual GitHub sync tests, plugin WASM/lifecycle/sandbox tests and static distribution verification.
- Do not delete the immutable evidence or source provenance retained by the fork merely because the Scriptorium product documentation has been retired.
- Original Scriptorium documentation and application evolution remain in its own repository. Proprium is not obliged to preserve Scriptorium's container deployment features.

Canonical target: [overview](OVERVIEW.md), [Git](GIT-AND-STORAGE.md), [plugin platform](PLUGIN-PLATFORM.md), [delivery/security](DELIVERY-AND-SECURITY.md) and [UX](WORKSPACE-UX.md).
