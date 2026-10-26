# Canon P1 — `proprium.research` (Search, Terminology and Lightweight NLP)

**Product job:** Find relevant evidence in a long work without interrupting the manuscript, and navigate back to the exact scene/selection. Author's first query works offline with no model, GPU or externally configured provider.

## Owned features and source data

- One user-facing **検索・用語** product owns lexical full-text search, exact phrase and prefix, scoped files/entities/scene range, ranking, pagination, term canonical names and aliases, reader/editor decorations, compound noun candidates, Japanese tokenization when available, and author-reviewed term registration.
- Git-authoritative terminology is the existing `meta/scriptorium/modules/search/terms.json` (schema version 1), with canonical term ID, aliases and `targetPath`. Respect the original Scriptorium format without destructive migration. `meta/scriptorium/modules/nlp/synonyms.yaml`, candidate ignore-list and feature consent are separate author-controlled data and must not silently become derived cache.
- Search results are *derived*: file path, scene ID if resolved, UTF-16 visible span/quote, relevance explanation, indexed and requested snapshot, score/mode and stale flag. Source text always comes from a pinned Host snapshot, never an unverified stale index.
- Disambiguation is mandatory: identical aliases mapping to multiple terms are **ambiguous**, not silently linked to the first. Unicode normalization must preserve mapping back to original UTF-16 offsets, Ruby and Japanese IME.

## Typed action contract

| Action | Effect / response |
| --- | --- |
| `research.query` | read: `{query, mode: lexical/exact/prefix, scope, cursor, limit, snapshot}` -> hits with matched passages, ranks, exact paths/scenes, index snapshot; lazy rebuild if missing |
| `research.term.list/get` | read: normalized term registry, aliases, targets, revision and ambiguities |
| `research.term.resolve` | read: `{path, textRevision, visibleRange}` -> non-overlapping transient decorations and ambiguous alternatives; no Markdown mutation |
| `research.term.propose/remove` | propose: new/updated/canonical/alias/target term with expected registry revision; Host review and Git approval |
| `research.nlp.analyze` | read: bounded sentence/token spans, base/reading/POS, approximate or provider tokenizer identity, no implicit heavyweight download |
| `research.term.candidates` | read: suggested term/compound nouns and synonym variants with file/scene evidence, author accepts explicitly |
| `research.index.status/rebuild` | read/ephemeral: indexed identity, progress, pause/cancel and errors; never authoritative Git write |

The basic `research.query` capability does not require `proprium.semantic`. If Semantic is installed, a separately selected hybrid/semantic mode can reuse the same query view, with model provenance and explicit degradation; no second competing search UI.

## UI

- Search field in Research preset, results with work/volume/chapter/scene and snippet, keyboard results, scope chips, text jump with preserved origin selection, and explicit stale/rebuild signal.
- Term detail/edit uses Host forms; Ctrl/Cmd-click or accessible button jumps to the actual file. Automatic links are **decorations only** and never rewrite the source Markdown. Hover is not the only navigation path.
- Mobile search uses a sheet/screen that returns to the exact manuscript caret/scroll; no invisible index rebuild can steal typing focus. Loading and disabled states do not block writing.
- Author can disable search or NLP independently of the generic editor. Missing tokenizer reduces the quality of term candidates but not lexical search; no model prerequisites at startup.

## Recoverable source

**Scriptorium:** `modules/search/src/{actions,search-ranking,terminology,index-cache,browser}.ts`, `modules/nlp/src/{index,candidateDiscovery,termVariants,sentenceSplit}.ts`, `docs/architecture/MODULAR-WORKSPACE.md`. Reuse verified normalization, scope, term link and cache invalidation behavior. Search source already has lexical/index/terminology actions; NLP is a separate capability provider internally but not a required author-facing plugin product.

**Arcadia Loom fallback:** `app/src/features/zukan/SynonymGroupRegister.tsx`, `app/src/features/zukan/bible/CandidatePanel.tsx`, editor term adornment and search flows (locate original source before porting). Restore any user action missing from Scriptorium rather than copying provider/DB code.

## Dependencies, privacy and resource limits

Host paged file reads and navigation are hard dependencies. Narrative is required only for scene-aware labels and resume; generic files search remains useful if Narrative is disabled. Knowledge optional for entity target cards. Semantic is purely opt-in. Cache key binds repository ID, branch, remote+overlay snapshot, document-set definition, term registry revision, tokenizer/config version and query/filter. Cache invalidation follows file changed/deleted/created, branch change and plugin disable. Work in bounded Worker batches under cancellation/backpressure, foreground editor first.

No network egress, external embedding API or file mutation is implied by a search; derived cache corruption is rebuilt without altering Git.

## Acceptance

1. Search exact/lexical/prefix across 300+ synthetic scene files, paginate, find a quoted span, jump to it, then return to preserved Japanese editor selection without waiting for a model.
2. Term registry add/update/remove uses Host proposal and stale registry revision rejection. Multiple alias targets produce ambiguous results, never auto-link to a wrong entity.
3. UTF-16 offsets, kanji/ruby, mixed English, normalization and active IME compose correctly; editor decorations never become Markdown commits.
4. Branch/revision switch invalidates old index; old results are labeled stale or blocked, never displayed as current. Disabled plugin or failed NLP provider leaves writing operational.
5. Offline cached read/search functions when source snapshot is local; missing source or eviction reports unavailable truthfully. Desktop/Mobile render real interactive search and terms UI.
