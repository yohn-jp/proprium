# Recovery Inventory — Source to Author-facing Capability

**Status: normative scope ledger, not a feature-completion report.** Every row represents an author operation or retained author data, not the existence of a source file. An inherited implementation and successful generic Plugin/Gateway CI **do not** count as a ported plugin. Source versions are pinned in [the index](README.md). The owner does not authorize removal of capabilities when moving from Scriptorium or Arcadia Loom.

## Source triage and classification

- **Scriptorium primary:** Source and behavioral specifications in `yohn-jp/scriptorium` for nine old trusted modules; inspect the actual action implementation, browser contribution and tests, not just `modules/<name>/src/index.ts`.
- **Loom backfill:** `yohn-jp/arcadia-loom` original `PRODUCT.md`, `docs/design/mcp-first-paired-writing-target-architecture.md`, original source and E2E; compare any lost, regressed or incompletely migrated behavior.
- **Proprium current:** Actual Browser Git/Host, CodeMirror/SceneEditor and versioned WIT plugin runtime; no Story plugin is currently published or activated by the Host. `modules/*` are inherited source, not active runtime.
- Mark each feature `PARITY_SOURCE` (Scriptorium implements and retains intent), `REDUCED`, `LOOM_ONLY`, or `DESIGN_TARGET`, with the exact source/test anchors. Then track `NOT_CHECKED / FAIL / BLOCKED / PASS` **separately** against real Proprium integration.
- **Planned-only is not an inherited implementation**: Loom's unified Story Lens scene slider, Context Dock completeness and autonomous Task Runner were design goals, not all shipped features. They remain explicit targets without fabricated parity evidence.

## Scriptorium modules to product plugins

| Scriptorium source | Proprium product | Reason |
| --- | --- | --- |
| `modules/story` | `proprium.narrative` + `proprium.knowledge` | split authoring structure vs narrative knowledge/continuity; share one stable scene identity |
| `modules/search` + lightweight `modules/nlp` | `proprium.research` | lexical search, terms, navigation and optional tokenizer are one writer job |
| `modules/diagnostics` | `proprium.diagnostics` | evidence/classification/cache/feedback have independent lifecycle |
| `modules/semantic` | `proprium.semantic` | optional heavy model/index must not gate lexical search |
| `modules/speaker` | `proprium.speaker` | corrections, clusters, voice evaluation share one trust model |
| `modules/assistant` + ChangeSet semantics from `story` | `proprium.paired-writing` | external LLM/host handles generation; context/proposals/approval live locally |
| `modules/publishing` | `proprium.publishing` | EPUB/text/print and publication metadata |
| `modules/mcp` | **Host + optional Gateway**, `paired-writing` action adapter | no second MCP server/issuer or shadow Git writer |

## P0: continue writing

| Author job | Scriptorium source | Loom parity/backfill | Owner |
| --- | --- | --- | --- |
| Detect a novel without making every repository a novel | `modules/story/src/snapshot.ts`, `docs/authoring.md` | `PRODUCT.md`, format metadata | Narrative |
| Choose work / volume / chapter / scene in correct order | `app/src/application/LibraryOutline.tsx`, `modules/story/src/browser.tsx` | `features/editor/LeftNav.tsx`, `EditorSidebar.tsx` | Narrative |
| Open explicit YAML `manuscript` pointer, edit, preserve metadata | `modules/publishing/src/project.ts`, `app/src/editor/SceneEditor.tsx` | `features/editor/ManuscriptEditor.tsx` | Narrative + Host editor |
| Continue the last recoverable scene / reading position | `LibraryOutline.tsx`, `app/src/resume/*`, `SharedApplication.tsx` | `features/home/MobileHomeView.tsx` | Narrative + Host journal |
| Create/insert/move/reorder scenes without stale full-list overwrite | `modules/story/src/{actions,narrativeChangeSet}.ts` | `features/editor/EditorSidebar.tsx` | Narrative + Host proposal |
| Japanese IME, Ruby, vertical reading, typography and recovery | `app/src/editor/*`, `app/src/storage/journal.ts` | `features/editor/{ReadingView,VerticalPreview,SceneScratchPanel}.tsx` | Host retained, Narrative wiring |
| Quick capture, reading mark, mobile scene resume | `SceneEditor.tsx`, `docs/architecture/MOBILE-INTERACTION-UX.md` | `features/home/ScratchCaptureSheet.tsx`, `features/editor/{QuickWritePanel,ReadingMarkModal}.tsx` | Narrative + Host |
| Writing/Research/Review presets, moveable panels, focus safety | `docs/architecture/MODULAR-WORKSPACE.md`, current shells | Loom `docs/plans/2026-07-29-narrative-ide-ux-plan.md` | Host contributions |

## P1: knowledge, references, evidence and reviews

| Author job | Scriptorium source | Loom parity/backfill | Owner |
| --- | --- | --- | --- |
| Bible: character/location/item/faction/lore/arc/dialogue sketch | `modules/story/src/{snapshot,browser,actions}.ts(x)` | `features/zukan/{BibleView,CharactersView}.tsx`, `features/zukan/bible/*` | Knowledge |
| Structured notes/aliases and Zukan suggestion review | `modules/story/src/{notes,browser,narrativeChangeSet}.ts(x)` | `features/zukan/bible/{CandidatePanel,BibleDetailPane}.tsx` | Knowledge |
| Character relationships and scene appearance | `modules/story/src/domain/{graph,cooccurrence,mentionIndex}.ts` | `features/zukan/{GraphView,CharacterDetailModal}.tsx` | Knowledge |
| Map, timeline, world state, reader vs character knowledge | `modules/story/src/domain/{locationMap,timeline,worldState,readerKnowledge}.ts` | `features/continuity/{MapView,TimelineView}.tsx`, `features/editor/WorldStatePanel.tsx` | Knowledge |
| Foreshadow planted/advanced/resolved, missing payoffs | `modules/story/src/domain/{threadLifecycle,threadStatus}.ts` | `features/zukan/ThreadsView.tsx` | Knowledge |
| Series overlays and conflicting canon | `modules/story/src/domain/seriesOverlay.ts` | `PRODUCT.md` / original series/work data | Knowledge |
| Lexical / prefix / exact search, citations, scope, jump | `modules/search/src/{actions,search-ranking,browser}.ts` | original search/reference UI | Research |
| Terminology, aliases, ambiguity, non-destructive text links | `modules/search/src/terminology.ts` | `features/zukan/SynonymGroupRegister.tsx` | Research |
| Japanese tokenizer, term candidates, sentence spans | `modules/nlp/src/{candidateDiscovery,sentenceSplit,tokenizer,termVariants}.ts` | original word/expression inventory UX | Research provider |
| Lint, formatting, project structural consistency | `modules/diagnostics/src/{linter,projectDiagnostics}.ts` | `features/editor/DiagnosticPanel.tsx` | Diagnostics |
| Sentiment/rhythm/prose balance/stylometry/voice-style | `modules/diagnostics/src/{sentimentArc,proseBalance,stylometry,voiceStyle}.ts` | `features/editor/{ManuscriptAnalysisPanel,RhythmIndicator,SentimentArcChart,VoiceCheckPanel}.tsx` | Diagnostics |
| Declared-state conflict and contradiction with sources | `modules/diagnostics/src/fullDiagnostics.ts`, `modules/semantic/src/contradictions.ts` | `features/editor/ContradictionDiagnosticsPanel.tsx` | Diagnostics + Knowledge |
| Revision-scoped Context/Context Manifest | `modules/mcp/src/{context-manifest,tools}.ts` | `docs/design/mcp-first-paired-writing-target-architecture.md` | Paired Writing |
| Author-selective ChangeSet approval, same scene return | `modules/story/src/narrativeChangeSet.ts`, `packages/core`, `app/src/contributions/*` | `packages/core/src/narrativeChangeSetApply.ts`, `features/review/ReviewView.tsx` | Paired Writing + Host |
| Setting QA, dialogue sketches, continuation, aspect review, first read | `modules/assistant/src/{actions,qa-tools,dialogue-context,continuation-context,aspect-review,rewrite-local}.ts` | `features/ai/DialogueSketchView.tsx` and `features/editor/FirstReadReactionPanel.tsx` | Paired Writing |
| Context Dock selection-following and complete workflow | Scriptorium composable panels, targeted UX contract | Loom MCP-first target doc; **not certified shipped** | Paired Writing + Host **design target** |

## P2: detailed author tools and output

| Author job | Scriptorium source | Loom parity/backfill | Owner |
| --- | --- | --- | --- |
| Speaker attribution, clusters, user overrides | `modules/speaker/src/{index,algorithms/speakerAttribution,algorithms/speakerOverrides}.ts` | `features/editor/{SpeakerAttributionModal,SpeakerConfirmationQueue,SpeakerPickerPopover}.tsx` | Speaker |
| Group corrections, per-character dialogue, voice matrix | `modules/speaker/src/algorithms/*` | `features/zukan/{CharacterDialogueList,CharacterVoiceDashboard,VoiceSeparationMatrix}.tsx` | Speaker |
| Speaker model eval, rule gates, precision/recall | `modules/speaker/src/algorithms/{speakerEval,speakerRuleStats}.ts` | `features/speakers/{SpeakerEvalView,SpeakerEvalGates}.tsx` | Speaker |
| Embeddings, optional semantic/rerank/hybrid search | `modules/semantic/src/{embedding,search,passages}.ts` | original semantics/search surfaces | Semantic |
| Expression inventory, similar terms and contradiction candidates | `modules/semantic/src/{termClustering,contradictions}.ts` | `features/zukan/SynonymGroupRegister.tsx` | Semantic + Diagnostics |
| Plaintext, EPUB, vertical print by scope | `modules/publishing/src/{plaintext,epub,verticalPrint,browser}.ts(x)` | `features/settings/{ExportPlaintextPanel,ExportEpubPanel,ExportVerticalPrintPanel}.tsx` | Publishing |
| Episode maps, preflight, sharing metadata and reader | `modules/publishing/src/{episodes,grants,http}.ts` | `features/settings/{PublishEpisodeMapPanel,ShareLinksPanel,ExportPreflightDialog}.tsx`, `features/share/ShareReaderPage.tsx` | Publishing; external sharing service separately required |
| Full Story Lens projection with scene slider | Existing graph/map/timeline domain functions | Loom roadmap (`#463`); **planned only** | Knowledge **target enhancement** |

## Authoritative data migration (no deletions)

| Class | Existing location / origin | Treatment |
| --- | --- | --- |
| Manuscript and plot/bible metadata | `manuscript/`, `plot/`, `bible/` | Preserve canonical IDs, byte content, YAML unknown fields, manuscript links and Git history |
| Speaker correction / model | `meta/speaker-corrections.jsonl`, `meta/speaker-model.json`, `meta/scriptorium/modules/speaker/` | Import reviewed corrections; preserve model provenance without eager load |
| Dictionary/ignore list | `meta/synonyms.yaml`, `meta/candidate-ignore-list.yaml`, `meta/scriptorium/modules/{search,nlp}/` | Never discard human aliases/annotations; derived term index can rebuild |
| Contradiction dismissals and review decisions | `meta/contradiction-dismissals.jsonl`, module author metadata | Preserve semantic state and whether intentional/false-positive is known |
| Publication metadata and cover | `meta/publish-episodes.yaml`, `.arcadia/cover.jpg`, Scriptorium publishing metadata | Preserve bytes/order/association, never publish private cover automatically |
| Proposed/applied/partial ChangeSets and Zukan suggestions | `.arcadia/change-sets/*.json`, `meta/scriptorium/modules/story/state-proposals.jsonl`, legacy SQLite | Stable IDs and reviewed status; no replay of unknown completed operations |
| Scratch/undo/browser-local journal and unpushed Git commits | `.arcadia/snapshots/**` and BrowserJournal / Browser Git | Inspect before import, never clear or silently rebind; no promise of cross-origin recovery |
| Legacy SQLite index/state records | `.arcadia/index.sqlite`, workspace index; [Scriptorium migration contract](https://github.com/yohn-jp/scriptorium/blob/1a05a0f10b33acca3fcfc544a5a6a2592f1c3865/packages/migration/README.md) | Read-only inspect, preserve unknown nonsecret records, domain-owned explicit semantic reconciliation |
| Embeddings and indexes | Derived cache, old SQLite derived rows | Rebuild under new plugin version/model identity; not author authority |
| Credentials, weights, private manuscripts | Private user state / restricted licenses | Never copy into plugin source, CDN, R2, public tests or documentation |

### Evidence rules

Each implementation session reports: feature row; Scriptorium exact source/test; Loom comparison result (parity/reduced/missing/planned-only); target plugin/action/Host contract; source and resulting revisions; synthetic fixture; PASS/FAIL/BLOCKED/NOT_CHECKED; signed artifact hash; desktop/mobile checks. A missing row cannot be silently excluded from DONE. Old code, CI green without published artifact, a diagnostic JSON dump, or an empty panel are NOT evidence of functional restoration.
