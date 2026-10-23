# P13 frozen-runtime OCI model lifecycle evidence

Status: **PASS for the focused full-profile model/worker OCI acceptance.** This is evidence for the P13 model lifecycle gate only. It does not certify the other P13 gates or the composed Epic #7 result.

## Exact source and image

| Field | Result |
| --- | --- |
| Test source commit and tree | `95711fb4b00df7cf20ee24aaa3a00fbe909194e5`; `7a56bd432597b7f31588af69f12a4e3a14243b46` |
| Frozen main head | `fc4eea880ef895decf6161bf4f45cc958e9700b3` |
| Runtime-input comparison | Source tree matches frozen main exactly; runtime-input diff is empty |
| OCI engine | Rootless Podman 5.8.9 on NixOS x86_64, provided by Nix |
| Profile and platform | Full, `linux/amd64` |
| Local image tag | `localhost/scriptorium:p13-full-95711fb` |
| Image ID | `4333fbe0b2bf2f41cda5bfc78402f5eeb67f32e3b9aa3a5924ff69a9b898402e` |
| Local manifest digest | `sha256:ac8aaf8f17843b91b3168c69e02bfdf9169deef8895c6ae5093cbb83c5edde48` |
| `.Size` in test candidate JSON | `778,039,748` bytes, Podman image-inspect `.Size` |
| Fresh `.Size` after campaign-owned stale-image cleanup | `1,320,442,820` bytes, direct Podman image inspect at `2026-10-17T01:41:50.407818326Z` |

The two `.Size` readings identify the same image ID, digest and platform. They disagree; both measurements are retained without inferring a cause or claiming an image-size reduction. The image remained local and was not published. Startup verification passed the full-profile HTTP probes, nonroot UID and writable `/data` checks, and SIGTERM-driven API drain. Startup measurements were 45.23 MB cgroup memory, 12 PIDs, two processes and `87,156 KiB` aggregate process RSS (measurement helper excluded).

## Model and worker checks

The test exercised the production CoreStore, ModuleRuntime, compiled modules, API actions, full-profile launcher and OCI image. It used a disposable synthetic Git repository, random temporary API token, network-disabled model containers, `HF_HUB_OFFLINE=1`, and a read-only bind of the existing host model cache. No weights were added to the image or worktree, and no external LLM/provider calls were made.

The pinned public artifacts in `/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models` were:

- E5: `Xenova/multilingual-e5-small`, revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`.
- BGE reranker: `mogolloni/bge-reranker-v2-m3-onnx`, revision `e5023553f6c47f09057da7a19cdd79ef850a4985`.

The actual `nlp.countTokens` API reported the pinned E5 tokenizer, exact mode, and Transformers.js `3.8.1`, with counts `8, 6, 11` for the synthetic strings. An unsupported tokenizer request reported the explicit `approx` counter (`source-approx-v1`, reason `tokenizer_unavailable`) and counts `2, 2, 0`. The production Lindera API returned nine tokens; speaker attribution selected synthetic character `char-hero` using `scriptorium-speaker-cpu` and Lindera.

Diagnostics and Semantic each completed real nearest-neighbor inference with the same E5 model revision and 384 dimensions on one shared Semantic child PID (`14788`). Diagnostics returned 24 synthetic-corpus hits and Semantic returned 30, with five Semantic results and no fallback warning. The cancellation check requested Diagnostics disable while the Semantic rebuild job was active, observed the rebuild settle after that request on the same pending child, and confirmed the remaining Semantic consumer stayed usable. Releasing the last lease stopped the child. The test then deleted the derived index and rebuilt it using the actual CPU model.

The production-launcher replacement container started all eight modules enabled-idle without a worker, found the persisted derived index, and completed a real E5+BGE search with five results and no rerank warning. The lifecycle test verified the module settings and author dismissals byte-for-byte after completion.

## Resource observations

The table reports the sampler's aggregate process-RSS peak for each lifecycle phase and the cgroup values captured in that sample. Aggregate RSS sums process RSS and can exceed cgroup memory because shared pages are counted more than once. Worker maxima are observed separately within each phase.

| Phase | Peak aggregate RSS | Cgroup memory at sample | PIDs | Worker observation |
| --- | ---: | ---: | ---: | --- |
| Full profile, disabled and enabled-idle baseline | 101.5 MiB | 53,428,224 bytes | 12 | No workers |
| Actual NLP tokenizer | 243.1 MiB | 160,780,288 bytes | 19 | One NLP child |
| Actual E5 token counter | 492.3 MiB | 407,977,984 bytes | 23 | One NLP child |
| Speaker attribution and Lindera | 503.7 MiB | 395,247,616 bytes | 26 | NLP and Speaker children |
| Diagnostics/Semantic lease cancellation | 1,412.4 MiB | 1,433,948,160 bytes | 38 | One Semantic child |
| Shared Diagnostics/Semantic real inference | 1,886.3 MiB | 1,911,222,272 bytes | 45 | One Semantic child; two compiled workers sampled |
| Delete and rebuild derived index | 1,383.2 MiB | 1,437,556,736 bytes | 38 | One Semantic child |
| After disable, before replacement | 274.4 MiB | 337,469,440 bytes | 12 | No workers |
| Re-enabled E5+BGE search | 1,999.8 MiB | 2,093,592,576 bytes | 38 | One Semantic child |
| After replacement action release | 274.0 MiB | 442,023,936 bytes | 12 | No workers |

In the replacement container, the separate E5+BGE inference sample measured `2,027.6 MiB` aggregate process RSS, `1,931,055,104` cgroup bytes and 49 PIDs; its Semantic child reached `1,763.7 MiB` RSS. The lifecycle health loop recorded 847 successful requests and no failures (p95 `25.68 ms`, maximum `44.97 ms`). Replacement recorded 100 successful requests and no failures (p95 `3.59 ms`, maximum `251.2 ms`). The observed limits were `memory.max=max`, `cpu.max=max 100000` and `pids.max=2048`; these are local host measurements, not deployment quota claims.

## Reproduction and captured output

With the pinned cache available and the temporary reject-default Podman policy procedure in [OCI verification](OCI.md) in effect, the acceptance command was:

```sh
nix shell nixpkgs#podman -c env \
  OCI_ENGINE=/tmp/scriptorium-oci-no-intermediate/podman \
  SCRIPTORIUM_P13_IMAGE=localhost/scriptorium:p13-full-95711fb \
  SCRIPTORIUM_P13_MODEL_CACHE=/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models \
  SCRIPTORIUM_P13_KEEP_FAILED=1 \
  node --test tests/integration/model-oci-lifecycle.acceptance.mjs
```

The outside-repository engine wrapper serialized image builds and set `BUILDAH_LAYERS=false`; it forwarded the verifier and test's actual Podman commands without skipping checks. The acceptance passed `1/1`, with zero failures, in `158,877.3 ms`. During the broader parallel campaign, a separate Core `pnpm verify` OCI build attempt hit `ENOSPC` at a pnpm layer. That separate failure is not counted as a model-gate result; the model acceptance above completed against the frozen source after bounded cleanup of only campaign-owned stale images.

The full raw output is `/tmp/scriptorium-p13-final-full-oci-95711fb.log` (70,151 bytes, SHA-256 `3c25e81121513bc31f61bd181811b7233b4c6e5cb5098f51718e3c4288bd08fe`). The exact candidate JSON is `/tmp/scriptorium-p13-final-full-oci-95711fb-candidate.json` (SHA-256 `a7c075d134fca408333b112f1ba9fad6bdf281dd4387d840f1474394a42e6339`). These host-local artifacts preserve detailed phase samples and assertions; this committed record contains the reviewed acceptance summary.

This focused result does not claim completion of browser recovery, P12 migration, configured external-provider acceptance, or whole-repository verification.
