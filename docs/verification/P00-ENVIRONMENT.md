# P00 environment baseline

Recorded 2026-10-17 for `yohn-jp/scriptorium` before migration implementation. This is evidence for the existing Core image at commit `016a69cb924cbe1f9aed9af18f2f31143dff9676`; it is not final P13 acceptance.

## Checkout state

The shared checkout was `main` at `016a69cb924cbe1f9aed9af18f2f31143dff9676`, tracking `origin/main`, with no tracked or staged diff. It contained two untracked trees: `.codegraph/cache/` and `packages/contracts/` (`package.json`, `tsconfig.json`, and `src/index.ts`). The run used a clean worktree on `work/7-p13-env` at the same commit. The Dockerfile at this commit does not copy `packages/contracts/`; this run therefore measures the committed Core image and does not certify the untracked contract package.

## Host and OCI result

The host is NixOS x86_64 (`nixos-dev`), Linux `6.18.52`, with 16 online CPUs. No Docker executable was available. Rootless Podman `5.8.8` was provided ephemerally with `nix shell nixpkgs#podman`. `podman info` reported cgroups v2, the systemd cgroup manager, and host memory of `50,994,405,376` bytes.

Ran the repository's production-path smoke command, `bash scripts/verify-oci.sh`, from the clean worktree. It passed the OCI build, `/api/health`, all checked HTML/CSS/JavaScript MIME types, UID 1000, writable `/data`, and the production dependency audit (`yaml@2.9.1` only). The temporary containers policy followed [OCI.md](OCI.md): reject by default, allow the pinned `docker.io/library/node` image and local `containers-storage`; no policy existed before the run, and the temporary file was removed after it.

| Field | Baseline result |
| --- | --- |
| OCI engine | Rootless Podman 5.8.8 on NixOS x86_64 |
| Dockerfile Node base | `docker.io/library/node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f` |
| Image ID | `e53909181e4dd969929b04ff43b242ef7f4af9e6ace9efa7b4021e1c56aa1993` |
| Manifest digest and platform | `sha256:4827f46a989ce83c7abe58cd5e638ea7a062ba31585bd0ebdd7db9dad9888fb6`; `linux/amd64` |
| Image size | `189,360,435` bytes |
| Smoke checks | Passed: health, static assets/MIME, UID 1000, writable `/data` |
| Production dependency audit | Passed: `yaml@2.9.1` |

## Startup resource snapshot

Immediately after the verifier launched the container and before its health loop, `podman top` listed two processes: `tini` (RSS `540` KiB) and the API Node process (RSS `75,928` KiB), totaling `76,468` KiB (`~74.7` MiB). At the same instant, `podman stats` reported container memory `15.13 MB / 50.99 GB` and `8` in its PIDs field. These are raw readings from different interfaces; the cgroup memory value is not an RSS value, and the PIDs count differs from the two process rows reported by `podman top`.

The verifier starts the container without `--memory`, `--cpus`, or `--pids-limit`. The host shell did not expose `/sys/fs/cgroup/{memory.max,cpu.max,pids.max}`, so any outer host/container limits could not be inspected here. **Resource-limit baseline: BLOCKED.** The readings above are an unconstrained startup snapshot, not evidence of behavior under deployment limits. The browser baseline is being run by the coordinator and was not duplicated here.
