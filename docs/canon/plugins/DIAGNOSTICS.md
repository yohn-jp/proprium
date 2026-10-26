# Canon P1 — `proprium.diagnostics` (Writing Diagnostics and Continuity)

**Product job:** Highlight relevant, traceable problems or patterns while an author writes, without treating probabilistic signals as ground truth or changing prose automatically.

## Feature and evidence classes

1. **Structural (deterministic error):** invalid hierarchy/metadata/schema, duplicate IDs, missing manuscript/target, broken links, forbidden path and declared revision conflicts.
2. **Declared-state conflict:** contradictory explicit event/state/world assumptions, chronology or thread events. Cite actual scene/YAML/event and known scene ordering. Unknown information is **not** a contradiction.
3. **Lexical/statistical signal:** sentence length and variation, repeated words/endings, adjectives/adverbs, dialogue-to-narration ratio, sentiment arc, rhythm, prose balance, stylometric/tone/plot divergence, synonym/habitual phrase suggestions and style fingerprints. Expose thresholds and provenance; warn, do not assert fact.
4. **Interpretive hypothesis:** first-read reaction, character voice drift, motivations, POV plausibility; visibly labeled as inference with uncertainty and evidence, not as verified errors.

Baseline structural/format metrics work without tokenization/model. With Research NLP, richer metrics become available; optional Knowledge supplies world-state and story assertions; Semantic can add ranked contradiction candidates; Speaker adds calibrated dialogue evidence. Never make optional providers preconditions for ordinary editor or baseline `diagnostics.scene.run`.

## Typed action contract

| Action | Effect / result |
| --- | --- |
| `diagnostics.scene.run` | read: pinned scene and text revision/hash -> classified findings, source paths, spans, corpus/config/engine identity, statistics |
| `diagnostics.project.check` | read: whole-work structural/continuity reports over paged snapshot, ranked/cancellable, with complete path and ID evidence |
| `diagnostics.lint.run` | read: formatting/lint warnings on selected text/file with rule IDs and precise UTF-16 ranges |
| `diagnostics.lint.propose` | propose: typed changes against exact manuscript base; detailed before/after diff and rule provenance, no direct `fix=true` |
| `diagnostics.voice.style` | read: known-character voice/style deviation and author-readable evidence; if Speaker plugin absent, limit to declared lexical rules |
| `diagnostics.feedback.propose` | propose: `corrected / false_positive / intentional / deferred` response, finding fingerprint and author annotation; no silent dismissal of changed finding |

Every finding MUST contain: severity and diagnostic class, rule/analyzer ID+version, source file/scene/corpus revisions, manuscript text hash, related config/lexicon revision, evidence quote/path/range where valid, confidence or deterministic indicator, and suggested next action. Interpretation hypotheses must not be sorted above verified blocking structural errors solely due to model score.

## UI

- Light, non-blocking in-editor indicators and a **診断 / 根拠** panel in Context/Inspect; clicking a finding jumps to the bounded range through Host navigation, respecting IME/selection.
- Filters distinguish errors, warnings, hypotheses and stale findings; cancellation and recomputation are explicit. Hide position-based stale decorations when the text changed; retaining old findings as current is forbidden.
- Fix button opens Host full diff and approval; no direct auto-format rewriting or unbounded first-open document scan.
- On Mobile, findings surface in a sheet with precise back-to-scene return, not a modal permanently covering the manuscript.

## Source recovery and source-of-truth data

**Scriptorium:** `modules/diagnostics/src/{analysis,fullDiagnostics,projectDiagnostics,textAnalysis,voiceStyle,sentenceEnding,sentimentArc}.ts`, `linter/{manuscriptFormat,rulesEvaluator,textTransformer}.ts`, `stylometry/*`, `plot/*`, `tone/*`, `proseBalance/*`, `mining/*`, `browser.ts`, `modules/nlp/src/tokenizer/*`. Existing author-owned lint/config/synonym/dismissal data under `meta/scriptorium/modules/diagnostics/`, `meta/scriptorium/modules/nlp/` and legacy `.arcadia/` must survive import.

**Arcadia Loom backfill:** `app/src/features/editor/{DiagnosticPanel,ContradictionDiagnosticsPanel,ManuscriptAnalysisPanel,SentimentArcChart,RhythmIndicator,VoiceCheckPanel,FirstReadReactionPanel,WriterMargin}.tsx` and `packages/core/src/diagnostics/*`. Recover any missing review/diagnostic presentation and rule families after source diff; retain original diagnostic classification/provenance in `docs/design/mcp-first-paired-writing-target-architecture.md`. Do not copy old embedded provider dependencies as hard prerequisites.

## Cache and limits

A diagnostic cache is keyed by `repository_id / branch / work / scene / manuscript text hash / corpus generation / config+lexicon revisions / analyzer version / optional model digest`, not only by scene/text. A new character note, thread event, speaker override or lexicon change invalidates exactly affected results even if manuscript bytes are unchanged. Derived caches cannot be authoritative correction history. Use bounded, cancellable Worker tasks and foreground-first scheduling; failed heavy engine must not interrupt writing. Do not transmit manuscripts by default.

## Acceptance

1. Structure lint detects duplicate IDs, missing manuscript and broken relation; evidence points to real revision. A valid manuscript produces no false structural error.
2. Japanese prose yields measurable rhythm/sentence/prose-balance data; findings link to exact source spans without changing text. Editing the text invalidates obsolete positional diagnostics.
3. Same scene with altered character/corpus/config **must not** reuse prior heavy findings. Another repo/branch never inherits them.
4. Author dismisses as false-positive versus intentional with distinct persisted decisions. Auto-format produces a **proposal** only; reject/stale leaves worktree unchanged.
5. No NLP/semantic/provider, disabled plugin or worker trap does not break editing, scene change, checkpoint or publish. Actual desktop/mobile review and proposed fix flow required.
