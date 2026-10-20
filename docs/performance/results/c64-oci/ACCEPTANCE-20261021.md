# C62 Core/Full image build and verifier acceptance

Execution date: 2026-10-21 JST. Both profiles were built and checked sequentially
from the same clean production source revision, with Podman isolated under
`/data/scriptorium-c64-oci`. The verifier ran on CPUs 8–15 while the browser
acceptance lane was active. Its one-shot startup memory/process readings below
are concurrent acceptance observations, not C62 timing or performance claims.

## Source and execution

- Source commit: `8966fc329a7628d3cf6b4aac84e6b678afc2d157`
- Git tree: `9a28184bffa5e4bc005ea860f011eae6c5680ed9`
- Worktree was clean before builds and remains separate from production edits.
- Podman: cached `/nix/store/a4x9z75ghw7jrd7kv4c4rrv6dz0ayfsp-podman-5.8.9/bin/podman`, version 5.8.9.
- Runtime base: Node 24 Bookworm slim, manifest `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`; local image ID `a797d6440ed0b09e51fb884f30e47ec14cbf58482c5e19db681a0cb8df45b089`.
- Existing reject-by-default policy SHA-256: `0ab20a9a08e3a9c7ae6593bc83f23806d4121ecf558ffef1f6d229650d0e1042` before and after; no trust configuration changed.
- The normal runtime target used the pinned Node base. The Golang frontend-build stage was not selected. Podman’s verifier command specifies `--pull`, so the pinned Node manifest was resolved again during builds.

Production-input SHA-256 values at the built source revision:

| File | SHA-256 |
| --- | --- |
| `Dockerfile` | `005b540188d5337e103bb4e5aba17c0ae4be3439c17d02b170a6b3d9a28ce350` |
| `package.json` | `8b752415eee663c3a77d4970fff93457e770b6502029080d3c5c343d9da921ba` |
| `pnpm-lock.yaml` | `107821c3fdeb50571c891e7de500c0b477bc01206c1f4caa63d830fd8be7e768` |
| `packages/api/src/server.ts` | `47c833cdee1098bd2474c1aba8791c64c2b9d67a775788c3138270ced7a01cd5` |
| `app/src/main.tsx` | `3dd00869bd69d426e724a7a473d9ed7117a85ea4960bd2a9190a8072f36d3e60` |
| `scripts/profile-package.mjs` | `c868c79160fd3db4c6b09bf6ef882103ce770abbd1b5beea770d276668df18f0` |
| `scripts/verify-oci.sh` | `12ab2ec2b9e07dc28666c2c7451e7f5998953c7e91de0c90a3b3802279be215c` |
| `scripts/verify-oci-http.mjs` | `460c0594c4dfbb939811025ef00bfa3db476b396ff8c3ed8164cbf41c8239a1a` |
| `profiles/core.json` | `bab340001666f4e4cddba56ae6dc15bd9c852322fe9b15722bc256ea34bc175e` |
| `profiles/full.json` | `13febc61556d7ff2aef6ea01afdb60cc4228d8dddf458c897fe4871693c5f2fd` |

The complete source-file hash manifest is at
`/data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/source-file-hashes.txt`
(SHA-256 `1c31812f36ab56d2e2b071d9039434fac8489902946be448263199fba4a90844`).
The production-input manifest is
`/data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/production-file-hashes.txt`
(SHA-256 `c688738e521ae49e27b27a67df94a7926412bcbb07687bb733d4060ff8f410b2`).

## Results

| Profile | Exit | Image ID | Manifest digest | Podman `.Size` bytes | Checks |
| --- | ---: | --- | --- | ---: | --- |
| Core | 0 | `a3115cdc87269113715d9d2d4c5dc4c5b3bc2b3a164be62725cfd6efbfb833e2` | `sha256:682000eb93c65eaa4b7e7a53c3d2f32061ff7c1e929c22fd8f60988bfd003e3f` | 361,074,628 | 0 included modules idle; 13 built assets; launcher/Desktop/Mobile HTML nonces; health/readiness; UID 1000; writable `/data`; SIGTERM drain |
| Full | 0 | `417672e6fd287485d3102bc15e73b7b7947e8f332a1c9e1970249e40c2bf45e4` | `sha256:33da30887e22490e92ee18e841eb3559a95cdcf2e68f9ce267890d4a2d31d2c8` | 781,675,459 | 9 included modules idle; 37 built assets; launcher/Desktop/Mobile HTML nonces; health/readiness; UID 1000; writable `/data`; SIGTERM drain |

Each image inspect reported `linux/amd64` and image config user `node`; the verifier
confirmed effective UID 1000. The verifier confirms `/data` writes; `/history`
writes are still pending the dedicated C62 measurement helper and quiet-window
grant.

Post-acceptance isolated-store inventory contained only the pinned Node base and
the two tagged Core/Full images; there were no remaining containers or volumes.

Concurrent one-shot verifier snapshots: Core reported cgroup memory 42.19 MB,
12 PIDs, and 91,680 KiB aggregate process RSS with its sampler excluded. Full
reported 41.21 MB, 12 PIDs, and 90,644 KiB aggregate process RSS with its sampler
excluded. These snapshots ran alongside the browser lane and do not establish
an idle baseline or an app-only CPU figure.

## Commands and raw logs

Core command:

```bash
taskset -c 8-15 env \
  OCI_ENGINE=/home/sophia/src/scriptorium-c64-oci/scripts/performance/podman \
  TMPDIR=/data/scriptorium-c64-oci/tmp \
  SCRIPTORIUM_PROFILE=core \
  SCRIPTORIUM_OCI_IMAGE=localhost/scriptorium:c64-oci-core-8966fc32 \
  bash scripts/verify-oci.sh 2>&1 | tee /data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/core-verify.log
```

Full used the same command and log redirection with profile `full` and image
`localhost/scriptorium:c64-oci-full-8966fc32`. Both commands exited 0. Their full
logs remain under
`/data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/`:

- `core-verify.log`: 28,454 bytes, SHA-256 `f72849b6deaa94cc291ae3595adc9270d7a164f9000fb5bbe171d59a613fac4a`.
- `full-verify.log`: 31,240 bytes, SHA-256 `e11e309c7ed23f2d02ca19178ed41e5ce65792337a0a154ca975d25a9a151afd`.

## Dedicated C62 measurements

The dedicated measurement phase ran after the quiet-window grant on CPUs 8–15,
sequentially for Core then Full. Each of the five startup samples used a fresh
container with the already-built image reference. Image and operating-system
caches were not flushed, and the measurement helper did not pull or rebuild
images; these are warm-image, fresh-container startup measurements, not
cold-boot or cold-pull latency. The coordinator reported no overlapping
artifact workload; external host load is unknown.

The start interval runs from the `podman run --detach` invocation through the
first successful `/api/ready` response. Percentiles use nearest rank; at n=5,
p95 is the maximum observation. Only the fifth run includes the 5-second idle
warmup followed by a fixed 30-second idle window with 31 RSS samples and 30
one-second cgroup CPU intervals.

| Profile | Start samples (ms) | p50 (ms) | p95 (ms) | Idle actual | RSS p50 / p95 / max (KiB) | Cgroup CPU mean / max (% of one core) | Assertions |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Core | 762.506, 750.756, 713.695, 830.576, 743.110 | 750.756 | 830.576 | 30.043 s | 90,668 / 90,668 / 90,668 | 0.0743 / 0.2178 | all pass |
| Full | 516.483, 494.400, 480.262, 513.829, 473.242 | 494.400 | 516.483 | 30.048 s | 91,260 / 91,264 / 91,264 | 0.0696 / 0.1919 | all pass |

Both profiles passed asset/metadata verification, effective UID 1000, writable
`/data` and `/history`, and graceful SIGTERM drain. The idle RSS process walk
excludes the sampler process itself. CPU comes from the whole container cgroup
and includes the in-container sampling helper and any other work in that cgroup;
it is not an application-only CPU measure. Core and Full are different module
profiles, not a controlled before/after comparison, so their values do not
establish a causal gain.

Verdict: **VERIFIED_EXISTING**. The existing runtime image and Dockerfile pass
Core and Full acceptance. No image-stripping Dockerfile change was evaluated or
justified by this campaign; retain the existing Dockerfile.

Exact measurement commands, each with exit status 0:

```bash
taskset -c 8-15 node scripts/performance/measure-oci-c62.mjs core \
  localhost/scriptorium:c64-oci-core-8966fc32 \
  8966fc329a7628d3cf6b4aac84e6b678afc2d157 \
  /data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/core-measure.json \
  2>&1 | tee /data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/core-measure.log

taskset -c 8-15 node scripts/performance/measure-oci-c62.mjs full \
  localhost/scriptorium:c64-oci-full-8966fc32 \
  8966fc329a7628d3cf6b4aac84e6b678afc2d157 \
  /data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/full-measure.json \
  2>&1 | tee /data/scriptorium-c64-oci/evidence/final-8966fc329a7628d3cf6b4aac84e6b678afc2d157/full-measure.log
```

Selected raw evidence (all files remain in the evidence directory above):

- `core-measure.json`: 15,362 bytes, SHA-256 `667291fd38cf9b6ee110d5305ef978edca920e73fc4441f789de155c67f7b2c2`.
- `core-measure.log`: 6,254 bytes, SHA-256 `08343a2de89aad1b93e64e6b13f734ab68d0c2d252f3cd9b27d2e080afddd81d`.
- `full-measure.json`: 15,366 bytes, SHA-256 `5f56d4fc85d7e63da7efc4c4db106163f0f150a4cdd6e1538c70ab94216dfecb`.
- `full-measure.log`: 6,255 bytes, SHA-256 `849c189fcb1499d21f37233d891b624ba46cd4238d18cc9caf54a461286ac76c`.
- `core-measure-status.txt` and `full-measure-status.txt` both contain `0`.

The verifier and measurement scripts removed their own temporary containers;
post-run isolated inventory had no containers or volumes. The cached Node base
and the exact Core and Full images remain available in the isolated store.
