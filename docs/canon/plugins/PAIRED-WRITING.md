# Canon P1 — `proprium.paired-writing` (MCP-first Context and Change Review)

**Product job:** The author keeps writing while an external LLM (ChatGPT/Codex/other approved client) can inspect a selected piece of the work, suggest evidence-backed changes, and have those changes **selectively approved** by the author. This plugin does not run the LLM itself and does not replace the Gateway MCP transport.

## Canonical operation and source of truth

- Unified typed Narrative Action Registry for **read**, **propose**, and Host-only **apply**. UI, plugin and MCP call the *same* action ID/validators, the same file revision, and the same ChangeSet/receipt store. No separate Scriptorium Node HTTP or independent direct-write tool path.
- **WritingContextSnapshot**: immutable view of selected `repository_id`, branch, scene/work ID, manuscript saved revision + hash, text range/caret context and optional explicitly shared dirty selection. The Host never pretends that a locally shared unsaved draft is Git-published.
- **Context Manifest**: array of source kinds, paths, revisions, source char/byte/token counts, truncations, freshness, inclusion reasons, consent state and author-vs-client supplied selection. **It reports only what Proprium provided**, not what an external host actually inserted into its model prompt.
- **Narrative ChangeSet**: schema version, stable change-set ID, project+target identities, original snapshot/preconditions, goal, ordered operations with stable operation IDs, read/write sets, diagnostics before/after references, evidence citations, risk/confidence, author decisions and applied-result revisions.
- Preserve historical Scriptorium `modules/story/src/narrativeChangeSet.ts` version-1 operations (`manuscript.replace-range`, `entity.create/update`, `scene.create/insert/update`, `state.append-event`, `thread.link-scene`, `reference.link`) via a **validated versioned adapter**. Do not assume any arbitrary JSON or LLM prose is a valid change operation.
- An applied ChangeSet records exact reviewed operations and resulting local Git revision/receipt. Publication remains **separate** from apply. Partial apply must be real and accounted operation-by-operation; unresolved partial failures are not success.

## Typed action model (Host and plugin responsibilities)

| Action | Allowed effect |
| --- | --- |
| `paired.context.capture` | read: current scene/selection/revision, explicitly bounded source bytes; client cannot request private unsaved draft by implication |
| `paired.context.manifest` | read: supplied source parts, revisions, character/token counts, exclusions, and disclosure scope |
| `paired.actions.list/info` | read: stable fully-qualified action names, effects, schemas, required capabilities; no hidden mutable write path |
| `paired.changeset.validate` | read: parsed typed operations, evidence/read/write sets, source revisions, risk, conflicts and diagnostic references |
| `paired.changeset.propose` | propose: author-visible pending ChangeSet, **no** Git/worktree mutation |
| `paired.changeset.status/diff` | read: proposal lifecycle, operation receipts, exact file and semantic diff, stale reason and linked source |
| `paired.review.open` | Host navigation: open the **Host-controlled** review surface for the specified proposal |
| `Host.reviewChangeSet` | **Host-only privileged action**: author approve/reject/defer selected operations, verify latest expected revisions and atomically apply validated subset or report truthful receipts |

Provider-free helpers (context assembly, QA evidence lookup, outline summaries when deterministic, revision-aware rewrite candidates, dialogue context, continuation retrieval) belong here, but **a built-in LLM provider is not required**. Optional old provider settings/history remain migratable author data, not a reason to bundle SDKs or model choices in the minimum plugin.

## UX contract

- A selection-aware **Context / Inspect / Changes** dock contribution opens from the current scene without shifting editor focus or losing typing. Large diffs use Host review modal/panel, not tiny markdown output or automatic inline mutation.
- Before sending any local draft through a remote MCP client, show user-scoped sharing intent and surface the bytes/range/path to be sent; default shares saved revision and selected metadata, not the entire private work. Cloudflare Access ingress auth does not imply the author has consented to all content disclosure.
- Author reviews each proposed operation with full before/after evidence and base revision, accepts a subset, rejects or defers. Revisions are rechecked **at apply time**. If the current manuscript changed while the assistant worked, report `stale_precondition` and preserve newer input.
- After apply, output new diagnostic/history references, restore original scene/caret/selection/scroll/focus, and keep remaining unapproved suggestions available. Ignore/cancel/timeout does not change Git or erase draft.
- MCP `tools/list` continues to expose core tools regardless of active plugins. `plugin_call` resolves this plugin's operation IDs, passes explicit repo ID and branch and returns typed errors for plugin missing/disabled; no per-client token/grant UI.

## Source inventory / known incompleteness

**Scriptorium primary:** `modules/mcp/src/{tools,context-manifest,change-set-schema,http}.ts`, `modules/story/src/narrativeChangeSet.ts`, `modules/assistant/src/{continuation-context,dialogue-context,rewrite-local,qa-tools,aspect-review}.ts`, `packages/contracts/src/index.ts`, `packages/core/src/transactions.test.ts`, `app/src/contributions/ProposalReview*`, `app/src/application/SharedApplication.tsx`. Scriptorium module code is a **source**, not an activated WASM plugin. Verify actual supported ChangeSet effects before claiming full parity.

**Arcadia Loom fallback and authority:** `docs/design/mcp-first-paired-writing-target-architecture.md` is the canonical original paired-writing intent; `app/src/features/review/ReviewView.tsx`, `app/src/features/editor/{InlineDiffCandidate,SelectionLens,RewriteSuggestModal}.tsx`, `app/src/features/ai/DialogueSketchView.tsx`, `packages/core/src/narrativeChangeSetApply.ts` for UI and operation semantics. The Loom main merge explicitly described waves 2–5 as incomplete; do **not** call planned Context Dock/Task Runner behavior preexisting shipped functionality. Nevertheless the target behavior here is binding.

## Dependencies and negative cases

Hard: Narrative identities/actions, Host versioned file reads, common action registry, Host-owned proposal-review/apply/receipt and Live MCP's active Browser Host forwarding if MCP is used. Optional Knowledge, Research, Diagnostics and Speaker add evidence; absence yields truthful `source_unavailable` for that enrichment, not absent proposal/review altogether. No model download or embedded provider setup.

Tests must induce simultaneous author editing and an external proposal, lost response, expired old snapshot, duplicate ChangeSet id, mixed-success operation ordering, invalid path, exact same target from two tabs, Host/SSE disconnect and mode switch. Never read/propose across an unselected repo.

## Acceptance — first usable paired writing milestone

1. Author opens scene, types, selects text; external MCP `plugin_call` requests **revision-pinned** context; Context Manifest shows what Proprium exposed. Dirty draft is not sent silently.
2. External client proposes multiple supported operations with citations, risk, exact read/write revisions; UI renders complete diff; author partially approves; rejected ops do not apply.
3. Change after proposal -> stale rejection with draft preserved. Duplicate invocation or lost response never repeats applied edit. Invalid proposal does not modify Git.
4. Applied subset updates local revision + diagnostics/history and returns to same scene/caret/scroll; no auto-checkpoint/publish. UI and MCP use identical Action IDs/results.
5. Provider `none` / no external API key still allows context, MCP, review and local diagnostics. Real signed plugin + Desktop/Mobile evidence required.
