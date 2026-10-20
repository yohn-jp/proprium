# C62 OCI acceptance preflight

Status: **Core and Full OCI builds, verifier acceptance, and dedicated C62 measurements PASS on source `8966fc329a7628d3cf6b4aac84e6b678afc2d157`.** See [ACCEPTANCE-20261021.md](ACCEPTANCE-20261021.md).

The worktree was created as branch `perf/c64-oci` from `b2eb1924eeae60511f84e1959e83851dbc2fd090`; the isolated `info` probe ran before the task-local acceptance files were committed. G0's runtime reference is `a1587e784788fa87d86c0eb7ab175d7a28a3209f`. At the worktree base, the runtime input paths (`Dockerfile`, `packages`, `app`, `api`, `server.ts`, `pnpm-lock.yaml`, `package.json`, `profiles`, and `scripts`) had no diff from that runtime reference. This leaf adds only task-local probe scripts and evidence. The Core and Full images were subsequently built sequentially from clean source SHA `8966fc329a7628d3cf6b4aac84e6b678afc2d157`; see the acceptance record.

The task-local engine wrapper uses the cached Podman 5.8.9 binary at `/nix/store/a4x9z75ghw7jrd7kv4c4rrv6dz0ayfsp-podman-5.8.9/bin/podman` with a fresh rootless store under `/data/scriptorium-c64-oci`: graphroot `/data/scriptorium-c64-oci/storage`, runroot `/data/scriptorium-c64-oci/runroot`, and transient files `/data/scriptorium-c64-oci/tmp`. It sets `TMPDIR` to that transient directory and uses cgroupfs for both profiles. The wrapper invokes this cached binary directly and does not resolve or download it through `nix shell` per command. `podman info` passed with rootless `true`, the overlay driver, and zero images, containers, or volumes in this isolated store. The host reported 110,767,632,384 bytes free on `/data` at preflight.

The existing policy at `/home/sophia/.config/containers/policy.json` remains unchanged, reject-by-default, and has SHA-256 `0ab20a9a08e3a9c7ae6593bc83f23806d4121ecf558ffef1f6d229650d0e1042`. No temporary policy was created. At the time of preflight, no image build, pull, or container run had occurred. The later authorized pinned Node base pull is recorded separately in [BASE-PULL.md](BASE-PULL.md).

`scripts/verify-oci.sh` remains the base acceptance check for profile metadata, health/readiness, all launcher/Desktop/Mobile assets, UID 1000, writable `/data`, image identity, and SIGTERM drain. The task-local `scripts/performance/podman` symlink is intentional: its basename makes the verifier select Podman's `--format oci` build and manifest-digest reporting branches while the target wrapper still enforces the isolated store. `scripts/performance/measure-oci-c62.mjs` adds the missing C62 evidence: Podman image `.Size` in bytes and ID/manifest digest; five start-to-`/api/ready` samples with nearest-rank p50/p95; a fixed 5-second warmup and 30-second idle window with per-second aggregate process RSS and cgroup CPU samples; writable `/data` and `/history`; and the same asset, UID, and graceful drain checks for every run. The in-container sampler is excluded from aggregate process RSS but included in cgroup CPU; CPU therefore covers the whole container cgroup, including sampler overhead, and is not an application-only measure. With five startup samples, nearest-rank p95 is the maximum observation and is reported with that limitation.

For the coordinated campaign, invoke `scripts/verify-oci.sh` separately for Core and Full on the same final clean source SHA and isolated Podman store, then invoke `measure-oci-c62.mjs` for those exact image references only after the separate quiet measurement grant. The build and acceptance commands are:

```bash
root="$(git rev-parse --show-toplevel)"
source_sha="$(git rev-parse HEAD)"
for profile in core full; do
  image="localhost/scriptorium:c64-oci-${profile}-${source_sha:0:8}"
  taskset -c 8-15 env \
    OCI_ENGINE="$root/scripts/performance/podman" \
    TMPDIR=/data/scriptorium-c64-oci/tmp \
    SCRIPTORIUM_PROFILE="$profile" \
    SCRIPTORIUM_OCI_IMAGE="$image" \
    bash scripts/verify-oci.sh
done
```

The C62 measurement command per profile is `node scripts/performance/measure-oci-c62.mjs "$profile" "$image" "$source_sha" "$output_json"`; run it only when the coordinator grants the quiet window and do not rebuild those images. The `scripts/performance/run-oci-c62.sh` loop remains a convenience path when verification and measurement may run back-to-back. Logs and raw JSON are stored only under `/data/scriptorium-c64-oci/evidence/<run-id>/` until the evidence is reviewed and copied into this result directory.

An earlier read-only `podman info` call against the host's default store emitted stale lock-refresh warnings for existing objects. That store was left in place and is excluded from all C62 commands; the passing preflight above is from the isolated store only.
