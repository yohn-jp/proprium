# Authoring completion checkpoint — 2026-10-29

This is an **incomplete implementation checkpoint**, not a release certificate.
Continue from `origin/feat/authoring-completion`, Draft PR [#24](https://github.com/yohn-jp/proprium/pull/24), tracking [#23](https://github.com/yohn-jp/proprium/issues/23).
The last checked main is `75816593cec3dbca9080ec7073679ab3998993a7`; re-fetch it before further integration.

## Integrated

- Paired Writing is formally FROZEN. R09 and paired-only NAR/DIA requirements are separate from PASS; prior failures and shared gates remain required.
- The mechanical inventory covers all 114 features. At the audit checkpoint: 23 PARTIAL, 68 UNVERIFIED, 23 FROZEN, zero MISSING and zero certified IMPLEMENTED. Its assessment source is explicit; subsequent commits still require reassessment.
- Semantic bounded E5 model loading, index tasks, cancellation/resume and scoped caches; browser-discovered cache dispatch, prefix selector and first-step sequence defects were repaired with regression tests.
- Narrative recognition/outline/markers; Knowledge Scene Lens and source-bound creation; Research search/fusion, candidate/ignore review and persisted ignore filtering/listing; Diagnostics feedback/legacy-dismissal proposals; Speaker recovery; Publishing episode/grant recovery.
- Research asynchronous index task APIs are integrated, but RES013 remains PARTIAL: start source listing and cache publication still need bounded slices. Reload restarts from pinned Git; guest cursors are volatile.

## Verification boundary

- Host unit suite: 280 passed at `00a33f7`; subsequent Research UI verification reported 286 passed at `dccacfb`. Typechecks passed at those sources. These are not same-HEAD release checks.
- Semantic: 49 domain/guest tests plus one asset test passed on the first-step fix. Scoped cache dispatcher regression tests: 20 passed. Research ignore/list tests: 26 passed at `54968da`; RES013 leaf tests: 32 passed. Research Review stale-ignore fix: 7 tests passed on its leaf.
- Source-aware canon verification covered 114 features, 136 source actions, 33 tools, 42 UI contributions, 937 links and 228 paths. Evidence tests: 13 passed after the Diagnostics canon dependency was integrated.
- All eight actual signed Components built and verified at `72a1781468e8b6476c0c94ee058bc5d07b2f9fb7` using ephemeral test keys. Registry digest: `1b245f0b7af8962455c058d45a2143cfd42f0069da8e4bf88afa2b4ebb51cfda`. Later guest changes require a new build.
- Real Desktop Chromium and Mobile WebKit local-authoring edit/review/apply/local commit/reload recovery **passed**, 43.4s and 51.2s respectively, with test fix `ce3fa1b`, Host leaf base `9090258`, signed Components from `72a1781`. Earlier outline failures resulted from the test switching tabs and cancelling an unfinished read; the test now waits for recognition completion. The separately patched reviewed-volume case was not rerun.
- Desktop real-E5 browser verification is still running at checkpoint. Do not claim PASS. Earlier failure classifications and repairs remain in [integration-2026-10-29.json](validation/integration-2026-10-29.json).
- PR CI is not yet certified green. Gateway checks passed on earlier PR runs; a build/evidence failure from a missing Diagnostics canon commit was repaired locally and pushed. Check the current PR run, not an earlier run.

## Immediate next work

1. Collect the running real-E5 browser outcome before rerunning. Local execution session `44198`, log `/tmp/proprium-semantic-prefix-browser.log`, port 4185. It uses real signed E5 bytes with intercepted distribution URLs, not mocked inference. Fixture: `/tmp/proprium-authoring-1793267829756/registry`, public key `7M49OFwNEaFWpcMnhn49xCXXhU1sGSdwyUn/Q9mE+pg=`. The private test key remains outside the repository. Shell sessions may not survive a new environment; inspect the log and process before starting another server.
2. Integrate only Host commit `0d7fc34` from pushed branch `feat/authoring-host-completion` (worktree `/home/sophia/src/proprium-host-completion`). Its tree is clean; typecheck and focused tests 20/20 passed. It includes Research Review/Task controls, Diagnostics gutter/feedback wiring, BGE-specific admission capacity and bounded task profiles. Prior Research UI commits on that branch are already represented in the integration branch and must not be duplicated. Integration was held to avoid Vite hot-reloading the running real-E5 test. Shared Host files have one owner.
3. Integrate BGE checkpoint `c63651ce039a196af234adf1ee3fa22bc0e66b7c` from pushed branch `feat/semantic-bge-host` (clean worktree `/home/sophia/src/proprium-semantic-bge-host`). It adds signed group metadata/provenance, build composition, guest bindings and consent-gated prepare/score actions. Semantic tests 50+3, typecheck, offline cargo metadata and manual WIT guest componentization passed on the leaf. Full Rust/WASM and signed-registry build, Host source-evidence validation, explicit consent/gesture browser path and actual composed inference remain unverified. Standalone exact fp32 inference results do not certify this new Host path. E5 consent never grants BGE consent. Keep large weights out of Git.
4. Complete RES013 sliced source scanning/publication, rebuild all signed artifacts from one source revision, then run current desktop/mobile acceptance and CI. Research Review signed browser tests exist but need the Host mount and newly built Research/Knowledge packages.
5. Reassess feature rows after real integration evidence. Execute the full R01–R14 matrices; FROZEN R09 remains separate, and no earlier PASS may certify this checkpoint. Record remaining constraints/issues without hiding failures.

## Local reproducibility notes

The integration worktree is `/home/sophia/src/proprium-authoring`. Chromium executable: `/tmp/proprium-chromium-wrapper.sh`; Mobile WebKit executable: `/tmp/proprium-webkit-lifecycle`. The alternative WebKit wrapper failed EGL. Run Node normally; do not put its process under a global LD library wrapper.

Rust build environment: `PATH=/tmp/semantic-cargo/bin:$PATH`, `CARGO_HOME=/tmp/semantic-cargo`, `RUSTUP_HOME=/tmp/semantic-rustup`, `CARGO_TARGET_DIR=/tmp/semantic-model-cargo-target`, `NODE_USE_ENV_PROXY=1`. Coordinate concurrent cargo use and disk space. Test artifact model chunks were deduplicated with verified identical hard links; both fixture directories remain readable.

Validation and browser logs under `/tmp` are local continuation aids, not durable GitHub workflow artifacts. The signed registry is a test fixture, not a production release. Original `main` worktree remains separate.
