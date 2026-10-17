# Epic #7 final composed verification

The production runtime is frozen at `fc4eea880ef895decf6161bf4f45cc958e9700b3`, tree `7a56bd432597b7f31588af69f12a4e3a14243b46`. Subsequent integration commits change migration evidence, documentation and the ledger verifier only. Source remains read-only at `edc033c2c9466274a334299dadfa426661d957d9`. PR #8 is merged; its fixed P00–P13 plan remains the acceptance contract.

## Execution evidence

[Machine-readable P13 evidence](../migration/evidence/P13.json) records exact source heads, commands, log hashes, immutable image identities and scoped runtime equivalence. [P12 evidence](../migration/evidence/P12.json) records the composed author-data migration proof. [The migration ledger](../migration/ledger.json) maps 48 registrations, 166 handlers and 12 non-router groups to 96 implementation slices and their own evidence; the final ledger closure and independent review are recorded separately rather than inferred from this report.

On the frozen runtime tree, the real `pnpm verify` command completed frozen installation, workspace typechecking and tests, both production builds, Core dependency audit, Core browser acceptance (15 passed, 3 full-only skips), full browser acceptance (18 passed), Core OCI acceptance, provider-none MCP (2 passed, 1 real-provider-only skip), Diagnostics production reconstruction (1 passed), and P12 composed import/reconstruction (1 passed, 462244.406498 ms). Its final full OCI build failed with execution-host ENOSPC, exit 125. After capacity repair, that unchanged final stage was rerun and passed, exit 0. No assertion or application dependency changed. This evidence proves the required stages, not a zero exit from the original whole process.

The full retry verifies all eight included modules remain idle before use, health/readiness, HTML nonce and built assets, nonroot execution, writable data, and SIGTERM drain without automatic publication. The exact log SHA-256 values are:

| Artifact | SHA-256 |
| --- | --- |
| `scriptorium-root-final-fc4eea88-verify.log` | `a843b5e1695bce794761c7638a8d9b5be34976ed8ded33840eee21c95cbebb4e` |
| `scriptorium-root-final-fc4eea88-full-oci-retry.log` | `e0f03e6ee69c3ccb47896f3ba5374e76c63772a6b9f79eec1539a81c0365f2b2` |

Raw logs remain local under `/tmp`; they are not private project data or committed delivery artifacts. Their relevant results and checksums are preserved in the repository.

## Persistence and actual integration

Draft is recoverable browser state; Checkpoint is a local Git commit; Saved means confirmed GitHub publication. Checkpoint acknowledgement retains IndexedDB records. Operation IDs, edit generations, revision preconditions and remotely reachable operation metadata support bounded replay after response loss and workspace replacement. Actual fetch separates the canonical remote snapshot from unpushed overlays; unedited views follow changes while edits and conflicts retain author input. Default-branch editing, ordinary pushes and author approval remain the sole write path.

[Actual GitHub/browser/container recovery](P13-BROWSER-RECOVERY.md) exercises browser restart, complete container/data-volume deletion and recreation, operation replay with one remote commit, external update following, and same-file conflict preservation. Its Core image and the final Core image have identical application bytes, modes and symlinks except three pnpm metadata files whose differences are timestamps or mapping order. This is scoped application equivalence, not byte-identical OCI images.

P12 exercises real migration producers, both legacy SQLite locations, author overrides/corrections/dictionaries/settings, provisional records, approved publication and two complete Core-root replacements. It also proves exact-byte private recent-activity archives, explicit user/project mappings, preserved initial and newer live cursor timestamps, exclusion of unmapped private rows, idempotence and source immutability. Unsupported disabled-module data remains retained for reactivation.

[Actual CPU model lifecycle](P13-MODEL-OCI-LIFECYCLE.md) ran the full production image built from the exact same complete tree as frozen main. It executes Lindera, E5 and BGE, Speaker attribution, derived-index rebuild, simultaneous Diagnostics/Semantic inference through one shared E5 provider/child, disable/cancellation lease handling, final worker release and production-launcher replacement. Model identity and snapshot assertions accompany actual results. Author files survive these lifecycle changes.

The configured real local Qwen reference additionally passed three tests without skips through stdio MCP, SDK HTTP MCP and owner API/Core. It covers streaming cancellation and durable usage, continuation preview, author-selected rewrite as a separate proposal, approval/checkpoint/publication and reconstruction. Provider `none` remains usable. Recognized QA schema/JSON failures from the small model remain explicit; no model-quality claim or fabricated valid answer is made. [P11 evidence](../migration/evidence/P11.json) records the exact tested head and unchanged backend/runtime scope.

## Images and resource measurements

All images are local Linux/amd64 CPU builds. No image was published.

| Image | Manifest digest | Post-run Podman `.Size` bytes |
| --- | --- | ---: |
| Final Core | `sha256:8661aa25c6a0e2f3f6ef517f094d9edc03909c927ee9b2c749f88a8fc5d238d1` | 353929157 |
| Final full startup acceptance | `sha256:03cb0ddc2426ec7fe9e03cba814f33a1dc30e3185fbfc12a7f99bee04ce10834` | 778039748 |
| Exact-tree full real-model acceptance | `sha256:ac8aaf8f17843b91b3168c69e02bfdf9169deef8895c6ae5093cbb83c5edde48` | 1320442820 |

For the real-model image, the test-time `.Size` was 778039748 bytes while post-run inspection returned 1320442820 for the same ID/digest. Both observations are recorded; their cause is not established and no shrinkage is claimed.

| Startup observation | MVP baseline | Final Core | Final full |
| --- | ---: | ---: | ---: |
| Image bytes | 189360435 | 353929157 | 778039748 |
| Aggregate process RSS, KiB | 76468 | 85064 | 87240 |
| Cgroup memory, MB | 15.13 | 34.75 | 37.31 |
| Processes / PIDs field | 2 / 8 | 2 / 12 | 2 / 12 |

These are observed snapshots, not controlled causal benchmarks. The accepted migration intentionally restores React/Fastify and changes Alpine to Debian/glibc; the full closure additionally includes optional native/model engines. Core audits prove optional packages/models are absent. The plan specifies no arbitrary size target. RSS, cgroup memory and thread/PIDs counts are different measurements.

In the real-model run, shared Diagnostics/Semantic inference observed 1886.3 MiB aggregate RSS, 1911222272 cgroup bytes, one semantic child and 31.54 ms maximum measured event-loop delay. After disable, both compiled and semantic worker counts were zero, with 274.4 MiB aggregate RSS. Replacement E5/BGE execution observed 1999.8 MiB RSS and 25.77 ms maximum event-loop delay, then zero workers after release. Replacement HTTP health probes succeeded 100/100, p95 3.59 ms, maximum 251.2 ms. These observations prove process release; they do not claim every byte of page cache or host allocator memory returned to the startup baseline.

## Limits and final closure

The checks use synthetic/public fixtures and bounded local models. Private works, private evaluation corpora, deployment quotas, other architectures/accelerators and production deployment are not certified. CI/Actions, organization-template synchronization, Platform implementation and registry publication were deliberately not performed under the execution contract. They are not missing campaign gates.

The final acceptance decision additionally requires a closed source-aware ledger, resolved independent reviews, and confirmation that every integration commit is pushed. See [CAMPAIGN.json](../migration/CAMPAIGN.json) for that final state. This report alone does not substitute for those checks.
