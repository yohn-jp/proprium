#!/usr/bin/env bash
set -euo pipefail

# C62-only rootless Podman store. Keep graphroot, runroot, and temporary files
# separate from the host's default storage and from other OCI acceptance runs.
readonly store=/data/scriptorium-c64-oci
readonly graphroot="$store/storage"
readonly runroot="$store/runroot"
readonly tmpdir="$store/tmp"
readonly build_lock="$store/build.lock"

mkdir -p "$graphroot" "$runroot" "$tmpdir"
chmod 0700 "$store" "$graphroot" "$runroot" "$tmpdir"
export TMPDIR="$tmpdir"
export BUILDAH_LAYERS=false

run_podman() {
  nix shell nixpkgs#podman -c podman \
    --root "$graphroot" \
    --runroot "$runroot" \
    --tmpdir "$tmpdir" \
    --cgroup-manager=cgroupfs \
    "$@"
}

if [[ "${1:-}" == build ]]; then
  shift
  exec flock --exclusive "$build_lock" bash -c '
    set -euo pipefail
    nix shell nixpkgs#podman -c podman \
      --root /data/scriptorium-c64-oci/storage \
      --runroot /data/scriptorium-c64-oci/runroot \
      --tmpdir /data/scriptorium-c64-oci/tmp \
      --cgroup-manager=cgroupfs \
      build "$@"
  ' bash "$@"
fi

run_podman "$@"
