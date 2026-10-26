# Host/Plugin Contract — Required Recovery Extensions

## Status and authority

This is the **normative target boundary** for authoring plugin portability, not a declaration that it has been implemented. Existing Host v1 is functional for demo computation but **insufficient for a Narrative IDE**. Implement missing Host capabilities once, generically, instead of embedding Story Knowledge logic into trusted Host code.

### Existing implementation (do not misreport)

- `app/src/browser/proprium/plugin-runtime/wit/main.wit` defines `snapshot-list`, `snapshot-read`, `propose-change` and `ui-contribute`, with `panel/command` contributions comprising **only kind/id/title**.
- `app/src/browser/proprium/host/PluginPanel.tsx` lists registered contribution *labels*, not functioning novel navigation/forms/graphs, and `takeSnapshot` eagerly reads **at most 256 files / 2 MiB**. It may not be used as the production full-work read path.
- `scripts/build-plugin-registry.mjs` hardcodes `proprium.compute-sum`. Signed registry/admission works for its sample, not as a builder for the eight official authoring plugins.
- `gateway/mcp.go` exposes the permanent eight core tools; `plugin_call` currently invokes a generic `run` against enabled active-workspace plugins. This is not narrative-action conformance.

Keep current v1 tests green during migration. When adding incompatible features, version WIT/manifest independently and migrate in one deliberate cutover; do **not** quietly change existing `proprium:plugin@1.0.0` semantics.

## Host-owned contract surfaces required

| Versioned family | Minimum typed operation | Invariants |
| --- | --- | --- |
| `workspace.identity.read` | repo ID, branch, current pinned commit+overlay, workspace/generation | plugin may not choose another repository implicitly |
| `workspace.file.list` | `{prefix?, cursor?, limit?} → {items, nextCursor, snapshot}` | bounded paging; stable deterministic path order and revision; no all-repo upfront load |
| `workspace.file.read` | `{path, snapshot, range?} → {bytes/text, revision/hash}` | exact snapshot scope and path validation; explicit binary/encoding error |
| `workspace.navigation` | `{target: {path?, sceneId?, panelId?}, intent, expectedContext}` | navigate only after Host flush/dirty guard; preserve selection/focus |
| `workspace.ui.contribute` | validated panels, outline trees, list/detail, form, search results, status, editor decorations, commands, review links | Host renders owned widgets; no guest HTML, React or CSS |
| `workspace.change.propose` | typed ChangeSet with operation IDs and evidence, expected read/write revisions | never direct write, approval, commit or publication |
| `workspace.derived.cache` | `{pluginId, snapshot, schemaVersion, config/modelDigest, key}` scoped get/put/evict | disposable, quota-bound; no Git/author-draft storage |
| `workspace.events.subscribe` | bounded revision/selection/visibility/activation signals | no indefinite polling; gap means re-read |
| `workspace.capabilities.query` | Host-side capability negotiation and precise unavailable errors | no silent fallback to different algorithm/model |

Implementation may collapse some of these into fewer WIT imports as long as typed behavior, versioning and isolation remain unchanged. Host must give model-independent lazy providers a separate lifecycle; no implicit model download for `repositories_list` or lexical search.

### Canonical type envelopes (logical JSON, WIT code generated from adopted schema)

~~~json
{
  "scope": {"repository_id": 123, "branch": "main", "workspace_id": "opaque", "generation": "opaque"},
  "snapshot": {"remote_commit": "sha", "overlay_commit": null, "worktree_generation": "opaque"},
  "target": {"work_id": "work", "volume_id": "vol", "chapter_id": "chap", "scene_id": "scene", "path": "manuscript/...md"},
  "request": {"id": "opaque", "action_id": "narrative.scene.open", "effect": "read", "input": {}}
}
~~~

`repository_id` follows the existing immutable GitHub numeric identity (other Git remotes need a separately typed provider ID). Workspace local IDs and legacy project IDs must not masquerade as the GitHub ID. Every response carries the observed snapshot; applied proposals return resulting snapshot and per-operation receipts.

**Action effects** are explicitly `read`, `propose` or Host-only `apply`. Plugin actions declare stable qualified IDs and JSON-schema/WIT input-output types; Host UI and MCP route through the same dispatch, validation, caps and errors. Adapter must reject unknown action IDs and extra input instead of parsing free-form prompt text as a mutation.

## Writer interaction contract

- Host-owned `OutlineTree` accepts ID/title/order/parent and invocation descriptors. Plugin supplies hierarchical data; Host handles keyboard, tree virtualization, reorder gesture and accessible non-drag alternative. Reorder produces a **proposal**, not a hidden Git write.
- Host-owned `ContextPanel` supports contextual sections, tab/breadcrumb, cite/evidence navigation, stale markers and a bounded preview. Plugin may register related entities, diagnostics and ChangeSet queue actions. Context follows selected scene/selection but MUST NOT replace text or force focus.
- Host-owned `DataTable`, `DetailEditor`, `ReviewPanel`, `Graph/Map/Timeline` presentation primitives can be introduced incrementally as actual recovered products demand them. Advanced Story Lens is a projection of Story Knowledge data, not an alternative canonical graph. If a visualization genuinely requires code-rendered pixels, use reviewed Host implementation or separately approved isolated iframe; do not grant untrusted plugin DOM access.
- The current Host `SceneEditor`, `RestoredEditor` and CodeMirror remain Host components. Narrative maps scene IDs and Markdown paths to this editor. A plugin cannot replace the editor's writable backing store.
- From a narrative title/scene selection: opening a scene MUST update the shared Host selection, activate the same manuscript, and preserve IME, caret, scroll/reading page, recovery and per-document editor instance when reference panels change. Mobile projection uses sheets and focus restoration, not desktop dock resized onto a phone.
- Plugin contributions appear in the **normal Host panel registry and presets**, not just `PluginPanel`'s output list. Removing a plugin yields a clear disabled/unavailable placeholder; generic Git continues.

## Snapshot/read and long-project scaling

Never force a user to fit hundreds of chapters/scenes into a single UTF-8 `RuntimeSnapshot`. The current limit (`256 files / 2 MiB / 128 KiB proposal file`) describes a *v1 implementation*, not the recovery acceptance for large works.

Readers list by path prefix and cursor, open selected file by pinned revision, stream or chunk long text with bounded bytes, and independently cache parsed work hierarchy and derived indexes. Scene navigation only needs the selected scene + adjacent hierarchy; distant Bible/reference data is lazy. A derived result is valid only for the exact repository, branch, worktree overlay, corpus/configuration generation, algorithm version and model digest (if applicable). A cache miss rebuilds in bounded work, never rewrites source.

## ChangeSet and recovery semantics

- Apply uses Host's sole local Git writer, exact expected versions and a declared set of paths. For inserts/reorders, prefer typed `scene.insert`/`move` semantics with **stable order/neighbor preconditions**, compiled into guarded file updates by the Host.
- A proposed change must be visible as a complete diff, source quote/evidence and target paths before any bytes mutate. Partial approval preserves action boundaries; unsupported partial atomicity must be shown as unavailable, not faked.
- Review never reads a newer draft as if it were the proposal base. A dirty editor or changed scene makes a proposal stale/pending reconciliation; no silent overwrite, force publish, repeated idempotent effect or deletion of recovery entries.
- Host records a stable operation/proposal identity; retry after network loss fetches status/receipt before reapplying. Return status `proposed / approved / rejected / stale / applied / partially_applied / failed` and exact resulting commit/overlay identity as appropriate. None of those status names imply remote publication.
- Cancel/terminate Worker releases derived resources but leaves pending proposals and author data. Host is authoritative over approval, history, checkpoint, publish and rollback.

## MCP mapping

Current `/mcp` has eight constant built-in tools; do not reintroduce Client Token, Owner Key or per-client capability grants. A client calls `repositories_list` then uses `repository_id`/optional branch. To call an official authoring plugin, `plugin_call` resolves typed (`pluginId`, `operation`, `input`) through the installed and enabled action registry **in the active Browser Host**. The same typed result/proposal and the same actual repository scope are returned through UI and MCP; no separate Node Scriptorium `/mcp` runtime or duplicated action logic. If only the active repo supports a plugin renderer, report `repository_not_active` explicitly, never route to an arbitrary repo.

Externally authenticated MCP clients can *propose*, not approve. Browser Host authors see complete proposal contents in their current UI. Explicit approval is not equivalent to commit or GitHub publish.

## Required error taxonomy and security

`invalid_input`, `unsupported_schema`, `repository_unavailable`, `scene_not_found`, `missing_capability`, `plugin_unavailable`, `snapshot_stale`, `conflict`, `unapproved`, `capacity`, `cancelled`, `timeout`, `storage_unknown` and `publication_unknown` are distinct machine-readable results. The UI gives a retry or recovery path and preserves source text. Never return a fake successful empty result.

Each guest runs under verified publisher signature/digest and explicitly approved capability intersection. No guest-provided JavaScript/CSS/HTML in the Host origin, broad network, Git credentials, arbitrary filesystem or unscoped storage. Context transmission to an external LLM is a separate consent/scope decision from reading local files or enabling a plugin.

## Host contract acceptance (before any plugin can be declared complete)

1. Signed official plugin installs, contributes **a functional outline/form/command**, operates on a synthetic Arcadia work via paged reads, and survives Host reload without a rebuild.
2. Same plugin's actions are callable via UI and `plugin_call` with the same schema and revision, against explicitly selected repo. Missing/disabled plugin produces typed unavailable.
3. Hundreds of synthetic scenes across more than 256 files can be listed and one scene edited without full-repo import or hidden byte-limit failure; partial/data fetching is bounded.
4. Bad path, stale snapshot, unknown publisher, unauthorized import, malformed descriptor and lost client/Worker cancel all fail closed without deleting Draft/Checkpoint.
5. A plugin proposal is reviewed (including reject/partial approve), applied only at current revision and **never auto-published**; the active editor remains mounted on Desktop and Mobile.
6. Disable/remove/rollback releases Workers, retains author data, leaves the plain Git file editor operable and maintains deterministic missing-panel fallback.
