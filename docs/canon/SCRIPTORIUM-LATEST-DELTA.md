# Scriptorium Source Delta — Canon Recovery

The pinned source revision for action and UI parity is `scriptorium@1a05a0f10b33acca3fcfc544a5a6a2592f1c3865` (superseding `95a66c2c985a66bc2d535392dcc450d8c9df18d5`). The intervening 33 commits changed 28 files without changing the 136 registered module actions; they contain authoring and recovery behavior relevant to the Narrative, Research and Host canons. Source-code presence is not runtime or acceptance evidence.

| Area | Scriptorium evidence | Required Proprium recovery behavior |
| --- | --- | --- |
| Browser departure and bfcache return | `app/src/api.ts`, `app/src/application/SharedApplication.tsx`, `tests/e2e/auth-recovery.acceptance.spec.ts` | In-flight responses from an old document generation never overwrite current editor; interrupted project/scene bootstrap and explicit navigation resume after `pageshow` without duplicate mutation or wrong-scene selection. |
| Pending scene/project activation | `SharedApplication.tsx`, `tests/e2e/core.acceptance.spec.ts`, `tests/e2e/ui-v1.acceptance.spec.ts` | Return to the intended project/scene after page restoration, preserving author scope and journal. |
| Japanese sentence index efficiency | `app/src/resume/continueCandidates.ts`, `app/src/continueCandidates.test.ts` | Reuse one `Intl.Segmenter` per manuscript indexing operation; preserve UTF-16 mapping, cursor, ruby and input responsiveness. |
| Terminology during departure | `app/src/editor/TermAwareRubyText.tsx`, `app/src/editor/cm/termAdornments.ts` | Suspend optional term rendering on departure, cancel pending work, resume only for the current document revision; never block or replace IME input. |
| Authorization and error recovery | `app/src/api.ts`, `packages/core/src/index.ts`, `packages/api/src/hosted-policy.ts`, associated tests | Browser authorization errors remain distinct from provider/runtime credential failures. A provider 401 is not automatically a user logout, and a 503 does not erase verified draft or scene. Translate these semantics to Browser Host and optional Gateway, not a legacy Node server. |
| Private history and quiescence | `packages/api/src/server.ts`, related server tests | Preserve provenance/history receipts on lifecycle shutdown; where Proprium has no Node server, do not copy its service quiesce implementation. |
| Evidence/CI maintenance | `.github/workflows/verify.yml`, `scripts/ci-*`, browser and performance tests | Select evidence for the exact commit/run; an unverified or failed browser recovery test cannot be marked PASS by an unrelated successful release workflow. |

## Binding additional acceptance conditions

- **DELTA-01**: Start an authorized scene read, navigate to a different scene, leave/return through bfcache; late responses may not overwrite text, selections, or journal identities.
- **DELTA-02**: Interrupt project activation, direct-link scene loading, and navigation; on `pageshow`, resume only the current intent, with correct scope and explicit errors if it cannot resume.
- **DELTA-03**: Treat a provider credential failure independently of Browser Host user identity; no forced login loop or loss of cached draft.
- **DELTA-04**: Index a multiline Japanese manuscript with UTF-16 offsets and ruby while measuring segmenter construction and stable editor responsiveness.
- **DELTA-05**: During page departure, terminate optional terminology work; on return, recompute only from the current pinned snapshot, without blocking typing.
- **DELTA-06**: Mobile WebKit draft recovery must preserve the exact original content including trailing newline and its journal/worktree distinction; use editor-state assertions rather than assuming DOM line rendering equals document bytes.

These cases supplement, not replace, `NAR-A03`, `NAR-A07`, `NAR-A08`, `NAR-A12`, Research term-navigation acceptance, and `R04`/`R05`/`R13`. Keep the original Scriptorium source immutable; Proprium implements equivalent observable behavior at its Browser Git/Host boundary.
