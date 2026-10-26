# Canon P0 — `proprium.narrative` (Writing and Work Structure)

**Product job:** Open a Git repository containing the Arcadia/Scriptorium work format, recognize a work, and let its author **continue writing the correct scene safely**. This is the first non-negotiable recovered plugin. Without the plugin, Core remains a usable generic Git Markdown editor.

## Ownership and data contract

- Interpret `plot/volumes/<volume>/volume.yaml`, nested `chapters/<chapter>/chapter.yaml` and `scenes/<scene>.yaml`, plus each scene's explicit `manuscript: manuscript/.../*.md` reference. Published YAML/Markdown is the authority. Do not assume path equals ID or that scene order equals directory order.
- IDs for work/volume/chapter/scene are stable domain IDs scoped to `repository_id + branch`; localWorkspaceId, server Project UUID, file path and Git OID are distinct. If IDs collide across files, return a structural error with all paths, not a guessed favorite.
- Parse/read title, order, scene goal/conflict/POV, appears/mentions/threads and manuscript reference **without losing unknown fields, comments, metadata or Markdown frontmatter**. Missing paths, invalid YAML, ambiguous IDs and out-of-scope symlinks are visible errors; never auto-repair/rewrite a work on open.
- New author-created structure is committed only through Host ChangeSet review/apply; new files follow the format, and existing files retain their syntax/unknown keys. The plugin must not create another Git checkout, journal or server-side state. Plugin-local preferences (tree expansion, last-scene view) are disposable; authoritative ordering and scene records are Git files.
- Existing browser journal remains the only unsaved Draft recovery source. Draft, Local Checkpoint and GitHub-confirmed Published are distinct; do not rewrite recovery keys or overwrite a recovery draft with a late scene read.

## Typed action API (logical names; bind to versioned Host/WIT schemas)

| Action and effect | Input / output and observable behavior |
| --- | --- |
| `narrative.work.detect` — read | repo + pinned snapshot -> `recognized / unrecognized / malformed`, work title, supported format, conflicts/warnings. Never mutate |
| `narrative.hierarchy.tree` — read | repo + snapshot + optional work/scope/cursor -> ordered volumes, chapters, scenes; stable IDs, path and revision |
| `narrative.scene.open` — read + Host navigation | scene ID + expected revision -> scene metadata, actual manuscript path, body version and editability; navigate only via Host dirty guard |
| `narrative.scene.continue` — read + navigation | author/repo + last valid scene/reading location -> safe recoverable candidate + draft/publication status; use Host journal; unavailable is explicit |
| `narrative.structure.propose` — propose | typed create/update/reorder/move of volume/chapter/scene with stable neighbor/order/parent preconditions -> complete ChangeSet and preview; no direct writes |
| `narrative.scene.metadata.propose` — propose | scene ID + declared field patch + exact expected YAML revision -> reviewed update; preserve other keys |
| `narrative.manuscript.inspect` — read | scene ID/path and revision -> visible body metadata, summary counts/ruby/format references; manuscript bytes still obtained from Host-scoped file.read |

A `scene.create` operation coordinates scene YAML and Markdown creation (or an explicitly selected existing manuscript) as a guarded multi-file proposal. Reorder/move must preserve IDs, declared relations and manuscript path; deleting a scene is always explicitly destructive, not a side effect of moving its directory. Cross-volume manuscript relocation is never inferred.

## UI contract

- On opening a recognized work, **Work / Volume / Chapter / Scene** replaces the generic **Files** list in a selectable *authoring contribution*, not the generic Core tree's semantics. A button restores Files for developer work. For a non-work repository, do not show a fake empty novel.
- The prominent affordance is **続きを書く** from the most recent *recoverable* scene. Visible current location, scene title, previous/next scene navigation, writing progress and save scope remain stable.
- Center uses **Host's existing CodeMirror/SceneEditor**, Japanese IME, vertical preview/reading, ruby syntax, typography presets, 400-character-sheet count, scratch and safe draft recovery. The plugin does not inject code into editor or own its undo stack.
- Scene creation and ordering have both keyboard/button and pointer paths; hierarchy remains usable on a large work with hundreds of scenes, lazy/cursor paging where necessary.
- Desktop supports Outline + manuscript side-by-side; Mobile offers a scene/continue view and a transient structure sheet without unmounting the editor or relocating the caret. Switching a scene must flush/guard unsaved text before navigation.
- Empty work, invalid YAML, missing manuscript, multiple candidates, disabled plugin, offline, storage_unknown, journal conflict and remote revision unknown each have a truthful next action.

## Source of truth for port

**Scriptorium primary:** `app/src/application/LibraryOutline.tsx` (real TreeNav, continue writing, recovery), `app/src/application/SharedApplication.tsx` (selection, guard, author coordination), `modules/story/src/snapshot.ts` (entities/hierarchy/links), `modules/story/src/actions.ts` / `narrativeChangeSet.ts` (semantic operations), `app/src/editor/SceneEditor.tsx`, `docs/authoring.md`, `docs/design/UX-CONTRACT.md`. Existing source in Proprium may be copied, but does **not** mean it is reachable in the Host.

**Arcadia Loom backfill/verification:** `app/src/features/editor/EditorView.tsx`, `ManuscriptEditor.tsx`, `QuickWritePanel.tsx`, `readingSceneNav.ts`, `app/src/features/home/MobileHomeView.tsx` and `ScratchCaptureSheet.tsx`; `PRODUCT.md` and `docs/design/mcp-first-paired-writing-target-architecture.md`. Port features that Scriptorium omitted, not obsolete server/provider mechanisms. Reading mark and quick-capture behavior require a parity inventory rather than silent omission.

## Dependencies and failure

Host: versioned paged file list/read; YAML/Markdown view model; semantic proposal admission; Host panel/outline renderer and navigation context; existing journal, workspace scope and editor. No external LLM/NLP/semantic/plugin can gate `scene.open`. Scope each request to immutable repo/branch/snapshot and return cancellation/stale errors.

## Acceptance (P0 completion gate)

1. Synthetic **multi-volume, multi-chapter work** with multiple scenes is detected with exact IDs and `manuscript` links; generic repository still works unchanged.
2. Author opens a work, selects a scene, types Japanese IME, saves draft, switches structure panel and returns with caret/undo/scroll intact. Browser reload recovers only the correct author/repo/path draft.
3. `続きを書く` selects the last valid scene, handles deleted/stale last-scene record and never selects another repo's draft.
4. Create scene, insert/move/reorder and edit metadata through reviewed revision-preconditioned multi-file ChangeSets; stale/duplicate/missing references reject without destroying YAML unknown fields or a manuscript.
5. More than 256 files and hundreds of scenes work without eager full-snapshot limit; opening a scene does not wait for NLP, embedding, remote scan or disabled plugins.
6. Desktop Chromium/Mobile WebKit plus real input focus/IME checks; empty, recovery, offline and validation failures are exercised. Signed independently distributed `proprium.narrative` must install and show real UI. **Only then P0 is DONE.**
