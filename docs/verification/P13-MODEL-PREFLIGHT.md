# P13 model runtime preflight

Recorded 2026-10-17. This is an environment and artifact preflight for the source configurations used by P06, P09, and P10. It does not certify those future modules or their output semantics. NLP analysis, semantic retrieval/reranking, speaker attribution/corrections/training, model lifecycle, and module acceptance remain NOT_CHECKED.

## Identity and scope

- Read-only source: Arcadia Loom commit `edc033c2c9466274a334299dadfa426661d957d9`, verified clean at the start of this preflight.
- Documentation worktree: `work/7-p13-model-preflight`, based on Scriptorium commit `ce6ad5b11dedaf0a9663d6a9d0d262b44bbb7d8a`.
- Runtime tests used a disposable `git archive` copy of the exact source commit at `/tmp/scriptorium-model-runtime-edc033c`; source and target manifests were not changed.
- Inputs were synthetic Japanese sentences only. No external LLM/provider calls were made. Model files were fetched to a temporary HOME cache and were not added to this repository.

## Host and locked runtime

The test host was NixOS x86_64, Linux 6.18.52, glibc 2.42, Node v24.21.0, and pnpm v11.16.0. It had 16 online CPUs; `free -h` reported 47 GiB total and 41 GiB available during this preflight. These are host measurements, not a container resource limit.

| Dependency | Source range | Locked version | Lock integrity / native note |
| --- | --- | --- | --- |
| `@huggingface/transformers` | `^3.7.2` | `3.8.1` | Apache-2.0; lock integrity `sha512-tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA==` |
| Transformers.js `onnxruntime-node` | exact transitive resolution | `1.21.0` | MIT; bundled Linux x64 CPU runtime; lock integrity `sha512-NeaCX6WW2L8cRCSqy3bInlo5ojjQqu2fD3D+9W5qb5irwxhEyWKXeH2vZ8W9r6VxaMPUan+4/7NDwZMtouZxEw==` |
| Core-declared `onnxruntime-node` | `^1.27.0` | `1.27.0` | MIT; bundled Linux x64 CPU runtime; lock integrity `sha512-QEzGwrvNBgv4uPVdnbHsOGG4G6T96mdlcFI8aAKPjMU8wOPpVocPXb6k3QGkaZagVTv2G9Bnnbo6Z3JdXr1fQw==` |
| `lindera-wasm-nodejs-ipadic` | `2.0.0` | `2.0.0` | MIT; lock integrity `sha512-ocuJn9MUA7v5wuXRSADgzLu2Hn2//GmAYHARXSkTbMOCk3bv4Rh1L39XjjJ05286HL0YWfpPo67XrxLMJ/zIhQ==`; package ships WASM and embedded IPADIC |

The source workspace sets `allowBuilds.onnxruntime-node: false`. A frozen install still succeeded: the npm packages included their Linux CPU binding/runtime files, so this setting did not block CPU inference here. No GPU provider, Rust compiler, or dictionary build was required for these checks.

There is a co-load hazard in the locked dependency graph. Importing `onnxruntime-node@1.27.0` alone succeeded. Importing Transformers.js first, then directly importing Core's `onnxruntime-node@1.27.0`, failed with `ERR_DLOPEN_FAILED`: the v1.27 N-API binding required `VERS_1.27.0`, while the dynamic loader had already loaded `libonnxruntime.so.1` from Transformers.js's v1.21 dependency. The inspected source has no direct production import of `onnxruntime-node`; its embedding and reranker paths use Transformers.js. Keep a single runtime binding in a process if a later module adds direct ONNX Runtime use. This is a coexistence warning, not a reason to override the source lock during this preflight.

## Configured models, artifacts, and licenses

### Tokenizer and speaker

The tokenizer defaults to Lindera WASM with the embedded IPADIC dictionary. The installed npm package identifies as MIT and includes a MIT license file; its tarball has no separate dictionary license notice. The package is `lindera-wasm-nodejs-ipadic@2.0.0`.

The speaker reranker is not a separate ML runtime. Source `speakerReranker.ts` implements a 23-feature weighted logistic model in TypeScript, reads an optional project-local `meta/speaker-model.json`, and trains it with in-process SGD. It has no separate model ID or third-party weights. Speaker workflows also call the Lindera tokenizer. No project corpus or saved speaker model was used here.

### Embedding

Source defaults to `Xenova/multilingual-e5-small`, 384 dimensions, and adds the required `passage: ` prefix before inference. Transformers.js selected fp32 on CPU because the source does not pass a dtype. The current public Hugging Face revision was `761b726dd34fb83930e26aab4e9ac3899aa1fa78`.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `onnx/model.onnx` | 470,268,533 bytes | `4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff` |
| `tokenizer.json` | 17,082,730 bytes | `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39` |

The Xenova ONNX conversion page does not state a license in its model metadata. Its base model, `intfloat/multilingual-e5-small`, declares MIT. This records provenance; it does not substitute for confirming rights to redistribute the converted artifact.

### Cross-encoder reranker

Source defaults to `mogolloni/bge-reranker-v2-m3-onnx`. Its model page and base model `BAAI/bge-reranker-v2-m3` declare Apache-2.0. Transformers.js resolved the current public revision to `e5023553f6c47f09057da7a19cdd79ef850a4985`; its `config.json` declares fp32.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `onnx/model.onnx` | 489,245 bytes | `ed283424d9a40dbd6fe2f3081386848a88cc8057b7ab43e02d84077d6b69ba42` |
| `onnx/model.onnx_data` | 2,271,088,656 bytes | `9a748c82efb2079d24650c489e053dbb3c71d8acbbcf04d7b2340db66f2748f7` |
| `tokenizer.json` | 17,082,900 bytes | `8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3` |

The configured default dtype is `q8`, which makes Transformers.js request `onnx/model_quantized.onnx`; that file is absent at the inspected model revision. The normal source call therefore fails before inference with “Could not locate file …/onnx/model_quantized.onnx”. With a temporary `ARCADIA_RERANKER_DTYPE=fp32` override, the loader finds the graph but its first attempt fails because source does not request the external data file. Transformers.js 3.8.1 supports `use_external_data_format: true` in `AutoModelForSequenceClassification.from_pretrained`; the current model config does not enable it.

After placing the verified `model.onnx_data` artifact in the temporary model cache and setting only the dtype override to fp32, the exact source `getDefaultReranker({ forceBackend: "onnx" })` and `reranker.rerank` path completed on CPU. For query `夜の駅の情景`, the synthetic passages `夜遅く駅に着いた。` and `昼の海で泳いだ。` received finite scores `0.9466788` and `0.0000163`. The Node process reported RSS of 1,636,085,760 bytes after the two-document inference. This is one engine smoke, not semantic-search or model-quality acceptance.

The preserving-model implementation direction for the P09 owner is to use fp32 for this declared artifact and request its external data through the supported Transformers.js option. Do not substitute a different model as part of this preflight. Recheck the exact repository revision and output path when implementing P09.

## Runtime command and results

The disposable workspace was produced from the exact source tree, then installed and built:

~~~sh
runtime_dir="$(mktemp -d /tmp/scriptorium-model-runtime.XXXXXX)"
git -C /tmp/scriptorium-source-7 archive edc033c2c9466274a334299dadfa426661d957d9 | tar -x -C "$runtime_dir"
cd "$runtime_dir"
pnpm install --frozen-lockfile
pnpm --filter @yohn-jp/arcadia-loom-core... run build
~~~

The install completed on the lockfile with 1,090 packages; schema, workspace, core-shared, and core TypeScript builds all passed. Against that built source:

- Lindera's exact source adapter tokenized `彼女は静かな駅で小説を書いた。` into 11 tokens; UTF-16 offsets covered the original 15 code units.
- `createOnnxEmbedder` downloaded the default model and returned one finite 384-dimension embedding for the same synthetic sentence.
- The configured q8 reranker failed on the missing `model_quantized.onnx`. The fp32 source path succeeded only after temporary external-data cache seeding. No inference was made from the hashing embedding or stub reranker.
- A two-example synthetic feature-vector call through `trainSpeakerRerankModel` returned finite weights. This does not test speaker attribution, correction, holdout, adoption, or reload behavior.

Hugging Face model IDs in source resolve the mutable `main` revision unless the caller pins a revision. The revisions and hashes above identify the artifacts observed during this preflight; they do not make the source configuration immutable.

## References

- [Transformers.js 3.8.1](https://www.npmjs.com/package/@huggingface/transformers) and its [from_pretrained external-data option](https://huggingface.co/docs/transformers.js/api/models)
- [Xenova multilingual-e5-small artifacts](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78/onnx) and [MIT base model](https://huggingface.co/intfloat/multilingual-e5-small)
- [Configured bge reranker artifacts](https://huggingface.co/mogolloni/bge-reranker-v2-m3-onnx/tree/e5023553f6c47f09057da7a19cdd79ef850a4985) and [BAAI base model/license](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- [Lindera WASM IPADIC npm package](https://www.npmjs.com/package/lindera-wasm-nodejs-ipadic) and [Lindera WASM license](https://github.com/lindera/lindera/blob/main/lindera-wasm/LICENSE)
- [P13 plan](../migration/FULL-MIGRATION-PLAN.md) and [Core environment baseline](P00-ENVIRONMENT.md)
