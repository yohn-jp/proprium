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

Dedicated C62 n=5 start-to-ready samples, nearest-rank p50/p95, fixed 30-second
idle RSS/cgroup-CPU sampling, and `/data` plus `/history` write checks have not
run. Run `measure-oci-c62.mjs` against these exact image references only after
the separate quiet-window grant; do not rebuild them for that measurement. Its
cgroup CPU counter includes the in-container sampler and other work in the
container cgroup, so it must not be described as app-only CPU.
