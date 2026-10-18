# UI Modernization V1 baseline (U00)

This inventory records the production baseline used to start the accepted UI V1 goal. The inspected source HEAD is 71a293fea66f3f1869e3fb8b333f1fb0cd1f03fd. Requirements below the “Goal contract” label are target requirements; they were not present in this baseline.

## Goal contract

The accepted goal requires a first-visit interface choice at /, separately built Desktop and Mobile entrypoints at /desktop/ and /mobile/, a remembered same-origin choice, and a switch in each Shell. The two interfaces must keep the existing application, Git recovery, module and public-reader behavior on one Fastify origin and in one OCI image. The complete acceptance contract is in docs/goals/DESKTOP-MOBILE-UI-V1.md.

## Baseline route and build inventory

| Surface | State at the inspected HEAD |
| --- | --- |
| / | The single author application. app/index.html loads app/src/main.tsx, which mounts App.tsx directly. There is no interface launcher or stored UI preference. |
| /desktop/ and /mobile/ | No separately built entrypoints or shell-specific asset directories. app/package.json runs one Vite build into app/dist. |
| /r/* | The public reader uses the existing public route and the same application assets, without requiring an owner session. |
| /api/* | Fastify handles API and public module routes before static serving. Unknown API paths return an API 404 and do not fall through to the author app. |
| Static assets | The baseline serves the root index, fixed root JavaScript/CSS files, and confined /assets/* files. There are no Desktop or Mobile asset namespaces. |
| Packaging | Existing profile and OCI machinery packages the single browser build with the API and Core. |

The baseline author UI already uses the shared Core/API, CodeMirror 6, IndexedDB recovery journal, Draft/Checkpoint/confirmed GitHub publication states, revision-bound history and the existing contribution host. These contracts are preserved and exercised by the pre-existing acceptance tests; they are not new UI V1 deliverables.

## Module inventory

The Core profile selects no optional module. The Full profile selects all eight installed first-party families: Story, Diagnostics, NLP, Semantic, Speaker, Assistant, Publishing and MCP.

The first seven families register 39 browser contribution IDs. MCP registers no browser contribution. This count comes from their current module definitions and is only a baseline cross-check; U07 must compare the actual selected profile's API contribution list with each Shell's discoverable entries.

| Module | Registered browser contribution IDs |
| --- | --- |
| Story (6) | story.navigator, story.inspector, story.continuity, story.world-state, story.zukan-review, story.series |
| Diagnostics (6) | diagnostics.consistency, diagnostics.continuity, diagnostics.analysis, diagnostics.scene, diagnostics.lint, diagnostics.voice |
| NLP (4) | nlp.analyzer, nlp.candidates, nlp.dictionary, nlp.privacy |
| Semantic (4) | semantic.search, semantic.expressions, semantic.contradictions, semantic.index |
| Speaker (5) | speaker.attribution, speaker.review, speaker.dialogue, speaker.voice.profiles, speaker.evaluation |
| Assistant (9) | assistant.settings, assistant.rewrite, assistant.summaries, assistant.qa, assistant.continuation, assistant.aspect-review, assistant.dialogue, assistant.reader-reaction, assistant.proposals |
| Publishing (5) | publishing.export.plaintext, publishing.export.epub, publishing.export.vertical-print, publishing.episode-map, publishing.share-links |
| MCP (0) | No browser panel is registered. |

## Existing production acceptance coverage

The existing Playwright suite is rooted in tests/e2e and starts the compiled API with app/dist. Its baseline Playwright configuration defines Chromium only.

| Existing evidence | Production behavior already covered |
| --- | --- |
| tests/e2e/core.acceptance.spec.ts | Real Core and temporary Git fixtures; project and scene navigation; IndexedDB drafts; checkpoint versus explicit GitHub publication; history; conflicts and quota failure; Japanese ruby, vertical preview, reading pages and appearance modes. |
| tests/e2e/review-contributions.acceptance.spec.ts | Full-profile Story and Speaker review contributions, Core proposal storage and author approval flow. |
| tests/e2e/job-inbox.acceptance.spec.ts | Authenticated inbox and job events. |
| tests/e2e/recent-activity.acceptance.spec.ts | Recent activity, owner isolation and resume behavior. |
| tests/e2e/container-recovery.acceptance.mjs | Opt-in Chromium recovery against the production OCI image and a dedicated synthetic GitHub fixture. It replaces container data while retaining the browser's IndexedDB recovery state. |

Those tests establish useful Core behavior on the original single author UI. They do not prove the two new Shells, explicit selection, cross-Shell draft switching, mobile layout or navigation, contribution parity between Shells, or WebKit behavior. The existing P13 OCI record applies only to its recorded older source HEAD.

## Baseline check results

| Check on the baseline | Result |
| --- | --- |
| pnpm install --frozen-lockfile | PASS, per the retained baseline run summary. |
| pnpm typecheck | PASS, per the retained baseline run summary. |
| pnpm test | FAILED: the Core suite reported 45 passing and 25 failing tests after ENOSPC errors under /tmp. This is an environmental failure, not a successful baseline. The raw combined output was not retained with the scoped verifier logs. |
| pnpm build | NOT_CHECKED on this exact baseline HEAD. |
| pnpm audit:core | NOT_CHECKED on this exact baseline HEAD. |
| New Shell production browser and OCI acceptance | NOT_CHECKED; these entrypoints did not exist at the baseline. |

The baseline is not final-candidate evidence. U07 must run and record each required command and browser/profile/OCI gate against the exact submitted candidate HEAD. Chromium and WebKit results must remain distinguishable.
