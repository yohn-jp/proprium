# UI modernization V1 — U00 production inventory

Authority: `docs/goals/DESKTOP-MOBILE-UI-V1.md` at
`71a293fea66f3f1869e3fb8b333f1fb0cd1f03fd` (freshly fetched origin/main).
The starting tracked worktree was clean; unrelated `.codegraph/` was left alone.
Implementation uses isolated branches/worktrees; main and Actions are outside the write set.

## Existing production boundaries

- `app/src/App.tsx`: one React App/AuthorWorkspace; application state, remote observation,
  project/scene navigation, browser journal, checkpoint/publish, conflicts and proposal receipts.
- `app/src/editor/SceneEditor.tsx`: existing CodeMirror manuscript adapter, history,
  scratch, Japanese ruby/vertical/reading modes and typography. Reuse these views.
- `app/src/storage/journal.ts`: shared IndexedDB recovery authority scoped by repository,
  document and author. Shell switching must flush before navigation; no new persistence authority.
- `app/src/contributions/ContributionHost.tsx`: profile-selected browser loaders and
  capability-filtered contributions; baseline mounts all visible items in a slot.
- `app/vite.config.ts`: baseline one `index.html`, `main.js`, `styles.css`, lazy module assets,
  generated profile alias. Replace with independent launcher/Desktop/Mobile builds.
- `packages/api/src/server.ts`: same Fastify runtime serves static assets; current route
  map, nonce/CSP injection, public `/r/publishing/...`, API/platform precedence and
  filesystem confinement must remain intact.
- `scripts/profile-package.mjs` copies `app/dist` into the single runnable package;
  `Dockerfile` packages that selected composition. Hosted browser attestation in
  `scripts/hosted-build.mjs` currently verifies a single Vite manifest and must cover all three.

## Frozen producer interfaces

`ApplicationShellProps` in `app/src/application/contracts.ts` supplies presentation slots
(`header`, `library`, `editor`, `tools`, `status`), mode and async guarded switch action.
The shared application owns the existing state and operations. Desktop/Mobile own layouts.

Independent Vite outputs: launcher `app/dist`, Desktop `app/dist/desktop`,
Mobile `app/dist/mobile`; base URLs `/`, `/desktop/`, `/mobile/` respectively.
Each has its own index, JS, CSS, assets and manifest. No Ionic import in Desktop.
Resource links preserve project/volume/chapter/scene; direct links do not rewrite preference.
Same-origin preference key: `scriptorium:ui-mode`. Selection never uses device detection.

## Actual registered browser contributions

Source of inventory: `modules/*/src/index.ts` registration arrays, not a target count.
Runtime `contributions` and enabled module status remain the discoverability authority.

| Family | Registered IDs |
| --- | --- |
| Story | `story.navigator`, `story.inspector`, `story.continuity`, `story.world-state`, `story.zukan-review`, `story.series` |
| Diagnostics | `diagnostics.consistency`, `diagnostics.continuity`, `diagnostics.analysis`, `diagnostics.scene`, `diagnostics.lint`, `diagnostics.voice` |
| NLP | `nlp.analyzer`, `nlp.candidates`, `nlp.dictionary`, `nlp.privacy` |
| Semantic | `semantic.search`, `semantic.expressions`, `semantic.contradictions`, `semantic.index` |
| Speaker | `speaker.attribution`, `speaker.review`, `speaker.dialogue`, `speaker.voice.profiles`, `speaker.evaluation` |
| Assistant | `assistant.settings`, `assistant.rewrite`, `assistant.summaries`, `assistant.qa`, `assistant.continuation`, `assistant.aspect-review`, `assistant.dialogue`, `assistant.reader-reaction`, `assistant.proposals` |
| Publishing | `publishing.export.plaintext`, `publishing.export.epub`, `publishing.export.vertical-print`, `publishing.episode-map`, `publishing.share-links` |
| MCP | No browser contributions; preserve service behavior |

Full: eight included families, seven expose 39 browser entries. Core: no optional modules.
Selected Hosted no-addon: zero; Story: six; MCP: zero browser entries, MCP capability present.
Do not implement missing panels for MCP or load excluded modules to populate menus.

## Verification inventory

Required commands: frozen install, typecheck, test, Core/Full build, audit:core,
production Chromium/WebKit, browser recovery/conflicts/proposals, Core/Full OCI,
selected Hosted no-addon/Story/MCP package/smoke. Baseline command results are recorded
separately in `UI-V1-BASELINE.md`; they never certify the submitted candidate.

The initial install on the root filesystem failed ENOSPC (0 free bytes); the owner
provided `/data` with 185 GiB free. Worktrees and the task dependency store moved there.
This environmental failure is distinct from successful reruns. Chromium is installed;
WebKit and OCI availability require explicit preflight. No hardware run is inferred
from emulated viewports. External live Hosted/Praetorium gates remain excluded as stated
in the canonical Goal, while producer packaging/auth contracts remain required.
