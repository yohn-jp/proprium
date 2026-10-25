# Proprium

Proprium's target product is a browser-native, Git-native workspace with WASM-first plugins. Read [architecture](docs/architecture/OVERVIEW.md), [Git and storage](docs/architecture/GIT-AND-STORAGE.md), [plugin platform](docs/architecture/PLUGIN-PLATFORM.md), and [delivery/security](docs/architecture/DELIVERY-AND-SECURITY.md) before changing their boundaries. Read [workspace UX](docs/architecture/WORKSPACE-UX.md) for UI work and [compatibility](docs/architecture/COMPATIBILITY.md) when using inherited code.

## Authority and scope

The user request and accepted implementation contract take priority. Proprium's architecture documents define **target behavior**, not assertions of existing support. Most application code remains inherited from Scriptorium until explicitly migrated. Do not silently reinterpret server-based Scriptorium functionality as Proprium functionality or change Scriptorium's own repository.

GitHub is the authoritative remote for user data. Browser drafts and local Git commits remain at risk until remotely confirmed. Plugin code cannot directly own Git publishing, credentials, global browser storage, or host UI authority. Atlas integration is explicitly deferred; do not import or implement it without authorization.

Follow the [organization governance](https://github.com/yohn-jp/.github/blob/main/.github/agent-governance/AGENTS.md) and applicable skills. Inari is suspended. Use a separate branch/worktree and PR; do not write to main, merge, publish or deploy without explicit authorization.

## Verification

For changes to inherited code, use existing package scripts and change-appropriate checks, recording that they cover the **legacy** implementation. Browser-native, mobile Git, plugin sandbox and static-delivery claims require their own real-browser/e2e proofs once implemented. For documentation-only changes, check that links resolve, retired documentation is no longer indexed, and wording distinguishes targets from implemented behavior. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for documentation hygiene.
