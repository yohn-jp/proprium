#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${OCI_ENGINE:-}" ]]; then
  engine="$OCI_ENGINE"
elif command -v docker >/dev/null 2>&1; then
  engine=docker
elif command -v podman >/dev/null 2>&1; then
  engine=podman
else
  echo "Install Docker or Podman, or set OCI_ENGINE to an installed engine." >&2
  exit 2
fi

command -v "$engine" >/dev/null 2>&1 || {
  echo "OCI engine is not available: $engine" >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is required for the HTTP startup check." >&2
  exit 2
}
command -v od >/dev/null 2>&1 || {
  echo "od is required to generate a temporary verification token." >&2
  exit 2
}

image="${SCRIPTORIUM_OCI_IMAGE:-scriptorium:verification}"
port="${SCRIPTORIUM_OCI_PORT:-3040}"
container="scriptorium-verify-$$"
verification_token="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  "$engine" rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$engine" build --pull --tag "$image" .
"$engine" run --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:3000" \
  --env "SCRIPTORIUM_AUTH_TOKEN=$verification_token" \
  --env SCRIPTORIUM_DATA_DIR=/data \
  "$image" >/dev/null

ready=0
for attempt in $(seq 1 40); do
  if curl --fail --silent "http://127.0.0.1:${port}/api/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then
  "$engine" logs "$container" >&2 || true
  echo "The OCI image did not become healthy at /api/health." >&2
  exit 1
fi

curl --fail --silent --show-error "http://127.0.0.1:${port}/" >/dev/null
uid="$("$engine" exec "$container" node -p 'process.getuid()')"
[[ "$uid" == 1000 ]] || {
  echo "Expected the application to run as UID 1000; got $uid." >&2
  exit 1
}
"$engine" exec "$container" node -e "require('node:fs').writeFileSync('/data/.oci-smoke', 'ok'); require('node:fs').unlinkSync('/data/.oci-smoke')"

echo "OCI startup checks passed: health API, static UI, nonroot UID, and writable /data."
"$engine" image inspect --format 'Image ID: {{.Id}} ({{.Os}}/{{.Architecture}})' "$image"
