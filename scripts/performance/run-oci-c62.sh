#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Run C62 only from a clean, committed source tree." >&2
  exit 2
fi

source_sha="$(git rev-parse HEAD)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
evidence_root="/data/scriptorium-c64-oci/evidence/$run_id"
mkdir -p "$evidence_root"

for profile in core full; do
  image="localhost/scriptorium:c64-oci-${profile}-${source_sha:0:8}"
  log="$evidence_root/${profile}-verify.log"
  result="$evidence_root/${profile}.json"
  measure_log="$evidence_root/${profile}-measure.log"

  env \
    OCI_ENGINE="$root/scripts/performance/podman" \
    TMPDIR=/data/scriptorium-c64-oci/tmp \
    SCRIPTORIUM_PROFILE="$profile" \
    SCRIPTORIUM_OCI_IMAGE="$image" \
    bash scripts/verify-oci.sh 2>&1 | tee "$log"

  node scripts/performance/measure-oci-c62.mjs "$profile" "$image" "$source_sha" "$result" \
    2>&1 | tee "$measure_log"
done

printf 'C62 run ID: %s\nSource SHA: %s\nEvidence: %s\n' "$run_id" "$source_sha" "$evidence_root"
