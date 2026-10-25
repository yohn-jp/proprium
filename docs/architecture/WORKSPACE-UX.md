# Proprium workspace UX

**Status: target behavior.** Legacy Scriptorium Desktop/Mobile implementations can be reference material but are not evidence of support for this contract.

## Shared intent, distinct device interactions

Desktop and mobile share repository identity, Git state, permission checks and plugin capability contracts. They **must not** be the same shrunken layout: desktop prioritizes multiple concurrent panes, keyboard navigation, drag/dock operations and shortcuts; mobile prioritizes active-document continuity, thumb-reachable controls, focused tasks, sheets/tab navigation, orientation, virtual keyboard/IME behavior and bounded memory. Accessibility and keyboard alternatives are required in both.

The Host always provides a usable basic file browser/editor/diff/history and **local Git** surface even with no plugins, Gateway, login, model, network or unsupported device acceleration. Remote synchronization is an optional capability when authenticated access is available. Plugins offer optional panels, commands and contextual views; missing/failed plugin content cannot hide the editor or the user's Git state.

## Save semantics and visible statuses

- **Edited locally:** uncommitted worktree changes; may be lost.
- **Committed on this device:** normal local Git commit; not yet in GitHub and still vulnerable to local storage loss.
- **Syncing:** an explicitly requested remote operation is underway; do not block typing unnecessarily.
- **Published to GitHub:** remote branch confirmation after authorized push.
- **Conflict / remote unknown / offline:** show the exact blocker, preserve locally available data, and offer an actionable retry or review path without reporting success.

Local autosave or recovery conveniences may exist, but must not be labeled remote save, and their failure must never be hidden behind an optimistic success message. No automatic force-push, silent background publication or unreviewed plugin commit.

User-facing affordances must distinguish local commit from GitHub publication without relying on tooltips or color alone. A user operating on mobile must be able to inspect pending work and publish without switching to desktop.

## Foreground correctness

Keep live editor input, selection, IME composition, undo history and current document above any indexing, sync, plugin download or model initialization. A Worker result tied to an older file revision must not replace current text. Navigation across repositories/files and changes to UI layouts must explicitly handle unsaved edits; a warning may be appropriate because drafts are not guaranteed durable.

Load plugins and heavy assets after essential editing UI. Show network/model download size and device capability requirements before initiating optional large transfers. Let users disable, update or remove plugins independently; never conflate installed, enabled, idle, unavailable and executing.

## Workspace composition

Host-controlled layouts store declarative panel IDs, placement and non-secret preferences, not arbitrary executable code. Invalid saved layouts fall back to a safe, accessible default. Distinct mobile and desktop layouts may be stored locally and are not automatically Git-tracked.

Host-rendered plugin UI uses validated declarations; it cannot change global keyboard routing, interfere with touch/IME, or claim remote publish state. Custom canvas extensions require separate approved isolation and interaction contracts; Atlas is not included in this initial Proprium contract.

## Acceptance

Verify on actual desktop/mobile browser classes: text input and IME, navigation with edited text, commit vs push labels, offline editing, plugin install and failure, large asset opt-in, storage quota/error, tab suspension and reload, conflict review and accessibility. Responsive screenshots alone do not establish mobile usability.

See [architecture](OVERVIEW.md) and [Git/data states](GIT-AND-STORAGE.md).

## Optional Gateway and Live MCP experience

Do not gate the initial page, workspace creation/open, typing, local save, local commit or cached WASM plugin run on a Gateway URL or health check. Gateway setup is a separately discoverable enhancement, not a mandatory onboarding step. A configurable compatible Gateway enables GitHub sign-in and explicit Live Workspace MCP. No PAT entry is introduced as a substitute for Gateway OAuth.

Live MCP is **off by default**. Show its selected Workspace, connection status, authorized client(s), explicit enable/disable and revocation, and review/approve/reject controls for proposed writes. A disconnected Gateway or suspended browser marks MCP unavailable without altering the local editor or inventing durable remote state. Do not imply mobile background availability. See [Gateway/MCP contract](OPTIONAL-GATEWAY-AND-MCP.md).
