This is the upstream `ahash` 0.8.12 crate from crates.io with one build-only
change: the default feature set uses its explicit `no-rng` backend instead of
`runtime-rng`. The Semantic WASM component has no ambient random source and the
plugin ABI does not grant one. The tokenizer uses this hasher only for its
immutable, digest-pinned vocabulary tables; input sizes and model batches are
bounded by the plugin contract. No hashing or tokenization algorithm code was
changed.
