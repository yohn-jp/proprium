# Proprium workspace UX

**Status: UX contract with browser implementation.** The Host uses the recovered Scriptorium Desktop/Mobile shells and original CodeMirror manuscript editor through browser-owned adapters. It retains dock/split/floating layouts, device-specific navigation, three appearance modes, typography, preview, ruby and reading controls. The former Node application controller is not used. Requirements below still need change-appropriate browser verification.

The [Authoring Plugin Canon](../canon/README.md) defines the mandatory *future* Writer experience, first usable Narrative plugin and supporting Story/Research/Review features; their absence is a documented recovery gap, not grounds to redefine Proprium as a novel-only Core. The [feature and screen catalogue](SCREEN-CATALOG.md) maps connected source surfaces and missing paths. The [user flows](USER-FLOWS.md) define function-based transitions, including cancellation and recovery; [UI architecture](UI-ARCHITECTURE.md) defines their state and authorization boundaries. These are target contracts where the catalogue identifies a gap, not a claim that every required screen is already implemented.

`HostApp` owns repository selection, Browser Git, GitHub OAuth, plugins and Live MCP. `RestoredEditor` binds the original editor to generic file paths and a local IndexedDB recovery journal. Layout and appearance storage keys are retained. Switching panels retains editor input, undo and reading state, plus the single plugin/MCP instance; closing a tool panel does not revoke clients or restart plugins. Checkpoint opens local Git review; Save draft writes the local worktree, and GitHub publication remains explicit.

When Browser Git reports `storage_unknown`, a native dialog outside the shell/status shelf exposes **保存データの整合性を確認**. It invokes the existing worker verification and only clears the uncertainty marker on success. The dialog names the workspace, shows verification failures, and can be reopened with **Git保存状態を確認** after dismissal. Failure preserves the marker and stored bytes; no reset/delete action is substituted for verification.

## Shared intent, distinct device interactions

Desktop and mobile share repository identity, Git state, permission checks and plugin capability contracts. They **must not** be the same shrunken layout: desktop prioritizes multiple concurrent panes, keyboard navigation, drag/dock operations and shortcuts; mobile prioritizes active-document continuity, thumb-reachable controls, focused tasks, sheets/tab navigation, orientation, virtual keyboard/IME behavior and bounded memory. Accessibility and keyboard alternatives are required in both.

The Host must provide a usable basic file browser/editor/diff/history and **local Git** surface even with no plugins, Gateway, login, model, network or unsupported device acceleration. Remote synchronization is an optional capability when authenticated access is available. Plugins offer optional panels, commands and contextual views; missing/failed plugin content cannot hide the editor or the user's Git state.

Live Workspace MCP is separate and explicit. It is off by default, and the Host opens no Gateway SSE connection while it is disabled. The owner selects a Gateway, enables the current workspace, reviews its published capabilities and authorizes or revokes individual MCP clients. The Host shows connection state and pending calls. A requested file change becomes a Host review proposal; an MCP call cannot silently apply it or publish a commit. Closing or suspending the browser can disconnect the workspace, and MCP clients then see it as unavailable until the owner reconnects.

GitHub sign-in displays the Device code before the user opens GitHub. The Host distinguishes waiting for authorization, loading repositories, connected and failed states. A failed repository-list request cannot leave a falsely connected account. Reopening a recent workspace reuses the current authenticated session when available; without one it opens locally. Device authorization can be canceled without allowing a superseded request to overwrite a later sign-in. Appearance modes must preserve readable foreground/background contrast in both the picker and editor surfaces.

## Task placement and navigation

Initial local start, Gateway trust selection, GitHub device authorization and repository selection belong in the desktop main area or a dedicated full-width mobile task surface, not only in the narrow editing sidebar. Preserve the recovered shells and editor; opening an authentication task must not create a second workspace runtime. Show the device code, approval link, waiting/expiry state, cancellation and retry separately.

Use the catalogue screen IDs and flow guards for Home, file/panel navigation, settings, Back/Forward and recovery. Keep GitHub sign-in, Live owner authorization and individual MCP client grants distinct. GitHub sign-out is not an implicit substitute for Stop Live MCP. A hidden tools panel is not a disabled plugin or revoked live session.

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
