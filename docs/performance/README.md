# Performance measurement

Use synthetic workloads and matched baseline/candidate inputs. Measure input and navigation latency, immutable Git reads, mutation, search/statistics, journal persistence, network activity, builds and startup separately. Improvements must retain revision validation, authentication, project isolation, strict browser recovery and the Core-only dependency boundary.

Run the [benchmark harness](../../scripts/performance/README.md) from the repository root:

```sh
pnpm install --frozen-lockfile
SCRIPTORIUM_PROFILE=core pnpm build
node --test scripts/performance/*.test.mjs
node scripts/performance/run.mjs /tmp/scriptorium-benchmark
node scripts/performance/summarize.mjs /tmp/scriptorium-benchmark/results
```

The output root must be new. Workers use generated fixtures, fresh processes and local synthetic bare remotes. Publish workloads write only to those remotes. Retain raw results outside the checkout or under ignored `artifacts/`; product documentation must not accumulate benchmark snapshots, execution logs or candidate progress tables.

Compare identical fixture contents, runtime profiles, browser flags, repetition counts, instrumentation and host constraints. Distinguish cold from warm reads, cache state and evolving mutation history. Keep sample counts with quantiles; a single observation is not a tail-latency estimate. Report resource and network observations separately from wall time.

A timeout or unavailable model/display leaves affected cases unmeasured. A synthetic composition event does not establish native OS IME performance, and a browser frame opportunity is not input-to-pixel latency. Do not add improvements from unrelated experiments into one aggregate percentage.

Specialized probes under `scripts/performance/` bind their runtime and artifact identities explicitly. Their immutable comparison inputs are in `evidence/performance/`; generated output is not a production input.

## Immutable baseline evidence

The retained `evidence/performance/wave0/INDEX.json` is the exact manifest for the published raw measurement archive. Check the archive before extraction and validate each compressed and raw member using the existing artifact verifier:

```sh
index=evidence/performance/wave0/INDEX.json
evidence=$(mktemp -d)
gh release download perf-wave0-2026-10-20 --repo yohn-jp/scriptorium \
  --pattern scriptorium-wave0-2026-10-20.tar --dir "$evidence"
node scripts/performance/artifacts.mjs verify-archive "$index" "$evidence"
tar -xf "$evidence/scriptorium-wave0-2026-10-20.tar" -C "$evidence"
node scripts/performance/artifacts.mjs verify "$index" "$evidence"
```

The manifest's digest is the immutable source of artifact identity; summary tables do not replace the raw archive. See [architectural optimization decisions](../architecture/decisions/OPTIMIZATION-BOUNDARIES.md) for the safety constraints that survive any individual measurement.
