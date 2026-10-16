# Core extraction and public source provenance

Source authority: `yohn-jp/arcadia-loom`, latest main inspected for this recovery at `edc033c2c9466274a334299dadfa426661d957d9`. Only the named source areas below were used. Arcadia Loom was not modified and is neither a dependency nor a submodule.

The repository owner explicitly authorized extracting these application responsibilities into the public MIT-licensed Scriptorium repository. The inspected source contains no standalone root license grant; this recovery relies on that owner authorization for the owner-authored application code. It does not grant rights to publish private works or unrelated third-party material. No source Git ancestry is part of Scriptorium's commit ancestry. No third-party UI assets, fonts, private work repositories, credentials, model weights, caches, or historical project data were imported.

| Canonical source | Scriptorium owner | Adaptation |
| --- | --- | --- |
| `packages/core/src/loader.ts`: `loadProject`, `parseMarkdownFile`, `saveManuscript`, `resolveManuscriptStubPath` | `packages/core/src/index.ts` | YAML hierarchy, scene-to-manuscript references, Markdown/frontmatter separation and canonical manuscript paths. Only writing data is loaded; graph and analysis entities are excluded. |
| `packages/core/src/authoringService.ts`: scene and manuscript creation/persistence path | `packages/core/src/index.ts` | Existing scene stub and manuscript conventions; unsupported metadata remains in work repositories. |
| `packages/workspace/src/atomicWrite.ts` | `packages/core/src/index.ts` | Temporary file and atomic rename persistence, with file flush before rename. |
| `packages/workspace/src/git/operations.ts`: clone, fetch, commit and fast-forward behavior | `packages/core/src/index.ts` | Dedicated project clones and explicit sync outcomes. Credentials use a temporary askpass helper and process environment, rather than token-bearing remote URLs. |
| `packages/api/src/mutationSafety.ts`: content revision and persistent mutation preconditions | Core save boundary and `packages/api/src/server.ts` | Optimistic revision identity is checked inside project writer coordination; stale writes produce explicit errors. Source mutation receipt infrastructure is not copied. |
| `packages/api/src/writerLock.ts`, `auth.ts`, `runtimeAuth.ts` | Core writer coordination and `packages/api/src/server.ts` | Filesystem/in-process coordination and a single-owner, server-only access token exchanged for an HttpOnly cookie. This runtime does not claim Arcadia's complete identity/hosting model. |
| `app/src/hooks/draftRecovery.ts`, `useDraftRecovery.ts`, `useSceneEditing.ts` | `app/src/drafts.ts`, `main.ts` | Project/scene-scoped recovery, original revision retention, explicit conflict resolution and protection during editing. Small browser-local records replace the source's IndexedDB/React dependency path. |
| `app/src/features/editor/VerticalPreview.tsx`, `editorTypography.ts` | `app/src/main.ts`, `app/styles.css` | Text-safe line rendering, read-only document semantics, Japanese typography and native CSS vertical writing. No font or external asset was imported. |

This is a selective adaptation of source behavior and file formats, not a wholesale copy of Arcadia's Core package. The target removes the source's derived SQLite/index, React, graph, NLP and inference closure from the baseline writing path. Core's only third-party production JavaScript dependency is declared in its package manifest; the production dependency audit and image verification record identify the installed closure. Dependency license files remain with their packages in the image.

Tests use synthetic disposable data. Live GitHub acceptance uses a temporary branch in the target repository and removes that branch after verification. No real writing is used as a test fixture.
