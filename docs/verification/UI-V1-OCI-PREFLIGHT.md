# UI Modernization V1 OCI preflight

Status: **preflight recorded; candidate OCI acceptance NOT_CHECKED**. The integrated UI candidate SHA is pending. This record does not reuse earlier image results as evidence for the UI goal.

## Documented execution path

The repository's [OCI verification guide](OCI.md) names `bash scripts/verify-oci.sh` as the local build and startup probe. It accepts `OCI_ENGINE`, `SCRIPTORIUM_OCI_IMAGE`, and `SCRIPTORIUM_OCI_PORT`. The guide documents rootless Podman supplied by Nix on this host, with a reject-by-default signature policy allowing the pinned official Node image and local `containers-storage`. [P13 packaging evidence](P13-PACKAGING.md) also records `node scripts/profile-package.mjs --profile core|full --out <directory>` for standalone profile packaging. It does not certify a UI V1 image.

`OCI-RELEASE.md` describes a tag-triggered GitHub Actions release that publishes Core and Full images to GHCR. It is a release path, not local acceptance evidence; this preflight does not invoke it or publish an image.

## Host observations

These read-only probes ran on 2026-10-18 from `/data/scriptorium-ui-modules` at `feat/ui-v1-modules`, HEAD `929d42acd40d9f2e8f4c00521c00b7aa03573808`:

| Probe | Result |
| --- | --- |
| System `docker`, `podman`, `buildah`, `buildctl`, `nerdctl` | Not on `PATH` |
| Nix | `/run/current-system/sw/bin/nix`, version `2.34.8` |
| Documented engine command | `nix shell nixpkgs#podman -c podman --version` returned Podman `5.8.9` |
| Rootless capability | `nix shell nixpkgs#podman -c podman info --format '{{.Host.Security.Rootless}}'` returned `true` |
| Existing wrapper | `/tmp/scriptorium-oci-no-intermediate/podman`; works inside the Nix shell and returned `podman version 5.8.9` |
| Wrapper behavior | Sets `BUILDAH_LAYERS=false` and serializes `build` through `/tmp/scriptorium-oci-no-intermediate/build.lock` |
| Prepared `/data` wrapper | `/data/scriptorium-ui-oci-tools/podman`; runs the same Nix Podman and redirects graph root and Podman temp files to `/data` |
| Prepared wrapper probe | `podman info` returned graph root `/data/scriptorium-ui-oci-storage`, temp `/data/scriptorium-ui-oci-tmp`, rootless `true`, driver `overlay`; no image build was run |
| Existing signature policy | `/home/sophia/.config/containers/policy.json` is present and matches the documented reject-default policy for the pinned Node image and local storage. It was read and left untouched. |
| Rootless graph root | `/home/sophia/.local/share/containers/storage` |
| Available space | `/home/sophia` and `/tmp` share `/` with only `3.5M` free; `/data` has `183G` free |
| Earlier model cache | `/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models` is absent; that cache is unnecessary for the UI V1 Core/Full and no-addon/Story/MCP packaging gates |

The pre-existing wrapper fails when run outside the Nix shell because `podman` is not on the system `PATH`. Use it only under the documented Nix command. Historical local image tags exist, but none identify the integrated UI candidate and none count as acceptance evidence.

## Execution readiness

The rootless engine is available, so there is no missing-engine blocker. The documented default graph root and `/tmp` are on a full filesystem; a build using those defaults is blocked by `ENOSPC`. The prepared `/data` wrapper routes Podman storage and temporary files away from that filesystem, and its `info` probe confirmed rootless overlay storage. Host-side verifier temp files must also use the `/data` `TMPDIR`. The wrapper has not built or run an image. Do not reuse this preflight as proof for any profile.

The repo's local base command is:

```sh
nix shell nixpkgs#podman -c env \
  TMPDIR=/data/scriptorium-ui-oci-tmp \
  OCI_ENGINE=/data/scriptorium-ui-oci-tools/podman \
  SCRIPTORIUM_OCI_IMAGE=localhost/scriptorium:ui-v1-core \
  bash scripts/verify-oci.sh
```

The current signature-policy file already exists, so do not run the OCI guide's temporary-policy creation recipe over it. Preserve it and recheck its contents before a build. Candidate-specific Core, Full, and selected Hosted profile image commands remain **NOT_CHECKED** until the integrated packaging interface and tested SHA are supplied by the build coordinator.
