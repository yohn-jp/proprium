# P00 source inventory

This ledger freezes source registrations at `edc033c2c9466274a334299dadfa426661d957d9` against target base `016a69cb924cbe1f9aed9af18f2f31143dff9676`. It records 48 imported router registration owners, 166 concrete HTTP handler registrations, and 12 non-router capability/data groups. These are source facts; no entry claims migration or implementation.

## Router registrations

IDs R01–R48 are the fixed IDs in `FULL-MIGRATION-PLAN.md`. The machine-readable `ledger.json` records each imported registration symbol, its source file, exact HTTP method/path, source line and inline-handler locator. The system health probe helper is expanded into its three concrete GET paths. `R33` retains the source demo endpoint only as an explicitly excluded production demo per the plan.

| ID | Registration symbol | Source | Endpoints | Disposition |
| --- | --- | --- | --- | --- |
| R01 | `registerSystemRoutes` | `packages/api/src/routes/system.ts` | `GET /health/live`, `GET /health/ready`, `GET /health/startup`, `GET /api/health`, `GET /api/ready`, `POST /api/reload` | API/Core lifecycle and runtime metadata |
| R02 | `registerVersionRoute` | `packages/api/src/versionRoute.ts` | `GET /api/version` | API version/build/module metadata |
| R03 | `registerLlmHealthRoute` | `packages/api/src/routes/llmHealth.ts` | `GET /api/llm/health` | assistant; never Core readiness prerequisite |
| R04 | `registerLlmQueueStatusRoute` | `packages/api/src/routes/llmQueueStatus.ts` | `GET /api/llm/queue-status` | assistant jobs, backed by shared bounded execution |
| R05 | `registerTreeRoutes` | `packages/api/src/routes/tree.ts` | `GET /api/tree` | Core hierarchy |
| R06 | `registerEntityRoutes` | `packages/api/src/routes/entities.ts` | `GET /api/entities`, `GET /api/entities/:id`, `GET /api/entities/:id/voice-patterns`, `GET /api/entities/:id/backlinks`, `GET /api/entities/:id/appearances`, `GET /api/entities/:id/freshness`, `GET /api/entities/:id/suggested-tags`, `POST /api/entities`, `PUT /api/entities/:id`, `POST /api/reorder` | story domain + Core mutation boundary |
| R07 | `registerZukanSuggestionRoutes` | `packages/api/src/routes/zukanSuggestions.ts` | `GET /api/entities/:id/zukan-suggestions`, `POST /api/entities/:id/zukan-suggestions/run`, `POST /api/zukan-suggestions/:id/approve`, `POST /api/zukan-suggestions/:id/reject` | assistant proposal generation; story operations |
| R08 | `registerSceneRoutes` | `packages/api/src/routes/scenes.ts` | `GET /api/scenes/:id/context`, `POST /api/suggest-rewrite`, `POST /api/scenes/:id/attribute-speakers`, `POST /api/scenes/:id/llm-speaker-attribution/prompt`, `POST /api/scenes/:id/llm-speaker-attribution`, `POST /api/scenes/:id/voice-check`, `PUT /api/scenes/:id/speaker-override`, `POST /api/scenes/:id/style-deviations`, `POST /api/scenes/:id/plot-semantics`, `POST /api/scenes/:id/stylometric-deviations`, `POST /api/scenes/:id/lint`, `POST /api/scenes/:id/diagnostics` | Core scene/hierarchy operations; story metadata extension |
| R09 | `registerWorldStateRoutes` | `packages/api/src/routes/worldState.ts` | `GET /api/scenes/:id/world-state`, `GET /api/scenes/:id/state-workbench`, `GET /api/entities/:id/state-history` | story |
| R10 | `registerStateProposalRoutes` | `packages/api/src/routes/stateProposals.ts` | `GET /api/state-proposals`, `POST /api/state-proposals`, `PUT /api/state-proposals/:id`, `POST /api/state-proposals/:id/approve`, `POST /api/state-proposals/:id/reject`, `POST /api/state-proposals/stale` | story proposal operations; Core approval |
| R11 | `registerChangeSetRoutes` | `packages/api/src/routes/changeSets.ts` | `POST /api/change-sets`, `GET /api/change-sets`, `GET /api/change-sets/:id`, `POST /api/change-sets/:id/apply`, `POST /api/change-sets/:id/restore`, `POST /api/change-sets/:id/reject` | Core generic ChangeSet/approval/apply/history |
| R12 | `registerReaderModelRoutes` | `packages/api/src/routes/readerModel.ts` | `GET /api/chapters/:id/reader-model`, `GET /api/chapters/:id/reader-model/prompt-preview` | story reader/character knowledge; assistant only for generated reactions |
| R13 | `registerSearchRoutes` | `packages/api/src/routes/search.ts` | `GET /api/search`, `GET /api/search/semantic`, `GET /api/expressions/search` | Core bounded literal/basic search; semantic enhanced search |
| R14 | `registerSummaryRoutes` | `packages/api/src/routes/summaries.ts` | `GET /api/summaries/:scope`, `GET /api/summaries/:scope/prompt-preview`, `POST /api/summaries/refresh` | assistant generation and source freshness |
| R15 | `registerThreadRoutes` | `packages/api/src/routes/threads.ts` | `GET /api/threads/status`, `GET /api/threads` | story |
| R16 | `registerCharacterRoutes` | `packages/api/src/routes/characters.ts` | `GET /api/characters/:id/dialogue` | story roster; speaker dialogue/voice contributions |
| R17 | `registerTagRoutes` | `packages/api/src/routes/tags.ts` | `GET /api/tags` | story |
| R18 | `registerGraphRoutes` | `packages/api/src/routes/graph.ts` | `GET /api/graph` | story graph/relationship/map projections |
| R19 | `registerTimelineRoutes` | `packages/api/src/routes/timeline.ts` | `GET /api/timeline` | story chronology |
| R20 | `registerInspectionRoutes` | `packages/api/src/routes/inspection.ts` | `GET /api/validate`, `GET /api/continuity-check`, `GET /api/sentiment-continuity-hotspots`, `GET /api/cooccurrence`, `GET /api/voice-consistency`, `GET /api/style-deviations` | shared inspection host; domains supply typed evidence |
| R21 | `registerDiagnosticsRoutes` | `packages/api/src/routes/diagnostics.ts` | `GET /api/diagnostics/contradictions`, `POST /api/diagnostics/contradictions/dismiss` | diagnostics aggregator; optional module contributions |
| R22 | `registerManuscriptRoutes` | `packages/api/src/routes/manuscript.ts` | `PUT /api/manuscript/:id`, `GET /api/manuscript/:id/snapshots`, `POST /api/manuscript/:id/snapshots`, `GET /api/manuscript/:id/snapshots/:snapshotId` | Core documents/checkpoint/publish/history |
| R23 | `registerExportRoutes` | `packages/api/src/routes/export.ts` | `GET /api/export/plaintext`, `GET /api/export/epub` | publishing |
| R24 | `registerPublishEpisodeRoutes` | `packages/api/src/routes/publishEpisodes.ts` | `GET /api/publish-episodes`, `PUT /api/publish-episodes` | publishing |
| R25 | `registerCandidateRoutes` | `packages/api/src/routes/candidates.ts` | `GET /api/candidates`, `GET /api/candidates/clusters`, `POST /api/candidates/ignore` | diagnostics lexical candidates; semantic clustering extension |
| R26 | `registerAnalysisRoutes` | `packages/api/src/routes/analysis.ts` | `POST /api/analyze-manuscript`, `GET /api/style-fingerprints`, `GET /api/stylometric-profiles` | diagnostics and nlp capability |
| R27 | `registerLintRoutes` | `packages/api/src/routes/lint.ts` | `POST /api/lint` | diagnostics; fixes use approved Core operations |
| R28 | `registerSynonymRoutes` | `packages/api/src/routes/synonyms.ts` | `POST /api/synonyms/groups`, `POST /api/suggest-synonyms/prompt`, `POST /api/suggest-synonyms` | diagnostics dictionaries; assistant external suggestions |
| R29 | `registerWritingStatsRoutes` | `packages/api/src/routes/writingStats.ts` | `GET /api/writing-stats` | Core basic counts; diagnostics richer metrics |
| R30 | `registerLlmUsageRoutes` | `packages/api/src/routes/llmUsage.ts` | `GET /api/llm/usage` | assistant historical usage records, explicitly classified durability |
| R31 | `registerLlmModelSettingsRoutes` | `packages/api/src/routes/llmModelSettings.ts` | `GET /api/llm/model-settings`, `PATCH /api/llm/model-settings` | assistant preferences and secret references |
| R32 | `registerNlpFeaturesRoutes` | `packages/api/src/routes/nlpFeatures.ts` | `GET /api/nlp/features`, `PATCH /api/nlp/features` | module availability/locality projection; old external-send consent preserved |
| R33 | `registerLlmStreamDemoRoutes` | `packages/api/src/streaming/demoRoute.ts` | `POST /api/llm/stream-demo` | Explicitly excluded production demo; retain necessary transport tests, not a public demo endpoint |
| R34 | `registerQaRoutes` | `packages/api/src/routes/qa.ts` | `GET /api/qa/prompt-preview`, `POST /api/qa` | assistant setting QA and citations |
| R35 | `registerContinuationOptionsRoutes` | `packages/api/src/routes/continuationOptions.ts` | `POST /api/assist/continuation-options/prompt-preview`, `POST /api/assist/continuation-options` | assistant |
| R36 | `registerSpeakerRoutes` | `packages/api/src/routes/speakers.ts` | `GET /api/speaker-rule-gates`, `GET /api/speaker-eval`, `POST /api/speaker-eval/run`, `GET /api/speaker-eval/run/:jobId`, `POST /api/speaker-retrain/run`, `GET /api/speaker-retrain/run/:jobId` | speaker inference/corrections/evaluation/training |
| R37 | `registerAspectReviewRoutes` | `packages/api/src/routes/aspectReview.ts` | `POST /api/aspect-review/prompt-preview`, `POST /api/aspect-review/run`, `GET /api/aspect-review/run/:jobId` | assistant |
| R38 | `registerJobRoutes` | `packages/api/src/routes/jobs.ts` | `GET /api/jobs`, `GET /api/jobs/:jobId`, `GET /api/jobs/events`, `GET /api/inbox`, `POST /api/inbox/:id/read`, `POST /api/inbox/read-all` | module-runtime shared jobs, domain-specific tasks owned by modules |
| R39 | `registerWorkspaceRoutes` | `packages/api/src/routes/workspace.ts` | `GET /api/workspace`, `POST /api/session/begin`, `POST /api/session/submit` | Core Git operations/recovery |
| R40 | `registerProjectRegistryRoutes` | `packages/api/src/routes/projects.ts` | `GET /api/projects`, `POST /api/projects`, `PUT /api/projects/:id`, `DELETE /api/projects/:id`, `PATCH /api/projects/:id`, `GET /api/projects/events`, `GET /api/projects/:id`, `POST /api/projects/:id/sync` | Core repository registration/reconstruction |
| R41 | `registerSeriesRoutes` | `packages/api/src/routes/series.ts` | `GET /api/series`, `GET /api/series/:id`, `POST /api/series`, `PATCH /api/series/:id`, `DELETE /api/series/:id`, `GET /api/projects/:id/series-binding`, `PUT /api/projects/:id/series-binding`, `DELETE /api/projects/:id/series-binding` | story multi-work bible overlay |
| R42 | `registerIdentityRoutes` | `packages/api/src/routes/identity.ts` | `GET /api/github/device/config`, `POST /api/github/device/start`, `POST /api/github/device/poll`, `GET /api/auth/me`, `POST /api/auth/logout`, `PUT /api/auth/policy`, `GET /api/auth/github/repos`, `GET /api/auth/tokens`, `POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id` | Preserve owner access/credential connection through adapters; Platform user/OAuth/session authority is explicitly relocated, not cloned into Core |
| R43 | `registerMeRoutes` | `packages/api/src/routes/me.ts` | `GET /api/me/recent-activity`, `PUT /api/me/recent-activity` | Same single-owner access projection; hosted account administration belongs to Platform |
| R44 | `registerReviewQueueRoutes` | `packages/api/src/routes/reviewQueue.ts` | `GET /api/review-queue` | shared review host; speaker/story/assistant queue contributions |
| R45 | `registerScratchRoutes` | `packages/api/src/routes/scratch.ts` | `POST /api/scratch` | Core writing scratch/checkpoints and browser recovery |
| R46 | `registerDialogueSketchRoutes` | `packages/api/src/routes/dialogueSketch.ts` | `POST /api/dialogue-sketches/suggest-line/prompt`, `POST /api/dialogue-sketches/suggest-line`, `POST /api/dialogue-sketches/suggest-lines/prompt`, `POST /api/dialogue-sketches/suggest-lines`, `POST /api/dialogue-sketches/suggest-topics/prompt`, `POST /api/dialogue-sketches/suggest-topics`, `POST /api/dialogue-sketches/:id/analyze-zukan/prompt`, `POST /api/dialogue-sketches/:id/analyze-zukan` | assistant dialogue topics/lines with story/speaker context |
| R47 | `registerShareRoutes` | `packages/api/src/routes/share.ts` | `GET /api/shares`, `POST /api/shares`, `DELETE /api/shares/:id`, `GET /api/share/:token`, `GET /api/share/:token/scenes/:sceneId` | publishing read-only, scope/expiry/revocation checked against persisted grant metadata |
| R48 | `registerMcpRoutes` | `packages/api/src/routes/mcp.ts` | `POST /api/mcp`, `GET /api/mcp`, `DELETE /api/mcp` | mcp HTTP transport; same actions as stdio package |

## Non-router groups

The fixed 12 groups N01–N12 and their required behavior are in `ledger.json`; caller/UI and authoritative storage expansion remains pending for each.

## Pending evidence

The first producer freeze does not yet attach caller/UI surfaces, handler call-symbol chains, or authoritative storage readers and writers. Those fields are explicitly `pending` in every route/group record. Every route/group remains `migrationStatus: pending` with no proof IDs. The coordinator reported typecheck, tests, build, `audit:core`, and real Chromium passing; P00 inventory did not rerun those checks, and a frozen install result was not reported.
