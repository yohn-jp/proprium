# Core 64 G1 — editor and workspace render attribution

Status: C06 and C11 remain deferred with no code change. A matched instrumented capture on the C02-integrated runtime measured C04/C07/C08; it did not identify a small render or Workspace derivation optimization, so no production change was adopted. Runtime source is `e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47`. G0 aggregate evidence and the matched G1 capture are retained in [the G0 summary](results/core64-render/g0-postw1-summary.json) and [G1 attribution summary](results/core64-render/attribution-summary.json).

## G0 evidence available

The inherited G0 small fixture has 1 KiB, 100 KiB, and 1 MiB scenes, 20 repeats, Node 24.21.0, and Chromium 155.0.8059.79 on the same Linux x64 host. The input phase windows in the aggregate React hook show 17 / 11 / 96 commits and 1 / 33 / 76 Long Tasks. Their Long Task totals are 154 ms / 1.871 s / 25.136 s, with maxima 154 / 198 / 673 ms. The 1 MiB aggregate commits visited 12,358,947 fibers.

These are aggregate counts. They do not say which panel changed, how much Workspace's panel-ID/catalog derivation cost, whether a panel mounted, or which component rendered. The CPU profile spans the whole browser run and cannot isolate a panel. Do not infer C07/C08 benefit from the aggregate counts alone.

W1 C04 remains integrated and its tradeoff remains open: the final W1 capture improved 1 MiB typing latency relative to its initial W0 capture, while commits rose from 56 to 92 and Long Tasks from 63 to 73. Preserve authoritative `workRef`, immediate text publication, strict IndexedDB completion, pending-status behavior, and the IME, history, print, restore, navigation-generation, and author-scope contracts. This unit does not repeat W1's architecture.

The C02 owner handed over ArrowLeft p95 values of 6.4 / 55.5 / 606.9 ms for 1 KiB / 100 KiB / 1 MiB, n=20, plus rough `onCursorPositionChange` samples near 1 ms across roughly ten-second arrow windows. The callback sample does not establish cause. The matched run below includes the accepted C02 runtime and measured 9.6 / 12.0 / 24.5 ms for its 20 ArrowLeft frame proxies. The G0 aggregate hook and this panel-aware hook differ, so this is context rather than a direct before/after comparison. The probe does not instrument or alter the resume hook.

## C06 and C11 source decisions

**C06 — defer broad `SharedApplication` decomposition; no code change.** `AuthorWorkspace` in [SharedApplication.tsx](../../app/src/application/SharedApplication.tsx#L398) owns the live `workRef`, React publication state, navigation and scene-load epochs, author scope, draft generation, serialized journal queue, and timers. `editText` builds the complete operation, advances its generation, updates the authoritative ref immediately, and schedules the existing React publication or 350 ms draft timer ([edit path](../../app/src/application/SharedApplication.tsx#L1618)). Moving that function or its state into another file would leave those operations intact.

The async boundaries also share one binding. `loadScene` captures navigation and scene-request epochs plus author scope; flushes the editor's composition and current draft before reading; verifies the returned remote/effective snapshots; and checks freshness after journal/receipt awaits ([scene load](../../app/src/application/SharedApplication.tsx#L905)). `persistDraft` serializes draft writes and only publishes completion into the same navigation, author, operation, and text ([draft persistence](../../app/src/application/SharedApplication.tsx#L1563)); the journal implementation uses a strict read/write transaction and awaits its completion ([journal.ts](../../app/src/storage/journal.ts#L234)). Remote restore drains pending work, captures repository/document/scene/author and operation generation, removes only eligible drafts, and rechecks the live binding before replacing editor state; if the captured draft changed, it preserves or re-persists that newer draft ([restore path](../../app/src/application/SharedApplication.tsx#L2020), [draft-only removal](../../app/src/storage/journal.ts#L595)). These are correctness ownership boundaries, not independently measured performance boundaries.

G0 has aggregate root-fiber and Long Task counts, not per-component durations or an isolated state-owner cost. A broad extraction would move these responsibilities without removing the measured work, and it could disturb the generation, recovery, author-scope, and strict-write relationships. Defer C06 unless a matched profile identifies one small owner boundary with a measurable cost; any later change should target that leaf and retain its current guards.

**C11 — defer `SceneEditor` decomposition or lazy view loading; no code change.** The editor owns CodeMirror's composition-flush registration, immediate pending text status, resume-position restoration, reading/typography state, print flush, preview, scratch entry, and external history integration ([SceneEditor.tsx](../../app/src/editor/SceneEditor.tsx#L218), [resume and flush effects](../../app/src/editor/SceneEditor.tsx#L247), [view composition](../../app/src/editor/SceneEditor.tsx#L372)). The parent deliberately keys its lifetime by author, repository, document path, and write permission ([SharedApplication.tsx](../../app/src/application/SharedApplication.tsx#L2458)). Splitting JSX or moving these states would not by itself reduce the editor's reconciliation work. Lazy loading could reduce startup bytes but would defer the cost to first use; G0 has no per-view bytes, component durations, or first-open timings to price that trade.

The source statically imports the reading pager, history panel, editor, and preview renderers ([SceneEditor.tsx imports](../../app/src/editor/SceneEditor.tsx#L5)). Reading and inline history have explicit mount conditions, while the primary editor stays mounted in the hidden editor columns during reading mode. History is also an independent Workspace panel in the production parent. G0 reports only aggregate entry assets (desktop JavaScript 753,221 bytes; mobile JavaScript total 1,688,058 bytes), with no view-level attribution. Optional contribution modules already have a separate generated loader and active-host lifecycle; this decision does not reopen that boundary ([ContributionHost.tsx](../../app/src/contributions/ContributionHost.tsx#L39)). Revisit C11 only if a source map or focused first-use trace isolates a costly optional view and an A/B proves that lazy loading improves the target without moving an unacceptable delay onto first use or remounting CodeMirror.

These C06/C11 source decisions remain unchanged. C04/C07/C08 now have their own measured dispositions below; the aggregate G0 result remains historical context, not panel attribution.

## Matched G1 attribution

The single capture used the C02-integrated source `e8aa3ecd`, the copied G0 synthetic-small fixture (1 KiB / 100 KiB / 1 MiB), 20 repetitions, Chromium 155.0.8059.79, and a 1440×1000 viewport. The instrumented hooks measured commit flags and references during typing, ArrowLeft, history, composition, paste, and Inspector/Outline activation. The table reports `Editor` and `Outline` fibers carrying React work flags; these are not component render durations.

| Document | Input phase | Commits | Editor / Outline flagged fibers | Panel array changed | ArrowLeft p95 (20 frame proxies) |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 KiB | Typing | 2 | 478 / 168 | 0 / 2 | 9.6 ms |
| 1 KiB | ArrowLeft | 0 | 0 / 0 | 0 / 0 | 9.6 ms |
| 100 KiB | Typing | 2 | 25,300 / 174 | 0 / 2 | 12.0 ms |
| 100 KiB | ArrowLeft | 0 | 0 / 0 | 0 / 0 | 12.0 ms |
| 1 MiB | Typing | 9 | 1,156,620 / 783 | 3 / 9 | 24.5 ms |
| 1 MiB | ArrowLeft | 3 | 385,545 / 261 | 2 / 3 | 24.5 ms |

At 1 MiB, each of the five panel definitions got a new object and render-function reference on each changed panel array. Those changes occurred in 3/9 typing commits, 2/3 ArrowLeft commits, and 3/4 paste commits. The corresponding `panelIds` and `catalog` derivations each ran 3 times while typing and twice during ArrowLeft; every timed derivation was at or below the 0.1 ms measurement resolution for five panels. The input did not mount or unmount panels. Selecting Inspector mounted it and unmounted Outline once; selecting Outline mounted it and unmounted Inspector once, matching the current single-active-panel behavior.

The full input windows recorded 1 / 19 / 32 Long Tasks for 1 KiB / 100 KiB / 1 MiB, totaling 157 ms / 1.142 s / 13.583 s with maxima 157 / 191 / 686 ms. These include the enhanced probe's traversal overhead and are not a direct comparison with G0's aggregate-hook counts.

The 1 MiB typing and selection commits carried most flags under the Editor subtree, while Outline had 783 and 261 flagged fibers respectively. This identifies which subtree contained flags, not how long its components rendered. The current probe does not produce `actualDuration`; its whole-tree fiber traversal also adds instrumentation overhead. The result does not isolate a small state-subscription seam for C04, nor show a worthwhile C07/C08 gain from stabilizing panel descriptors or memoizing the five-entry Workspace derivations. Keep W1's accepted C04 behavior and tradeoff; do not claim C04 is fully solved.

The temporary C03 `buildOperation` timer recorded 20 calls for each typing cohort: 1 KiB total 1.7 ms / p95 0.2 / max 0.7 ms; 100 KiB 6.4 / 0.5 / 0.5 ms; 1 MiB 56.2 / 3.8 / 9.9 ms. It recorded duration and input character count only, not allocation. These timings are shared with the C03 owner and do not support an operation-builder optimization here.

**Disposition:** C04 has a measured residual but no isolated additional state-subscription change; retain the W1 implementation and its documented tradeoff. C07 has observed panel-reference churn, but it is not tied to measured component time and a list-stability change would not eliminate the parent commits. C08's measured derivations are below timing resolution at five panels. No C04/C07/C08 runtime change is adopted from this capture.

## Probe and retained artifacts

`scripts/performance/core64-render.mjs` uses the synthetic small fixture and canonical input sequence, separating typing, cursor movement, history, composition, and paste by phase and document cohort. It records ArrowLeft key-frame latency, waits for a strict journal write, and reports panel activation/mount events. Its injected DevTools hook adds panel-scoped fibers and flags plus `SharedApplication` panel-array/object/render/title reference changes. The hook uses the same whole-root traversal as the aggregate React counter, not a second traversal. The report retains raw commit rows so derived phase/cohort summaries can be audited.

For the capture only, `Workspace.tsx` timed the existing memo derivations and `SharedApplication.tsx` timed successful `buildOperation` calls. Both opt-in product hooks have been removed; the final product diff is empty. The probe test covers phase-plus-cohort filtering, panel commit/reference attribution, derivation summaries, and panel mount/unmount events.

The injected probe adds measurement overhead and records commit flags, not React component `actualDuration`; the `Preview` subtree is part of the Editor panel and was not isolated. The operation timer records durations, not allocations. Its data is suitable for matched before/after runs with the same harness, not direct numeric comparison with G0's aggregate-only React hook. This capture did not justify a local candidate, so there is no after run and no speedup claim. C06 responsibility extraction and C11 editor lazy loading remain deferred without an isolated measured target.

## Measurement gate and commands

The C02-integrated Core profile was built with the temporary hooks, then one n=20 Chromium capture ran on an isolated copy of the G0 small fixture. The raw report and CPU profile are [before.json](results/core64-render/before.json) and [before.json.cpuprofile](results/core64-render/before.json.cpuprofile); their SHA-256 values are `686a4443a1174e3cf2dc664e0b863197cc29dc8b96511ac0ccee32a3411ccbc5` and `a97f8b25aba3713d2371a8b0747861321707d342110c91b94d3013272e02ba6b`. The cohort-corrected compact analysis is [attribution-summary.json](results/core64-render/attribution-summary.json), SHA-256 `5bcc152cdb725ed52fa8226d49e7c4e77b8565fc608e30346b8b350f93fe4450`. The capture script and probe digests are retained in the raw report; current script/probe hashes are in the compact summary. The original report's phase summaries initially omitted the cohort predicate; the final compact summary was recomputed from its retained raw event rows with the corrected phase-and-cohort filter, without another browser run. The probe test passes. The product hooks are removed, so this unit has no production-path verification requirement beyond the instrumented build already completing.

```sh
node scripts/performance/core64-render.mjs <fresh-small-fixture> docs/performance/results/core64-render/before.json 20
node scripts/performance/core64-render.mjs <same-small-fixture> docs/performance/results/core64-render/after.json 20
```

Set `SCRIPTORIUM_E2E_CHROMIUM` to the recorded Chromium executable for both runs. The harness itself starts the local fixture server and writes a sibling `.cpuprofile` file.
