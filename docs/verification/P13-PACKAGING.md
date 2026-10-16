# Early P13 OCI packaging verification

Status: partial packaging evidence only. Recorded 2026-10-17 against `yohn-jp/scriptorium` commit `3e84dbce383dd767273582a341ea355172901548`. This run verifies the current default Core image; it does not certify the full profile or final P13 acceptance.

## Build and startup

The Dockerfile at this commit uses the pinned official Node 24 Bookworm slim image and includes the contracts workspace in the build and runtime stages. The build output showed `@scriptorium/contracts` built before Core, and the production image copied `packages/contracts/package.json` and `packages/contracts/dist`. A supplemental import from Core's package context inside the built image resolved `@scriptorium/contracts` and returned `CONTRACT_VERSION=1`.

Ran the existing `bash scripts/verify-oci.sh` against this worktree with rootless Podman `5.8.8` from `nix shell nixpkgs#podman`. The temporary signature policy used by the run rejected by default and allowed only the pinned `docker.io/library/node` repository and local `containers-storage`; it was removed on exit. The OCI build passed. The production dependency audit scanned one package version, `yaml@2.9.1`. Startup checks passed for `/api/health`, the HTML/CSS/JavaScript MIME types, UID 1000, and writable `/data`.

| Field | Result at `3e84dbce` |
| --- | --- |
| Base image | `docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` |
| Image ID | `26a061469ad80d2571896a3f2f52d4fd5fc118df0e07a6a7abceedcb403893f2` |
| Manifest digest and platform | `sha256:770e68a75676bd62bccace580b8dc97ee8e812875aecc2ff3760bd0119d81fc9`; `linux/amd64` |
| Image size | `342,014,332` bytes |
| Runtime dependency audit | Passed: `yaml@2.9.1` |
| Contracts runtime package | Present under `packages/contracts`; import from Core's package context returned v1 |
| Startup smoke | Passed: health, static asset MIME types, UID 1000, writable `/data` |

## Comparison with the P00 image

The [P00 baseline](P00-ENVIRONMENT.md) used commit `016a69cb` and the pinned Node 24 Alpine image. The new image is `152,653,897` bytes larger (`80.6%`). This change includes the planned Alpine-to-Bookworm-slim base switch, Debian runtime packages, and the contracts package; no image-size target is set.

An immediate startup snapshot reported two processes in `podman top`: `tini` RSS `1,220` KiB and Node RSS `72,020` KiB, totaling `73,240` KiB (`~71.5` MiB). At the same instant, `podman stats` reported `18.54 MB / 50.99 GB` and `8` in its PIDs field. P00 recorded `76,468` KiB process RSS and `15.13 MB / 50.99 GB` from `podman stats`, also with `8` in the PIDs field. The cgroup memory and process RSS readings are different measures; these are single startup observations, not a controlled load benchmark.

## Remaining P13 evidence

This verifies one default Core image. It does not verify a full-profile image, optional model workers, browser/GitHub acceptance, container replacement and recovery, or shutdown behavior. The host is the NixOS x86_64 Podman host described in [P00](P00-ENVIRONMENT.md); the verifier sets no container resource quotas. Deployment-specific quota behavior was not checked, and this is not an acceptance blocker because the accepted plan specifies measurements without a deployment quota contract. No image was published.
