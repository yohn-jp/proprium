# Scriptorium — Desktop / Mobile UI Modernization V1

- Goal ID: `SCRIPTORIUM-UI-V1`
- Status: **accepted scope; execution not yet verified**
- Fixed on: 2026-10-18 (JST)
- Repository: `yohn-jp/scriptorium`
- Baseline inspected: `9023db788ee26bf0bf2744381a2927d7508302f4` on `main`
- Scope authority: the owner's 2026-10-18 instruction and this document. Implementation must refresh `main` before changing code; moving HEAD does **not** change this goal.

## 1. Immutable finish line

Deliver one Scriptorium application with **two separately built, fully usable React frontends**, both served by the **same Fastify origin, API, persistence system, module runtime and single OCI container**:

1. **Desktop**: React + Radix Primitives and shadcn/ui-style components, a keyboard-oriented resizable writing workbench.
2. **Mobile**: Ionic React, a touch-oriented page/navigation model with an editor-first screen, accessible navigation, tool views and Japanese reading experience.
3. **Explicit UI selection**: no User-Agent, viewport-width or pointer-type auto-selection. The user chooses Desktop or Mobile; the choice is remembered on this origin, and a switch action is available in both UIs.
4. **Shared application semantics**: one set of domain/application services for projects, scene identity, editing, browser Draft, local Git Checkpoint, confirmed GitHub Publish, conflicts, proposals, jobs, module capabilities and permissions. Different Shell layout/navigation is intentional, not duplication of these operations.
5. **No feature/data regression**: the existing Core flow, supported Japanese writing/reading behavior, Core/Full/Hosted selection, eight installed first-party module families and their currently registered browser contributions remain available according to the selected module profile. The existing MCP service is not forced to have a browser panel.

The goal is **not** completed by a visual prototype, two empty shells, a responsive CSS facelift, successful typechecking alone, or a Desktop-only migration. The two frontends must work with the existing production API and recovery model.

The acceptance criteria and exclusions below are fixed for this goal. Discovering a bug changes the implementation steps or creates a precise blocker; it does not authorize changing the finish line, inventing unrelated features, or replacing this document without the owner's explicit instruction.

## 2. Existing authority and baseline to preserve

- `AGENTS.md`, the organization-wide governance, `docs/architecture/FULL-MIGRATION.md`, `docs/architecture/CORE.md`, the repository's current code and tests.
- `docs/migration/CAMPAIGN.json` records P00–P13 implemented and accepted; `docs/verification/FINAL-MIGRATION.md` describes scoped standalone evidence. Older Issues #1/#4/#5/#6/#7 remain open in GitHub but are not authority to restart migration.
- `docs/verification/HOSTED-CAMPAIGN-2026-10-17.md` explicitly leaves live Hosted/Praetorium integration gates unverified. This UI goal must keep their current contracts functional but does not absorb those external integration gates.
- Current important seams: `app/src/App.tsx`, `app/src/editor/{SceneEditor,ManuscriptInput,MobileReadingPager}.tsx`, `app/src/storage/journal.ts`, `app/src/contributions/{ContributionHost,ProposalReview}.tsx`, `app/vite.config.ts`, `packages/api/src/server.ts` static serving, `scripts/{profile-build,profile-package}.mjs`, `Dockerfile`, `tests/e2e/`.
- Existing UI module declarations: Story, Diagnostics, NLP, Semantic, Speaker, Assistant, Publishing, MCP. At baseline, the first seven expose **39 registered browser contribution IDs**; MCP exposes no browser contribution. Audit against the actual selected profile at execution time, not a hardcoded count alone.

## 3. Fixed interface and ownership contracts

### URLs, entrypoints and assets

- `/` is a small explicit choice/resume entry. On first visit show Desktop/Mobile choices; later reuse the same-origin persisted selection. Direct paths override that preference without changing it unless the user explicitly switches.
- `/desktop/*` and `/mobile/*` are independently built and served entrypoints. Their resource identity/deep-link semantics must match (project, volume, chapter, scene where applicable); switching preserves the current document destination.
- No device sniffing, redirect-by-User-Agent, or media-query Shell selection. Responsive CSS **inside** either Shell is permitted for local component layout.
- Both builds share the same origin, authentication and existing browser recovery storage. They are distinct JS/CSS entrypoints: Ionic styles/router must not be loaded into Desktop; Desktop-only Radix/shadcn styling must not override Ionic.
- Keep `/api/*`, `/_platform/*` handoff/reauth conventions, public reader `/r/*`, security headers/CSP, static-path confinement and existing asset semantics intact. A deep-link fallback may only apply to recognized UI paths; it must not swallow API/control/public endpoints.
- Build/ship both UIs through current Core, Full and selected Hosted composition machinery. Keep a **single runnable image per selected composition**, not an image/port/backend per device.

### Shared application / edit session

- Extract sharable application controllers, hooks and state from the current monolithic `App.tsx`, without rewriting Core. Each shell renders against the same state contract; separately loaded documents do **not** magically share live React memory.
- Mode switching is a real navigation between separately built apps. Before switching, settle Japanese IME composition and flush or confirm the existing IndexedDB journal. If a recoverable draft cannot be recorded, **do not navigate**; report the problem and retain the current input.
- Rehydrate scene/document selection, draft and proposal receipts on the destination Shell using existing stable repository/document/author identity. Do not clear a journal merely because a checkpoint succeeded; do not implicitly push to GitHub.
- Preserve `Draft` (browser), `Checkpoint` (local Git commit), `Saved` (confirmed GitHub publish), `publication_unknown`, remote-freshness and conflict distinctions. Never imply GitHub publication when only the browser or local clone was saved.
- Preserve revision preconditions, immutable snapshot IDs, operation idempotence, author approval and GitHub's normal non-force push rules. Avoid copying data into a second persistence authority.

### Layout and module UI

- Desktop: work navigation, primary CodeMirror manuscript editor/reading mode, selectable detail/tool panel; keyboard interactions and optional resizable panes. Use Radix primitives and selected shadcn/ui components rather than another homegrown widget framework.
- Mobile: Ionic routing/layout with distinct library, writing/reading, inspection/review, and tools/settings views. Keyboard appearance, safe areas, back navigation, touch targets and scrolling must leave the manuscript reachable and editable.
- Preserve the current CodeMirror 6 adapter, Japanese IME, cursor/selection and undo history, ruby, vertical preview, reading-page navigation, typography preferences, themes (light/dark/paper), history/recovery and accessible focus handling. A feature can be moved to a different screen; removing it is not modernization.
- Adapt the existing `UiContribution` / `ContributionHost` boundary to both Shells: a discoverable, selected feature mounts on demand and disposes correctly; disabled/not-included modules never become callable by hiding UI alone. Preserve actions, proposal approval, snapshots and capability boundaries. Reuse feature views when practical; **do not** implement every action/form twice.
- The current module browser UI uses mixed React and imperative DOM. Provide the smallest compatible shared hosting adapters; do not rewrite all module algorithms or introduce runtime `npm install` / untrusted third-party plugins.

## 4. Fixed work inventory and dependency boundaries

| ID | Deliverable | Primary ownership / dependency | Evidence |
| --- | --- | --- | --- |
| U00 | Baseline and reproducible UI/route/module acceptance inventory | Coordinator; read actual production paths and existing tests once | Current baseline, route/profile and contribution inventory; existing green/red checks recorded |
| U01 | Shared application state/navigation/recovery adapter | Application UI owner; after U00 | Both Shells can load the same project/scene/edit session contract without copying Git/recovery algorithms |
| U02 | Dual Vite entrypoints, Fastify routing, packaging/OCI profile integration | Build/API owner; after U00, contracts coordinated with U01 | Core/Full/selected Hosted builds contain both independent UIs and serve them on one origin |
| U03 | Desktop React + Radix/shadcn workbench | Desktop UI owner; after U01/U02 interfaces fixed | Project tree, manuscript editor, history, save/recovery status and tool selection usable |
| U04 | Mobile Ionic React interface | Mobile UI owner; after U01/U02 interfaces fixed | Library, scene editor, reading, tools, back navigation, soft keyboard and safe-area flows usable |
| U05 | Shared lazy module contribution catalog/host | Module UI owner; after U01/U02, consumed by U03/U04 | All registered/enabled contributions reachable in both Shells, correct teardown and permission/snapshot behavior |
| U06 | Explicit mode switch and full edit/reading UX parity | UI integration owner; after U03–U05 | Deep links and both-direction switch preserve recoverable edits, proposals, IME/reading and correct durability states |
| U07 | Integrated regression, accessibility and release/profile verification | Verification owner; after integrated candidate, may write tests earlier | Evidence below on exact submitted code/image; failures fixed only within this goal |

This is a **fixed task list**, not permission for recursive backlog expansion. Coordinator alone owns shared package/lockfile, build/route integration and dependency arbitration; independent workers own disjoint Desktop, Mobile and module-host surfaces. Producer interface checks happen before consumers build on them. Avoid duplicate discovery and repeated independent micro-reviews. Implement useful tasks in parallel where inputs are ready; a local defect in one leaf does not halt unrelated leaves.

## 5. Acceptance criteria (all required)

**A. Delivery / selection**
- First visit to `/` offers an explicit interface choice. The remembered choice survives reload and can be changed from either Shell. No automatic device-based selection.
- Direct Desktop/Mobile deep links load the intended work/scene, and switching preserves resource identity. Browser back/forward and refresh work. Both builds authenticate through the current standalone and Hosted application contracts as appropriate.
- One Fastify runtime/one origin/one OCI image serves the launcher, both UIs and API. Core has no optional model/browser-module dependency leakage; Full and selected Hosted compositions preserve installed-module inclusion/exclusion.

**B. Durable writing and conflict safety**
- A user can open a work, navigate volume/chapter/scene, edit a manuscript, reload, checkpoint, explicitly publish, inspect history and understand all three durability states in either Shell.
- Switch Desktop → Mobile → Desktop and Mobile → Desktop → Mobile with uncommitted browser drafts; prove exact content and scene identity survived. A failed/quota-denied journal flush blocks navigation and surfaces an actionable error.
- Stale remote revisions and ambiguous publications never silently overwrite work or report success. Conflicts and pending proposals remain reviewable, including after switch/reload. The Shell does not bypass existing approval or author permissions.

**C. Editor and mobile usability**
- On desktop, keyboard focus, scene navigation, command/tool access, resize, dialogs and editor selection behave correctly.
- On mobile-size Chromium and WebKit browser runs, the manuscript remains editable with the keyboard open; no horizontal page overflow at representative widths (320, 390, 768 CSS px), obscured primary actions or trapped scrolling. Exercise navigation/back, touch and orientation/layout changes.
- Verify Japanese IME composition across editor interactions, undo/redo and cursor restoration; ruby, vertical reading and page gestures remain functional. Do not claim a real iOS/Android hardware run from emulation alone.
- The three existing theme modes and accessibility basics (labels, focus visibility, reduced motion and reachable controls) work in both Shells.

**D. Module and app completeness**
- Full profile: compare actual registered enabled contributions to discoverable entries in each Shell; none silently disappear or mount all at once. Their production actions, snapshot checks, proposal review/approval and failure states retain the same backend semantics.
- Core/no-addon and representative selected Hosted module profiles (at least no-addon, Story and MCP) expose only selected capabilities, with no unauthorized module load or callable hidden feature.
- Existing public reading/share/export and MCP behavior remains functional; do not create a separate Mobile module implementation for its own sake.

**E. Verifiable delivery**
- On the final code: run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm audit:core`, production browser tests including Chromium and WebKit coverage for the new Shells, Core/Full OCI acceptance and selected Hosted profile packaging/smoke. Use `pnpm verify` where applicable; if a stage fails, record its exit and exact successful rerun separately.
- Test actual packed production assets and browser/API flows, not only component mocks. Inspect missing assets, CSP errors, resource leakage and API/public route precedence. Record build/image identities and the exact tested HEAD. Existing migration baseline results do not certify this new revision.
- If an actual external resource (OCI engine, WebKit, physical device, Hosted identities, GitHub fixture) is unavailable, report that gate as `BLOCKED` or `NOT_CHECKED`, never `PASS`. Do not use an unrelated Hosted/Praetorium certification gate to stop UI implementation.

## 6. Exclusions and delivery rules

Not in this goal: new novel-writing AI features, new module families, model/provider changes, semantic algorithm rewrites, Core persistence redesign, CRDT/offline collaboration, multi-tenant access redesign, a separate native iOS/Android app, Capacitor/PWA packaging, a new remote build/control plane, Praetorium changes, registry publication, production deploy, unrelated refactors, mass migration of Arcadia history, or release-tag creation.

- Apply the repository and organization governance, including isolated implementation branches/worktrees and required verification. Documentation-only publication of this accepted goal does not authorize implementation work on `main`.
- Coordinator may use bounded subagents with nonoverlapping ownership; keep the task list and finish line fixed. Save useful progress in commits/PRs rather than holding a large uncommitted batch. Do not merge implementation PRs or close historical Issues without separate explicit authorization.
- Review the integrated candidate against this goal and surrounding code; report only reproducible contract violations with cause and fix. No arbitrary count of small independent review jobs.
- Done means **all A–E are proven for both Shells and the verified changes are published in reviewable implementation PR(s)**. Mainline integration is a distinct authorized action; mark the goal `READY_FOR_MERGE`, not `INTEGRATED`, until that action is authorized and observed.
- If a mandatory verification step is truly blocked, preserve completed implementation/PRs and report exact `BLOCKED` evidence plus the minimal external unblock. Do not redefine or quietly shrink the goal.
