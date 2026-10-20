#!/usr/bin/env bash
set -euo pipefail

# C62-only rootless Podman store. Keep graphroot, runroot, and temporary files
# separate from the host's default storage and from other OCI acceptance runs.
readonly store=/data/scriptorium-c64-oci
readonly graphroot="$store/storage"
readonly runroot="$store/runroot"
readonly tmpdir="$store/tmp"
readonly build_lock="$store/build.lock"
readonly podman_bin=/nix/store/a4x9z75ghw7jrd7kv4c4rrv6dz0ayfsp-podman-5.8.9/bin/podman

if [[ ! -x "$podman_bin" ]]; then
  echo "The cached C62 Podman 5.8.9 binary is unavailable: $podman_bin" >&2
  exit 2
fi

mkdir -p "$graphroot" "$runroot" "$tmpdir"
chmod 0700 "$store" "$graphroot" "$runroot" "$tmpdir"
export TMPDIR="$tmpdir"
export BUILDAH_LAYERS=false

run_podman() {
  "$podman_bin" \
    --root "$graphroot" \
    --runroot "$runroot" \
    --tmpdir "$tmpdir" \
    --cgroup-manager=cgroupfs \
    "$@"
}

if [[ "${1:-}" == build ]]; then
  shift
  exec flock --exclusive "$build_lock" "$podman_bin" \
    --root "$graphroot" \
    --runroot "$runroot" \
    --tmpdir "$tmpdir" \
    --cgroup-manager=cgroupfs \
    build "$@"
fi

run_podman "$@"
