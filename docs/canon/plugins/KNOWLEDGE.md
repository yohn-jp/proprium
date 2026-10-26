# Canon P1 — `proprium.knowledge` (Story Knowledge, Bible and Continuity)

**Product job:** Let an author reason about the entire work's people, places, items, world rules, narrative promises and what a reader knows at any scene. This is one cohesive **narrative knowledge product**; graph/map/timeline are projections, not competing data authorities or mandatory separate plugin installs.

## Scope and canonical data

- Canonical work Bible: `bible/characters`, `locations`, `items`, `factions`, `lore`, `timeline/events`, `dialogue_sketches`, plus `plot/threads` and `plot/arcs`. Preserve references from volume/chapter/scene YAML, and per-series/work overlays where present.
- Entity IDs/types and `aliases`, tags, notes blocks, relations and scene links remain stable. A character referenced as `pov`, `appears` or `mentions` cannot silently become a new character because of a renamed display title.
- Thread lifecycle states (`planted` / `advanced` / `resolved` / unset) and unresolved/repeated/late mention warnings are **derived from evidence**, not authority over story files. The graph is built from Git-backed entities and declared links; derived positions, clusters and embeddings are disposable.
- World state requires scene-ordered events, provenance, subject/object, item possession, location, character knowledge, reader disclosure and explicit/unknown/unresolved states. Missing evidence and interpretive conflict are not treated as fact.
- Zukan suggestions and notes edits are author proposals, with source quotes, block targets, status history and fresh revision checks. Existing human-approved corrections remain authoritative on import; no old SQLite row is silently inserted as trusted canonical state.

## Typed actions (read/propose only)

| Canonical action | Input / output |
| --- | --- |
| `knowledge.entities.list/get` | work + type/filter/scene/snapshot -> typed entities with stable ID, revisions, aliases and source path |
| `knowledge.entities.propose` | create/update/notes-block reorder/relationship link, expected revisions, evidence -> ChangeSet with field-diff |
| `knowledge.series.overlay` | work/series IDs + pinned work/bible snapshots -> precedence, provenance and conflict marks, never overwrite work-specific settings |
| `knowledge.scene.context` | scene ID -> appears/mentions/POV, plot goal, related entities/items/threads and cited facts |
| `knowledge.threads.lifecycle` | scope + scene range -> planted/advanced/resolved evidence, unresolved promises, forget-risk warning and source links |
| `knowledge.world.timeline` | work + current scene/revision -> scene-ordered state/events, character location/possession/knowledge, reader knowledge/gaps |
| `knowledge.lens.project` | graph/map/timeline projection + scene cursor + filters -> nodes/edges/states/source identity, same graph dataset |
| `knowledge.suggestions.list/propose` | candidate references and note changes -> evidence-rich review objects, author approval required |

Each result includes a pinned snapshot, data/source provenance and stable IDs. Unresolved references appear as **broken link diagnostics**, not silently filtered. Edit proposals declare all touched YAML revisions; series overlay mismatches are explicit errors.

## Author UX and components

- One Story Knowledge entry with subviews **図鑑 / 人物 / 伏線 / 関係 / 地図 / 年表 / 世界状態**, accessible from outline, current scene and Context/Inspect; do not add eight equal-priority top-level tabs.
- Character detail includes aliases, notes, related scenes, dialogue excerpts (from Speaker plugin if enabled), relationships and author-governed suggested changes. Bible item/place cards link back to canonical source.
- Threads show planted/advanced/resolved events, missing payoff, distance and reader visibility with **jump to scene**. The scene changes only through Host guarded navigation.
- Graph/map/timeline operate on one snapshot; a scene cursor must not show impossible knowledge ahead of its timestamp. If an advanced visual renderer is missing, retain an accessible tree/table/text presentation rather than silently dropping a feature.
- On Mobile, use searchable entity list and contextual sheets with Return to manuscript; no wholesale UI remount. Long data is paged, focus/caret stay in the editor.
- All generated suggestions are clearly tentative; deterministic facts and statistical/interpretive hypotheses have distinct labels.

## Primary source / Loom recovery

**Scriptorium:** `modules/story/src/actions.ts`, `browser.tsx`, `snapshot.ts`, `domain/{graph,locationMap,timeline,threadLifecycle,readerKnowledge,worldState,seriesOverlay,mentionIndex,cooccurrence}.ts`, `notes.ts`, `narrativeChangeSet.ts`, `migration/producer.ts`. Source includes structured notes, Zukan suggestions and continuity concepts. Adapt the pure domain code to browser/WASM; do not mount the Scriptorium server ModuleRuntime.

**Arcadia Loom:** `app/src/features/zukan/{BibleView,CharactersView,CharacterDetailModal,CharactersView,ThreadsView,GraphView}.tsx`, `app/src/features/zukan/bible/*`, `app/src/features/continuity/{MapView,TimelineView}.tsx`, `app/src/features/editor/{WorldStatePanel,SceneCharacterList,AppearsPickerModal}.tsx`, `packages/core/src/worldState/*`. Compare for detailed interactions and missing editorial operations; **Story Lens scene-slider** in `docs/plans/2026-07-29-narrative-ide-ux-plan.md` is a target, not proof that the unified slider was already shipped. Build it only after independent graph/map/timeline parity is verified.

## Dependencies, privileges, invalidation

Hard: `proprium.narrative` stable scene tree and Host structured list/detail/proposal UI. Optional: Research term resolver, Diagnostics warnings, Speaker voice excerpts, Semantic similarity. Knowledge must work from YAML and declared relations with zero model downloads. Derived caches keyed by repo+branch+work/series identity+snapshot+metadata generation+domain version; any entity/scene/series update invalidates affected projections.

No private manuscript in R2. No self-approval, background text rewrite, cross-work relation link without declared scope, or destructive cache-as-authority.

## Acceptance

1. Fixture with characters/aliases, places, items, factions, lore, arcs and threads renders browse/edit/scene linkage including unknown YAML fields.
2. Thread lifecycle warns for unresolved/payoff and supports jumping to the cited scene. Graph/map/timeline show internally consistent state at two different scene positions, without time-travel facts.
3. Typed series overlay precedence, missing/duplicate IDs, broken relations and reader-vs-character knowledge conflict are surfaced with evidence.
4. A notes block edit and a Zukan suggestion survive propose -> selective author approval -> reload, while reject/stale leaves Git unchanged. Source provenance retained.
5. Knowledge can be disabled/removed without breaking Narrative or deleting its YAML data. Cross-repository results and cached state never mix. Desktop/Mobile use actual Host widgets, not labels/JSON.
