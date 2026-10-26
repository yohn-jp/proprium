# Canon P2 — `proprium.publishing` (Exports, Episode Mapping and Sharing)

**Product job:** Turn a reviewed work into correctly scoped reader-facing deliverables without changing manuscript authority or silently publishing drafts.

## Product scope

- Text export, EPUB, Japanese vertical print/PDF path, scope selection (work/volume/chapter/scene), metadata/cover inspection, publish-episode map, per-episode ordering and **optional** read-only share links.
- Export reads a selected **pinned snapshot** and warns if worktree/known remote state differs. The author chooses whether to export selected local revision versus confirmed remote one; never label unpublished local drafts as published GitHub content.
- Use scene YAML's `manuscript` links and canonical ordering from Narrative, stripping/translating markup only per explicit export settings. Preserve original Markdown/YAML; exported bytes are downloadable artifacts, not a commit.
- Any episode map or share grant descriptor maintained in Git is author metadata under existing `meta/scriptorium/modules/publishing/` or an approved new namespace; updates require Host proposal, revision check, approval and explicit publish. A share's bearer/token must never enter Git or an R2 public registry.

## Typed action contract

| Action | Effect / user result |
| --- | --- |
| `publishing.project.tree` | read: validated volumes/chapters/scenes and manuscript paths tied to source snapshot |
| `publishing.export.plaintext` | read/compute: scope, markup policy, encoding -> bounded .txt bytes with project title/ordering |
| `publishing.export.epub` | read/compute: scope, title, metadata and approved cover source -> validated .epub file |
| `publishing.export.vertical-print` | read/compute: selected scope, typography/pagination -> browser-controlled print/PDF flow and preview |
| `publishing.episodes.list/propose` | read/propose: source scene mapping, external episode order, expected metadata revision -> author-reviewed changed mapping |
| `publishing.shares.list/propose/revoke` | service-conditional read/propose: resource scope, expiry, revocation, owner consent; unavailable without explicitly configured publisher |

Sharing and remote posting are **not** ordinary `plugin_call` compute permissions: they require a separate consented network capability/independently deployed publisher service or Host privileged operation. Proprium's optional Go Gateway is only OAuth/Git relay and Live MCP; it is **not** silently promoted to a share-token store or content-publishing backend.

## UX

- Settings/Export contribution with human-readable scope selection, source revision/draft warning, output name/type, preview/preflight and explicit download/print. Success requires a real generated artifact.
- Vertical writing respects Aozora ruby, Japanese line breaking where supported, author typography; don't claim physical print-layout perfection from screenshot only. EPUB must pass structural validation/opening and include correct Unicode/metadata/images.
- Episode mapping shows scene association, ordering, already-published entry and pending Git metadata diff. Rejection leaves map and manuscript unchanged.
- Share links show read-only scope, expiry/revocation and external disclosure before creation; in local-only mode show unavailable, not an invalid URL or an implicit public origin.
- Exports work from local validated content with no model, GPU, HTTP server or external LLM. Very large works use paged reads and streamed/stream-like generation with bounds/cancellation; no full source copy stored in public R2.

## Source priority

**Scriptorium:** `modules/publishing/src/{project,plaintext,epub,verticalPrint,episodes,grants,actions,browser,http}.ts(x)`, `modules/publishing/tests/browser-clear.acceptance.mjs`, `docs/authoring.md`, `docs/architecture/MODULES.md`. Existing export UI and format implementations define baseline parity.

**Arcadia Loom:** `app/src/features/settings/{ExportEpubPanel,ExportPlaintextPanel,ExportVerticalPrintPanel,ExportPreflightDialog,ExportScopeSelector,PublishEpisodeMapPanel,ShareLinksPanel}.tsx`, `app/src/features/share/ShareReaderPage.tsx`, `PRODUCT.md`. Recover user-visible preflight and reader handling when not preserved by Scriptorium. Legacy hosted share/API flows are source evidence, **not** proof that a local-first static Host can serve anonymous shares without a service.

## Dependencies and data safety

Narrative hierarchy is required; Knowledge optional for Bible/relationship appendix or display labels. Export worker is activated per request, cancels safely and avoids holding entire manuscript memory for the life of Host. Generated export bytes remain the user's download, not plugin derived cache containing private works indefinitely. A missing cover or empty scope returns explainable error/preflight option. A plugin's failure may not modify files, source Git metadata, draft or confirmed remote refs.

## Acceptance

1. Work/volume/chapter/scene export scope produces correctly ordered UTF-8 plaintext and EPUB bytes, with stable titles, ruby and no unrelated/private-file leakage.
2. EPUB opens and validates; vertical preview/print uses actual Japanese sample, mixed-width/ruby, and does not silently mutate source Markdown. Large synthetic work avoids eager 256-file snapshot restriction.
3. Episode-map change runs proposed diff -> author approve -> reload and survives with original scene IDs; stale metadata rejects, no auto-publish.
4. Share link feature is truthful: if a service is absent, unavailable with explanation; if enabled, requires identity/scope/expiry/revocation and security/isolated reader tests. No anonymous share service is invented inside Gateway.
5. All baseline exports work offline with a cached work and no provider/Semantic/NLP, in Desktop and Mobile. Reinstalling/disabling plugin never deletes author metadata or existing manuscript.
