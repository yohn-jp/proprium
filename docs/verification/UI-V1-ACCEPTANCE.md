# Desktop / Mobile UI V1 acceptance record

The fixed scope is [DESKTOP-MOBILE-UI-V1](../goals/DESKTOP-MOBILE-UI-V1.md). The submitted candidate, command exits, browser results, image identities, and remaining gates are recorded in [implementation PR #10](https://github.com/yohn-jp/scriptorium/pull/10). Its verification record must name the exact tested commit; earlier baseline and diagnostic results do not certify a later commit. An open or draft PR is not an acceptance result.

## Implementation and acceptance map

| Work | Production boundary | Required evidence |
| --- | --- | --- |
| U00 | [Inventory](UI-V1-INVENTORY.md), [baseline](UI-V1-BASELINE.md), [OCI preflight](UI-V1-OCI-PREFLIGHT.md) | Refreshed main, existing route/profile/module contracts, separate baseline failures and unchecked gates |
| U01 | `app/src/application/{SharedApplication,contracts,navigation,recovery}` | Shared domain/controller and scene identity; navigation/recovery unit tests; both-shell production flows |
| U02 | `app/vite.config.ts`, three browser entries, Fastify static routes, profile packaging | Independent assets, dotted deep links, nonce/CSP, API/public precedence, profile closure and single-image HTTP checks |
| U03 | `app/src/shells/desktop` | Radix navigation, retained editor, keyboard resize, history, save states and lazy tools |
| U04 | `app/src/shells/mobile` | Ionic router/page structure, five views, retained editor, back/forward, scrolling and reduced-height layout |
| U05 | `app/src/contributions/{ContributionHost,catalog}` | Compare runtime registration to both menus; selected mount/disposal; production proposal, snapshot and permission tests |
| U06 | Shared edit-session flush, explicit launcher/switch actions | Exact journal text across both switch directions, denied-write rollback and blocked navigation, composition settlement, reload and explicit checkpoint/publish |
| U07 | `tests/e2e`, `scripts/verify.mjs`, OCI and Hosted smoke scripts | All A–E gates below on the submitted code; reviewable pushed PR, no merge |

| Goal criterion | Acceptance checks |
| --- | --- |
| A | Launcher preference/direct-route browser case; UI route API tests; Core/Full OCI HTTP checks; selected Hosted no-addon/Story/MCP package runtime smoke |
| B | Dual-shell draft/checkpoint/history/publish browser case; existing stale revision, ambiguous publication, conflict/proposal suites; real private synthetic GitHub/container replacement recovery |
| C | Separate Chromium and WebKit dual-shell cases: Japanese input events, undo/redo, retained selection, ruby/vertical reading, page navigation, widths 320/390/768, reduced-height editing, back/forward, themes, focus and reachable controls |
| D | Actual enabled-contribution catalog comparison in both shells; production module action/proposal tests; Core exclusion and selected Hosted closure/capability checks; public reading/export, MCP, diagnostics and migration acceptance |
| E | Frozen install, typecheck, test, Core/Full build, Core audit, production browser suites, Core/Full OCI, selected Hosted package/smoke; exact commit/image and separate failures/reruns in PR record |

## Reproduction and evidence boundaries

`pnpm verify` enumerates the canonical local stages. Equivalent separately logged stage invocations allow Core/Full OCI and selected Hosted checks in isolated worktrees without mutating the production assets used by a live browser run. Install and build must not overlap in the same worktree. Build Core before its browser/audit gates and Full before its browser/module gates.

This execution uses `/data` for worktrees, pnpm store, temporary files, OCI storage, model cache and browser runtimes after the original root-disk ENOSPC failure. Task-local wrappers supply rootless Podman with `cgroupfs` and the real bundled Playwright WebKit runtime inside a Nix FHS environment. These wrappers do not modify production source, image user, persistence contracts or signature policy. The WebKit host-preflight bypass is an environment accommodation; only an actual WebKit test exit establishes browser success.

Chromium and WebKit results are distinct. Chromium CDP touch input, WebKit touch-capable browser input, synthetic composition events, viewport orientation and reduced-height keyboard layout are browser automation evidence. They do not establish physical iOS/Android keyboard or OS IME behavior. No hardware run is claimed.

The recovery fixture is private, synthetic, has Actions disabled, and is restored through ordinary fast-forward commits with its history preserved. Its URL, authentication material and private repository data are intentionally absent from published evidence. The local private configuration is outside the repository.

The Diagnostics acceptance uses the pinned public E5 tokenizer described by [P13 model preflight](P13-MODEL-PREFLIGHT.md), with exact hash verification and the real local worker/cache path. A successful approximate fallback is not accepted as that gate.

[OCI and selected Hosted diagnostic results](UI-V1-OCI-ACCEPTANCE.md) retain earlier tested commits and known failed attempts. Live Hosted/Praetorium identity and deployment certification remains outside this goal; selected production profile packaging and runtime smoke remain required.
