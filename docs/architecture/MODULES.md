# Trusted modules

The module runtime composes trusted built-in packages around public Core contracts. JavaScript imports and child processes are not security sandboxes for untrusted third-party code. External plugin isolation belongs to the [Plugin platform proposal](PLUGIN-PLATFORM.md).

## Feature ownership

| Module | Responsibility |
| --- | --- |
| Story | Narrative entities, hierarchy, bible, plots and related proposals |
| NLP | Tokenization, linguistic analysis and shared tokenizer capabilities |
| Diagnostics | Snapshot-bound narrative diagnostics and reviewable findings |
| Semantic | Embeddings, vector indexes, retrieval and reranking |
| Speaker | Speaker attribution, correction and statistical training |
| Assistant | Provider-backed context, prompt, streaming and proposal workflows |
| Publishing | Export, publication metadata and controlled reader sharing |
| MCP | Stdio and Streamable HTTP tool adapters using shared actions |
| Search | Lightweight lexical index, terminology registry and editor links |

Profiles select packages at build time. The Core profile excludes optional modules; Full includes the module composition. Hosted builds select a resolved module dependency closure from the producer catalog. Unknown modules, cycles, incompatible contracts and missing required capabilities fail resolution.

## Lifecycle

| State | Contract |
| --- | --- |
| Absent | Package, native dependencies, browser assets and weights are outside the profile closure |
| Disabled | No initialization, routes/actions, jobs, timers, workers or model load |
| Enabled-idle | Declared surfaces are available; heavy resources remain unallocated |
| Active | Bounded jobs/resources are allocated on demand and support cancellation and drain |

A manifest declares identity/version, contract compatibility, dependencies/capabilities, browser/server/worker entries, state schemas and resource metadata. Metadata resolution does not import module code. Enabling an absent module requires a compatible image; the runtime does not install packages.

A shared capability provider owns compatible model/tokenizer allocations. Consumers lease that provider instead of independently loading the same model. Releasing the last consumer drains the relevant process. Worker jobs carry snapshot and job identities, deadlines and bounded input/output. Workers return results or proposals; they have no independent Git write authority and do not inherit unnecessary credentials.

## Data and permission boundaries

Author corrections, settings, dictionaries, accepted small-model parameters and publication metadata use Core operations and Git-backed work metadata. Indexes, vectors, downloaded weights and generated diagnostics are derived caches. Disabling a module releases its resources without deleting author data. Re-enabling can rebuild derivatives from the selected snapshot.

Browser contributions use host-owned panels and permitted snapshot-scoped actions. Closing or switching a contribution aborts requests and disposes mounts. Route, UI and MCP availability derive from the same resolved capabilities; disabled features cannot retain hidden write endpoints.

Assistant SDKs and external transmission remain confined to the optional provider surface. Consent and host policy constrain transmission. Provider `none` keeps local editing, context preparation, MCP and review usable.

## Legacy import

`packages/migration` classifies legacy records as authoritative, provisional, secret, derived or relocated. Human corrections remain authoritative even if stored beside disposable vectors. Import produces a dry-run report and reviewable ChangeSet, preserves stable identities and formats, supports idempotent reruns, and leaves source files untouched.

Pending local commits and provisional browser work must remain recoverable. Secrets and private source data do not become public fixtures. Validate imports through approval, publication, clone replacement and optional-module reactivation; generic file compatibility alone does not prove semantic preservation.
