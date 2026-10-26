# Canon P2 — `proprium.speaker` (Speaker Attribution, Dialogue and Voice)

**Product job:** Help an author know who is speaking, resolve uncertain dialogue attribution safely, preserve human corrections and evaluate voice consistency across a long work. This is one plugin due to its shared correction/model/evaluation lifecycle, not four independent toy tools.

## Domain and authority

- Inputs: pinned scene text/paragraphs, declared characters/POV, appearance/mention relations, dialogue detection, local morphology when enabled and previously author-confirmed speaker correction records.
- An attribution is keyed by `repository_id+branch+sceneId+manuscript revision/text hash+sentence index/dialogue hash` and returns `speakerEntityId?`, `speakerGroupId?`, `reason`, `confidence: none|low|high` and explicit source spans. A cluster label is **not** an authoritative character until reviewed.
- Human-approved confirmations/overrides and rejected bad corrections are **authoritative metadata**; statistical profiles, temporary clusters, embeddings and job caches are derived. Preserve legacy `meta/scriptorium/modules/speaker/corrections.jsonl` and adopted model settings (where present) without deleting source bytes.
- `high` can only be assigned for calibrated high-precision evidence consistent with the existing Speaker rules. Scriptorium's source `speakerAttribution.ts` limits automatic high-confidence to the configured high-precision set (currently preceding narration); weak proximity/guesswork cannot silently count as `high`. The plugin must disclose its algorithm/rule version and fallback status.

## Typed actions

| Action | Effect / response |
| --- | --- |
| `speaker.scene.attribute` | read: scene+text revision -> dialogue spans, clusters, character candidates, reasons and confidence, with provenance |
| `speaker.review.queue` | read: low/none confidence lines and candidate evidence across scoped scenes, paged; no automatic author assumption |
| `speaker.correction.propose` | propose: confirm/change speaker, group labeling or overrides, exact source hash and related correction revision; propagated group changes previewed before approval |
| `speaker.voice.profile` | read: per-character dialogue corpus profile and drift/consistency evidence, with snapshot/model/corpus revision |
| `speaker.dialogue.excerpts` | read: cited dialogue list for a character over selected scenes with text path/offset; used by Knowledge and Paired Writing |
| `speaker.evaluation.run/report` | bounded opt-in compute: fixture-grounded precision/recall, class confusions, rule gates, corpus/model identity and calibration progress |
| `speaker.model.settings.propose` | propose: adopted/local model or rule-gate settings; no hidden retraining/auto-activation |

If no model is available, deterministic rules and author manual correction still work. Heavy rerank/retrain steps load only by explicit request and may fail independently of Writer/Knowledge; no claim of GPU or local model readiness without actual device evidence.

## UI

- Scene editor displays speaker badges and a **Review Queue** with candidate evidence; low/none confidence never masquerades as confirmed. Click a line to jump to its manuscript text with editor focus/selection preserved.
- Selecting a character exposes their dialogue excerpts and profile from Knowledge, a voice dashboard and voice-separation matrix; metrics are labeled as statistical observations, not identity proof.
- Group correction shows exactly which lines will change. Author can confirm/reject/skip; reviewing a group is not a Git mutation until the Host accepts a proposed correction. Revision drift triggers re-evaluation without losing the author's input.
- Mobile has a compact scrollable queue with explicit choices and return to the same sentence; no dragging-only controls or forced keyboard focus.
- Evaluation UI reports model version, corpus, rule thresholds, false positives and errors; it must not silently learn from unapproved corrections or upload dialogue data.

## Scriptorium source / Arcadia backfill

**Scriptorium:** `modules/speaker/src/{index,browser,engine}.ts`, `algorithms/{speakerAttribution,speakerClustering,speakerCorrectionLog,speakerOverrides,speakerEval,speakerReranker,speakerRuleStats,speakerSoftLabels,styleFingerprint}.ts`, `algorithms/speaker/*`, `algorithms/voice/*`, `migration.ts`, plus `modules/diagnostics/src/declaredVoice.ts`. The Scriptorium package already implements correction and evaluation contracts, but its Node jobs/model workers are **not** in-browser components.

**Arcadia Loom:** `app/src/features/speakers/{SpeakerEvalView,SpeakerEvalGates,SpeakerEvalReport}.tsx`, `app/src/features/editor/{SpeakerAttributionModal,SpeakerConfirmationQueue,SpeakerPickerPopover,SpeakerCountConfirmPanel,VoiceCheckPanel}.tsx`, `app/src/features/zukan/{CharacterDialogueList,CharacterVoiceDashboard,VoiceSeparationMatrix}.tsx`, `packages/core/src/speaker*`. Preserve source UX not represented by Scriptorium's browser contribution, especially confidence explanation, correction propagation and eval reporting.

## Dependencies and failure

Hard: Narrative scene/manuscript IDs and Knowledge character identities. Research tokenizer and Diagnostics style are optional providers; deterministic fallback and manual review stay usable without them. Plugin private derived cache scoped to corpus/config/textHash/rule version/author corrections revision. All changes proposed through Host; no direct Git mutation, remote publication, model/credential egress or background loop.

## Acceptance

1. Synthetic dialogue with known characters returns line+group IDs, reason and confidence; unknown speaker remains unknown, and wrong high-confidence claims are rejected by policy.
2. Low-confidence queue supports manual confirm, group propagation preview, reject and reload with original corrections retained. Old/stale manuscript or changed character set triggers re-evaluation rather than a silent overwrite.
3. Voice profiles, character dialogue links and evaluation report work without external LLM. Optional model failure preserves manual speaker editing and draft state.
4. Cross-work/cross-branch caches and accepted corrections never leak. Disabled/uninstalled plugin leaves YAML/Markdown and author corrections untouched; actual Desktop and Mobile workflow is demonstrated.
