# Proprium

Proprium is a browser-native, Git-native workspace with WASM-first plugins and an optional Go Gateway for OAuth, restricted Git Smart HTTP and explicitly enabled Live Workspace MCP. Read [architecture](docs/architecture/OVERVIEW.md), [Git and storage](docs/architecture/GIT-AND-STORAGE.md), [plugin platform](docs/architecture/PLUGIN-PLATFORM.md), and [delivery/security](docs/architecture/DELIVERY-AND-SECURITY.md) before changing their boundaries. Read [workspace UX](docs/architecture/WORKSPACE-UX.md) for UI work, [MCP Gateway](docs/architecture/MCP-GATEWAY.md) for its protocol contract, and [compatibility](docs/architecture/COMPATIBILITY.md) when using inherited code.

The static Host must support local editing, local Git and admitted/cached WASM plugins without a Gateway, login or remote call. The [optional Gateway boundary](docs/architecture/OPTIONAL-GATEWAY-AND-MCP.md) applies to every integration.

## Authority and scope

The user request and accepted implementation contract take priority. Proprium's architecture documents define **target behavior**, not assertions of existing support. Most application code remains inherited from Scriptorium until explicitly migrated. Do not silently reinterpret server-based Scriptorium functionality as Proprium functionality or change Scriptorium's own repository.

GitHub is the authoritative remote for user data. Browser drafts and local Git commits remain at risk until remotely confirmed. The Gateway has no durable state and cannot store repositories, workspace contents, indexes or Git objects. Plugin code cannot directly own Git publishing, credentials, global browser storage, or host UI authority. Atlas integration is explicitly deferred; do not import or implement it without authorization.

Follow the [organization governance](https://github.com/yohn-jp/.github/blob/main/.github/agent-governance/AGENTS.md) and applicable skills. Inari is suspended. Use an isolated branch/worktree unless the user explicitly authorizes a different lifecycle. Never force-push or destroy remote resources without confirming their identity and use.

## UI continuity

Preserve the recovered Desktop/Mobile shells, workspace composition, CodeMirror editor, reading/typography and appearance controls. Runtime migration does not authorize replacing or deleting the product UI. Keep Browser Git/Gateway integration behind those UI components; do not reactivate the former Node application controller.

## Verification

For changes to inherited code, use existing package scripts and change-appropriate checks, recording that they cover the **legacy** implementation. Browser-native, mobile Git, plugin sandbox and static-delivery claims require their own real-browser/e2e proofs once implemented. For documentation-only changes, check that links resolve, retired documentation is no longer indexed, and wording distinguishes targets from implemented behavior. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for documentation hygiene.
