# P13 full-profile OCI model lifecycle candidate

This record covers the full-profile model and worker lifecycle inside the OCI image. It is candidate evidence for the exact source and image below, not final P13 certification: the coordinator's main branch advanced beyond this isolated leaf, so the final composed tree still needs a fresh full-image run.

## Exact candidate

| Field | Value |
| --- | --- |
| Source commit and tree | e85c173a318e17eed084bbfb4dde2411a2abc2cf; tree 1e90e4dd15942cbbab76cc71787de2ce6369e6be |
| OCI engine | Rootless Podman 5.8.9 on NixOS x86_64 |
| Profile and platform | Full, linux/amd64 |
| Local image tag | localhost/scriptorium:p13-full-e85c173 |
| Image ID | af3c2fa2ed49be418e15f1dea5e3ffdc6afae079d5a1a8fb4b727a89f4eb7c62 |
| Local manifest digest | sha256:7a2e4fd5d00b36f90a19cfe90b30c6c0c5e01df4f922650696be813abd006b07 |
| Image bytes | 1,213,503,794 |
| Node base | Official Node 24 bookworm-slim, pinned in Dockerfile to sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 |

The image remained local. The temporary Podman policy used for the build rejected images by default and allowed only the pinned official Node repository and local container storage; the policy file was removed after verification.

## What ran

The acceptance test first runs the existing full-profile OCI verifier. That builds the Dockerfile image and exercises the production launcher, HTTP readiness and static assets, UID 1000, writable data, startup process/cgroup measurements, and SIGTERM drain.

It then runs the same image with networking disabled, a synthetic local Git repository mounted read-only, the model cache mounted read-only, and only a random test API token. The container starts the production API and the generated full-profile manifests/loaders with the real CoreStore, ModuleRuntime, and compiled module factories. NLP, Speaker, Diagnostics, and Semantic are exercised through authenticated production action routes. A test barrier holds an actual Diagnostics capability lease until ModuleRuntime cancellation; it does not replace the capability or model.

The pinned artifacts were read from the host cache at /tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models:

- Xenova/multilingual-e5-small at 761b726dd34fb83930e26aab4e9ac3899aa1fa78
- mogolloni/bge-reranker-v2-m3-onnx at e5023553f6c47f09057da7a19cdd79ef850a4985

The test ran with network access disabled and HF_HUB_OFFLINE enabled. It made no provider or LLM calls. After lifecycle checks, it started a replacement container with the production launch.mjs entry point and the same data/cache mounts, confirmed all eight full-profile modules were enabled-idle, checked the derived index survived replacement, and ran a real E5+BGE search.

## Results

The existing verifier passed the full-profile startup and SIGTERM drain. It measured 35.66 MB cgroup memory, 12 PIDs, two processes, and 85,924 KiB aggregate process RSS at startup.

The in-container sampler recorded the following representative peaks. RSS totals sum process RSS and can exceed cgroup memory because shared pages are counted in multiple processes; the cgroup figures are reported independently.

| Phase | Process and worker observation | Peak aggregate process RSS | Cgroup memory at peak | PIDs |
| --- | --- | ---: | ---: | ---: |
| Enabled-idle with selected modules disabled | No compiled worker; 2 processes | 102.1 MiB | 53,686,272 bytes | 12 |
| NLP action | One Lindera worker | 251.7 MiB | 163,176,448 bytes | 19 |
| Speaker attribution | Lindera and Speaker workers; two supervised children | 473.1 MiB | 348,868,608 bytes | 26 |
| Overlapping Diagnostics and Semantic leases | Both consumers received the same real capability instance; one Semantic child PID | 1,364.3 MiB; Semantic child 1,100 MiB | 1,325,998,080 bytes | 38 |
| Replacement production E5+BGE inference | One Semantic child PID; search returned five results with no rerank warning | 1,975.1 MiB; Semantic child 1,709.5 MiB | 1,857,511,424 bytes | 49 |

Disabling Diagnostics cancelled its blocked action while Semantic's real model job and child continued. The Semantic child exited after its last lease was released and the module was disabled. The test deleted the derived index, verified the missing state, rebuilt it with the real CPU model, then confirmed the index remained available in the replacement production-launcher container. NLP feature consent, Semantic settings, and author dismissals retained their original bytes.

During the replacement probe, the in-container health loop recorded 125 successful requests and no failures; p95 response latency was 3.78 ms and the maximum was 60.37 ms. The observed cgroup limits were memory.max=max, cpu.max=max 100000, and pids.max=2048. These are measurements of this local Podman host, not deployment quota claims.

## Reproduction

Build the workspace, then run the acceptance from the repository root with the pinned model cache available. For this NixOS host, use the temporary reject-default policy procedure in [OCI verification](OCI.md) while the test runs; it cleans up the policy on exit.

    pnpm build
    nix shell nixpkgs#podman -c node --test tests/integration/model-oci-lifecycle.acceptance.mjs

Set SCRIPTORIUM_P13_MODEL_CACHE if the read-only host model cache is stored elsewhere. The test creates and removes its synthetic repository, test containers, and temporary data on success.

## Scope

This run verifies model, worker, resource, and replacement behavior for the exact candidate source and image digest above. It does not certify later changes on main, the browser acceptance, the configured external-provider gate, or final P13 composition. Those checks require evidence from the final frozen source tree and image.
