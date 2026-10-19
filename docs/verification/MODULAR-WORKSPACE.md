# Modular Workspace implementation and verification

Status: complete. Core/Foreground, Composable Workspace, and Search/Terminology are implemented on main and the required acceptance checks passed.

## Scope and runtime identity

The accepted implementation scope is Core foreground integrity, a composable workspace, and the optional Search/Terminology module, under [MODULAR-WORKSPACE](../architecture/MODULAR-WORKSPACE.md). The completed full-migration ledger is not reopened.

- Starting main: `9fed4e237e64da97afa1f15960346a15d73711f5`.
- Verified production source: `8c0eb69109eab7d1f88cd59f7069c9b5e752b41e`, Git tree `1e5d5d71051357147300194c739d7707b7545daf`.
- Later submitted commits update acceptance tests and documentation only; the production sources, dependencies, manifests, and Dockerfile remain identical to this verified source. The final comparison was checked before this documentation integration.

## Responsibility boundaries

| Area | Implemented behavior | Ownership |
| --- | --- | --- |
| Core | Unchanged remote HEAD avoids fetch; observation/reconciliation reuse includes checkpoint and operation refs. Immutable document enumeration, bulk reads, and scoped deltas preserve file revision identity. | Git, snapshots, reconciliation, identity, path validation, and all project writes remain in Core. |
| Foreground | Display locally verified text while browser recovery completes; writing waits for authoritative recovery. Recovered same-scene background reads preserve input and the latest draft even on failure. Navigation generations reject stale results. | Shared application owns author-scoped recovery and manuscript sessions; CodeMirror editability changes without remounting its document. |
| Workspace | Independent Editor, Outline, Inspector, History, Review, and registered plugin panels; nested horizontal/vertical splits, tab groups, drag docking, accessible move controls, resizing, visibility, presets, and saved custom arrangements. | Host validates schema and live module permission; layouts are author/device browser preferences, independent of Git and recovery storage. Invalid prior bytes survive until explicit save. Hidden optional panels unmount, abort requests, and dispose resources. |
| Search / Terms | Optional `search` module; snapshot/overlay cache, path deltas, lexical/exact/prefix/scoped results, proposal-based dictionary edits, transient UTF-16 term ranges, deterministic ambiguity handling, and validated document navigation. | Derived indexes stay module-owned and bounded; the registry is changed only through Core proposals. Canonical manuscript/plot/bible/scratch text is indexed; operation records and other module state are excluded. Core imports no search package. Existing Core and Semantic search entrypoints remain available. |

NLP and Semantic enhancements are explicit optional requests. Ordinary lexical search and Core startup do not acquire models. Editor links use modifier-click or modifier-Enter, reading links use accessible buttons, and source Markdown is unchanged.

## Required local checks

All commands below passed after runtime integration on the production source identified above. Root logs are task-local under `/tmp/scriptorium-modular-*final6.log`; the sequential command chain exited 0. Later changes affect acceptance tests and documentation only.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: 414 passed, 0 failed, 1 skipped, 415 total |
| `SCRIPTORIUM_PROFILE=core pnpm build` | PASS |
| `pnpm audit:core` after the Core build | PASS; no optional search/model closure in Core |
| `SCRIPTORIUM_PROFILE=full pnpm build` | PASS; nine modules |

The skipped unit test is the existing opt-in Semantic real CPU rebuild/search/rerank/cache-recovery case. It was not executed and is not reported as passed. The changed lexical and term paths have focused cache, snapshot, cancellation, source-filter, ranking, ambiguity, registry-proposal, and lifecycle tests. No model lifecycle certification is inferred from lexical verification. Vite reports its existing large-chunk warning; builds exit successfully.

## Browser acceptance

All final browser checks passed on the production code identified above. Chromium is version 155.0.8059.79; cached WebKit 27.2 runs through the verification host's FHS runtime wrapper with Playwright 1.64.1.

| Profile / browser | Passed | Skipped | Evidence |
| --- | --- | --- | --- |
| Core / Chromium | 26 | 4 Full-only cases | Final test harness `effdf727`; 30 total, exit 0 |
| Full / Chromium | 29 | 1 Core-only case | Final projection-correct harness integrated as `effdf727`; 30 total, exit 0 |
| Core / WebKit UI-v1 | 2 | 1 Chromium-only catalogue case | Production source `8c0eb691`, exit 0 |
| Full / WebKit UI-v1 | 2 | 1 Chromium-only catalogue case | Production source `8c0eb691`, exit 0 |

Core Chromium log SHA-256: `b2d65870f89fc1f34d71caa5c689d07193711bbb3c08c91e64596d3edbc3ff14`, task-local `/data/scriptorium-modular-browser-results/effdf7272056ba8d6a4679f0cae462a169af61cc-core-chromium-final.log`. Core WebKit log SHA-256: `f7985234cb0687bbeb2b113291300d5310a49069d0eccddd03fc65c11770545b`. Full Chromium log `/tmp/scriptorium-modular-acceptance-effdf-full-chromium.log`, SHA-256 `ae0b0bb2224d681e0fc80c1db9de686f78ba6e0356b9d67ac26b6c6e1b8f0790`; Full WebKit log `/tmp/scriptorium-modular-acceptance-final8c-full-webkit.log`, SHA-256 `7080260503b0c0984b13559191337f762ef1a6f6b14a4f8fb82426b78589964d`.

The modular suite uses its own separately seeded disposable local Git remote so earlier publication tests cannot contaminate its source-content assertions. The intentional remote-conflict test restores its disposable bare ref and resets the local test Core store through the existing test-only control; external fixtures are excluded. Panel selectors use the production `module:` instance IDs and close the explicit Panels menu before interacting with panel content. Synthetic composition checks assert that navigation which would unmount an unfinished composition is blocked, preserves the exact text and journal, and succeeds after composition ends.

## OCI acceptance

The verified source uses local rootless Podman 5.8.9, linux/amd64, the existing cgroupfs wrapper with basename `podman`, and explicit OCI media type. The existing reject-by-default policy was inspected and left unchanged. No image was pushed.

| Profile | Exit | Image ID | Local manifest digest | Evidence |
| --- | --- | --- | --- | --- |
| Core | 0 | `91047791b9fb32faa977370274ea50ca0b539d52c047192851b16f964bcce9e6` | `sha256:db20d69a006d1fb70f491b846105dbab4c6bf1d32259853590575560f37480dc` | 54 production dependency versions, 0 modules, 13 HTTP assets; UID 1000, writable data and SIGTERM drain PASS |
| Full | 0 | `60903e62173bc88d566741abd7b0aedc9cf40a14233b96903934375177245c31` | `sha256:d92be9c3ef71a38ca26bc0c86937be7e94384d035dfba5f55ffd80aa0c44788d` | Nine modules idle, 37 HTTP assets; health/readiness, UID 1000, writable data and SIGTERM drain PASS |

Both manifests use `application/vnd.oci.image.manifest.v1+json`. Core log SHA-256: `4a6c3abd672a85424d0d60b467832dbe57c998b4bd0619f8530f5862692e095c`; Full: `47021db2711e66963263e83385354b054e165bc8b182fd5e47c95a0b7c136fd6`. Logs are task-local under `/data/scriptorium-modular-oci-logs/8c0eb69109eab7d1f88cd59f7069c9b5e752b41e-{core,full}.log`. Prior runs on earlier runtime candidates are diagnostic/source-specific evidence and do not certify this later runtime.

## Container replacement and GitHub durability

The actual [P13 acceptance](P13-BROWSER-RECOVERY.md) passed with exit 0 on `8c0eb69109eab7d1f88cd59f7069c9b5e752b41e`. A fresh dedicated private fixture contained only the runner's six generic synthetic seed files, with Actions disabled before its initial commit. The prior public fixture and its configuration were left untouched. Fixture URLs, credentials and browser journal keys are excluded from this record.

| Field | Result |
| --- | --- |
| Image / platform | `9bd35dd1068d3420b980fcfdf1230c8cf28dd8cd5b1c23b48523c338230618af`, `linux/amd64` |
| Manifest | `sha256:1adddf0af68161f4814811b0505062135229903f6e09bef1ec05050955c3e9cf` |
| Seed / explicit publication | `9cd2c47c169fab0670e61fe25059a6c2a733bce6` / `86bf903d16b439982edd07bacd17ccf4cea73519` |
| Recovery | Chromium restart retained IndexedDB; container data volume deleted/recreated; exact author checkpoint restored to a ready, writable Editor |
| Reconciliation | Successful `unchanged` outcome with matching operation receipt and checkpoint overlay; exactly one remote operation commit after explicit publication |
| Recovered operation | `2589e931-cc91-4e70-9220-6e7b8850a96a` |
| External unedited scene update | Observed commit `0497f4c9b44554181e3f33abc304561f5f519d02` |
| Same-file conflict | Author text retained; publication returned `conflict`; conflicting operation absent from GitHub |
| Final fixture commit | `e8498a299fdd317462ff3933123fcb3d33e30642`; remote history preserved |

Protected raw-log SHA-256: `1414b58dbbd92ea5ba5d22b98e3c34a8e45536a4a7f7723a8b363515e9c7ab02`. After the run, read-only checks confirmed the fixture remained private with Actions disabled, its final head matched, and temporary containers, volumes, browser profiles and browser processes were cleaned up. No reset or further remote writes followed the successful run.

Recovery acceptance waits for the actual server reconciliation result, receipt/overlay binding and writable Editor before comparing the exact author text. Reading an already persisted browser row alone is not treated as proof of Core replay. The production correction permits navigation refresh only for a pending, locked Editor displaying its verified canonical read; dirty ready/unavailable input still requires an exact recoverable record. The deterministic local browser regression separately holds checkpoint, paired scene-read and reconcile requests to install a canonical placeholder beside the protected author entry, then verifies recovery completes without publication.

## Integration commits

The coordinator integrated directly to main; workers used independent branches/worktrees. No PR, Issue, merge-review wait, CI workflow, image publication, production deployment, or unrelated feature migration was created.

| Commit | Change |
| --- | --- |
| `9323eb38` | feat(contracts): define workspace contribution contexts and optional search identity |
| `a128d46a` | feat(workspace): host scoped contribution instances and snapshot document navigation |
| `d7201430` | feat(core): inspect snapshot documents without a scene target |
| `7605dbeb` | feat(editor): add transient terminology adornments |
| `dd37cd9c` | feat(contracts): add snapshot document source |
| `ca8455c8` | perf(core): reuse stable snapshot observations |
| `5fbceb6e` | fix(app): gate editor writes on local recovery |
| `68b35271` | feat(workspace): add validated layout model and persistence |
| `a399f429` | feat(workspace): compose editable panels across shells |
| `0944145a` | fix(workspace): keep mobile panels lazy across views |
| `c80430d5` | fix(workspace): prioritize explicit mobile panel requests |
| `c75bd6f7` | fix(editor): make term navigation and scheduling safe |
| `bef47ae2` | fix(editor): key term resolution by snapshot identity |
| `9a5c5c45` | feat(app): compose core and plugin panels with scoped editor links |
| `a8bc6c4b` | test(e2e): cover modular workspace acceptance |
| `9957f6d3` | test(e2e): include optional search in full profile |
| `bd323c08` | test(e2e): adapt acceptance to workspace composition |
| `269b68ec` | fix mobile workspace shell accessibility |
| `7d5097df` | fix(app): surface workspace recovery errors across mobile views |
| `ed4905cc` | feat(search): add bounded snapshot lexical index and terminology resolver |
| `d1128114` | feat(search): wire optional query, terminology proposals, and workspace panels |
| `b1e2cd67` | fix(workspace): share composition and CSP nonce with the default shell |
| `d76e56d0` | fix(app): reflect failed journal open in recovery gate |
| `5bd5d846` | fix mobile same-route workspace navigation |
| `6d19e04d` | test(e2e): cover recovery open failure and paired scene reads |
| `17090847` | fix(app): keep same-scene editor writable during refresh |
| `a6c74570` | test(e2e): align workspace controls and mobile route coverage |
| `965d4bb1` | docs: describe modular workspace and optional search usage |
| `5adc9abc` | fix(app): select valid view when switching shells |
| `023749d0` | test(e2e): isolate fixture and align workspace selectors |
| `e6a85f16` | fix(workspace): reveal editor after explicit scene navigation |
| `aae7eedb` | fix(workspace): guard explicit editor panel requests |
| `fe2f1672` | test(e2e): preserve composition on blocked settings navigation |
| `fa92769c` | test(e2e): wait for recovered core replay readiness |
| `3753f29b` | test(e2e): dismiss workspace menu before panel interaction |
| `cafca972` | test(e2e): isolate modular workspace git fixture |
| `5ebc4bba` | test(e2e): accept unchanged checkpoint reconciliation |
| `45dd1bc6` | test(e2e): reset conflicted Core fixture after remote restore |
| `8c0eb691` | fix(app): unblock verified recovery refresh |
| `2c81ddfc` | test(e2e): replay checkpointed author entry after Core loss |
| `f769e7e6` | test(e2e): cover canonical placeholder during checkpoint replay |
| `effdf727` | test(e2e): compare complete retained recovery entries |

## Completion limits

All requested A/B/C implementation, integration and required verification are complete. There are no remaining implementation or verification blockers. The opt-in Semantic CPU test and profile/browser-specific skips are explicitly listed above and are not counted as passed. No performance benchmark or physical-device/OS IME run is claimed; browser automation establishes its named browser and viewport cases.
