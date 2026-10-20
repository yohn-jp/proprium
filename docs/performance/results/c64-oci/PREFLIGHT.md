# C62 OCI acceptance preflight

Status: **preflight ready; Core/Full image acceptance NOT_CHECKED while G0 holds the build/OCI lease**.

Preflight source branch is `perf/c64-oci` at `b2eb1924eeae60511f84e1959e83851dbc2fd090`. G0's runtime reference is `a1587e784788fa87d86c0eb7ab175d7a28a3209f`; the production input paths used for C62 (`Dockerfile`, `packages`, `app`, `api`, `server.ts`, `pnpm-lock.yaml`, `package.json`, `profiles`, and `scripts`) have no diff between those commits. The eventual Core and Full images will be built sequentially from one clean, committed source SHA.

The task-local engine wrapper uses Podman 5.8.9 with a fresh rootless store under `/data/scriptorium-c64-oci`: graphroot `/data/scriptorium-c64-oci/storage`, runroot `/data/scriptorium-c64-oci/runroot`, and transient files `/data/scriptorium-c64-oci/tmp`. It sets `TMPDIR` to that transient directory and uses cgroupfs for both profiles. `podman info` passed with rootless `true`, the overlay driver, and zero images, containers, or volumes in this isolated store. The host reported 110,767,632,384 bytes free on `/data` at preflight.

The existing policy at `/home/sophia/.config/containers/policy.json` remains unchanged, reject-by-default, and has SHA-256 `0ab20a9a08e3a9c7ae6593bc83f23806d4121ecf558ffef1f6d229650d0e1042`. No temporary policy was created. No image build, pull, or container run has occurred in this preflight.

`scripts/verify-oci.sh` remains the base acceptance check for profile metadata, health/readiness, all launcher/Desktop/Mobile assets, UID 1000, writable `/data`, image identity, and SIGTERM drain. `scripts/performance/measure-oci-c62.mjs` adds the missing C62 evidence: Podman image `.Size` in bytes and ID/manifest digest; five start-to-`/api/ready` samples with nearest-rank p50/p95; a fixed 5-second warmup and 30-second idle window with per-second aggregate process RSS and cgroup CPU samples; writable `/data` and `/history`; and the same asset, UID, and graceful drain checks for every run. The in-container sampler is excluded from aggregate process RSS but included in cgroup CPU. With five startup samples, nearest-rank p95 is the maximum observation and is reported with that limitation.

After G0 releases the resource lease, run the committed `scripts/performance/run-oci-c62.sh` from a clean tree. It invokes the existing verifier and then the task-local measurements once for Core and once for Full, using the same source SHA and the isolated Podman store. Logs and raw JSON are stored only under `/data/scriptorium-c64-oci/evidence/<run-id>/` until the evidence is reviewed and copied into this result directory.

An earlier read-only `podman info` call against the host's default store emitted stale lock-refresh warnings for existing objects. That store was left in place and is excluded from all C62 commands; the passing preflight above is from the isolated store only.
