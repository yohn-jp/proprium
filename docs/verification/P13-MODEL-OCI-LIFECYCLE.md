# P13 frozen-runtime OCI model lifecycle evidence

Status: **PASS for the focused full-profile model/worker OCI acceptance.** This is evidence for the P13 model lifecycle gate only. It does not certify the other P13 gates or the composed Epic #7 result.

## Exact source and image

| Field | Result |
| --- | --- |
| Test source commit and tree | `8804edc9afb17fcd66b605ebfb70589007519dfa`; `45809bd25cfb888a1f3aa15531458adfc0d74f0f` |
| Compared frozen main head | `539375c925754c6ec6f5c445051a32b7293a0724` |
| Difference from frozen main | Only `tests/integration/model-oci-lifecycle.container.mjs`; no production or Docker build inputs changed |
| OCI engine | Rootless Podman 5.8.9 on NixOS x86_64 |
| Profile and platform | Full, `linux/amd64` |
| Local image tag | `localhost/scriptorium:p13-full-8804edc` |
| Image ID | `f5def569f7fa98e0c71807730afb999c42c057a86c71557f812b41eae3755172` |
| Local manifest digest | `sha256:510d8398fcee71015bcd3be2489ff69fd7976bb4c06d0e852c47579c81e427bf` |
| `Podman image inspect .Size` reported in the test result | `778,036,163` bytes, read after the startup verifier and before the lifecycle containers |
| Fresh `.Size` after the test | `1,320,435,651` bytes; direct Podman inspection between `2026-10-17T01:27:29.962980417Z` and `2026-10-17T01:27:30.018965728Z` |

The later direct and wrapper inspections returned the same image ID, manifest digest, platform, and `.Size`. The two `.Size` observations disagree for that same ID and digest. Both observations are retained here; no cause is inferred and no image-size reduction is claimed. The image remained local and was not published.

The verifier passed full-profile startup, HTTP probes, nonroot UID and writable `/data` checks, and SIGTERM-driven API drain. At startup it measured 37.99 MB cgroup memory, 12 PIDs, two processes, and `87,676 KiB` aggregate process RSS (measurement helper excluded).

## Model and worker checks

The test ran the production CoreStore, ModuleRuntime, compiled modules, API actions, full-profile launcher and OCI image. It used a disposable synthetic Git repository, random temporary API token, network-disabled model containers, `HF_HUB_OFFLINE=1`, and a read-only bind of the existing host cache. No model weights were added to the image or worktree, and no LLM/provider calls were made.

The pinned artifacts in `/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models` were:

- E5: `Xenova/multilingual-e5-small`, revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`.
- BGE reranker: `mogolloni/bge-reranker-v2-m3-onnx`, revision `e5023553f6c47f09057da7a19cdd79ef850a4985`.

Actual `nlp.countTokens` reported the pinned E5 tokenizer, Transformers.js `3.8.1`, and exact counts `8, 6, 11` for the three synthetic strings. An unavailable requested tokenizer returned the explicit `approx` counter (`source-approx-v1`, reason `tokenizer_unavailable`) with counts `2, 2, 0`. The production Lindera API returned nine tokens; speaker attribution selected synthetic character `char-hero` using `scriptorium-speaker-cpu` and Lindera.

Diagnostics and Semantic both completed real nearest-neighbor calls with the same pinned E5 model revision and 384 dimensions, on one Semantic child PID during the overlapping lease. Diagnostics returned 24 synthetic-corpus hits and Semantic returned 30; Semantic returned five results without a fallback warning. The cancellation phase requested Diagnostics disable while the Semantic rebuild job was active, observed that rebuild settle afterward on the same pending child, and confirmed disabling one consumer preserved the other. The final lease release stopped the child. The test then deleted the derived index, observed it missing, rebuilt it with the real CPU model, and observed recovery.

The production-launcher replacement container started all eight modules enabled-idle with no worker. It saw the persisted derived index and completed a real E5+BGE search with five results and no rerank warning. The test settings and author dismissals were verified byte-for-byte after the lifecycle run.

## Resource observations

The table reports the sampler's aggregate process-RSS peak for each lifecycle phase and the cgroup values captured in that same sample. Aggregate RSS sums process RSS and can exceed cgroup memory because shared pages are counted more than once. Worker maxima are observed separately within the phase.

| Phase | Peak aggregate RSS | Cgroup memory at that sample | PIDs | Worker observation |
| --- | ---: | ---: | ---: | --- |
| Full profile, disabled and enabled-idle baseline | 100.6 MiB | 53,141,504 bytes | 12 | No workers |
| Actual NLP tokenizer | 259.8 MiB | 173,916,160 bytes | 19 | One NLP child |
| Actual E5 token counter | 493.4 MiB | 409,075,712 bytes | 23 | One NLP child |
| Speaker attribution and Lindera | 523.9 MiB | 402,395,136 bytes | 26 | NLP and Speaker children |
| Diagnostics/Semantic lease cancellation | 1,433.9 MiB | 1,400,410,112 bytes | 38 | One Semantic child; up to two compiled workers sampled |
| Shared Diagnostics/Semantic real inference | 1,885.8 MiB | 1,824,194,560 bytes | 45 | One shared Semantic child; up to two workers sampled |
| Delete and rebuild derived index | 1,417.8 MiB | 1,383,206,912 bytes | 38 | One Semantic child |
| After disable, before replacement | 272.9 MiB | 253,341,696 bytes | 12 | No workers |
| Re-enabled E5+BGE search | 2,034.6 MiB | 2,068,406,272 bytes | 38 | One Semantic child |
| After replacement action release | 272.7 MiB | 353,435,648 bytes | 12 | No workers |

The replacement container's separate sampler measured its production E5+BGE inference at `2,087.4 MiB` aggregate process RSS, `2,002,239,488` cgroup bytes, and 49 PIDs; its Semantic child reached `1,823.1 MiB` RSS. Across the lifecycle container, the health loop recorded 773 successful requests and no failures (p95 `26.72 ms`, maximum `53.23 ms`). Across replacement, it recorded 101 successful requests and no failures (p95 `3.69 ms`, maximum `108.37 ms`). The observed limits were `memory.max=max`, `cpu.max=max 100000`, and `pids.max=2048`; these are local host measurements, not deployment quota claims.

## Reproduction and captured output

From the repository root, with the pinned cache available and the temporary reject-default Podman policy procedure in [OCI verification](OCI.md) in effect:

```sh
pnpm install --frozen-lockfile
pnpm build
nix shell nixpkgs#podman -c env \
  OCI_ENGINE=/tmp/scriptorium-oci-no-intermediate/podman \
  SCRIPTORIUM_P13_IMAGE=localhost/scriptorium:p13-full-8804edc \
  SCRIPTORIUM_P13_MODEL_CACHE=/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models \
  SCRIPTORIUM_P13_KEEP_FAILED=1 \
  node --test tests/integration/model-oci-lifecycle.acceptance.mjs
```

For this run, the outside-repository engine wrapper serialized image builds and set `BUILDAH_LAYERS=false`; it forwarded the verifier and test's actual Podman commands without skipping checks. The acceptance passed `1/1`, with zero failures, in `159,242.4 ms`.

The full raw output was captured at `/tmp/scriptorium-p13-final-full-oci-8804edc.log` (70,380 bytes, SHA-256 `1310b6e6f37ddc5bd63762a15038bb1fa248d2e0e1f0648521ca002eb0eb4692`). Its exact candidate JSON is `/tmp/scriptorium-p13-final-full-oci-8804edc-candidate.json` (SHA-256 `1ffd3049c67728f28674ea1d10efa4913a852491e416abf821e85e43d3c48452`). These host-local artifacts preserve the detailed phase samples and assertions; the committed record above contains the reviewed acceptance summary.

This focused result does not claim completion of the browser recovery, P12 migration, configured external-provider, or whole-repository verification gates.
