#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bootstrap="$script_dir/bootstrap.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mock_bin="$work/mock-bin"
fixtures="$work/fixtures"
mkdir -p "$mock_bin" "$fixtures"

cat > "$mock_bin/uname" <<'MOCK_UNAME'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Linux\n' ;;
  -m) printf '%s\n' "${BOOTSTRAP_TEST_ARCH:-x86_64}" ;;
  *) exec /usr/bin/uname "$@" ;;
esac
MOCK_UNAME
chmod 0755 "$mock_bin/uname"

cat > "$mock_bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail
out=''
url=''
https_only=false
redirect_https=false
bounded=false
while (($#)); do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --proto) [[ "$2" == '=https' ]] && https_only=true; shift 2 ;;
    --proto-redir) [[ "$2" == '=https' ]] && redirect_https=true; shift 2 ;;
    --max-time) [[ "$2" =~ ^[0-9]+$ ]] && bounded=true; shift 2 ;;
    --connect-timeout|--retry|--retry-max-time) shift 2 ;;
    --fail|--silent|--show-error|--location|--tlsv1.2|--retry-all-errors) shift ;;
    *)
      if [[ "$1" == https://* ]]; then url=$1; fi
      shift
      ;;
  esac
done
[[ -n "$out" && -n "$url" && "$https_only" == true && "$redirect_https" == true && "$bounded" == true ]] || {
  echo 'curl invocation did not enforce HTTPS and finite timeouts' >&2
  exit 91
}
case "$url" in
  https://api.github.com/repos/yohn-jp/proprium/releases/latest)
    cp "$BOOTSTRAP_FIXTURES/release.json" "$out"
    ;;
  https://github.com/yohn-jp/proprium/releases/download/proprium-gateway-v1.2.3/proprium)
    cp "$BOOTSTRAP_FIXTURES/proprium" "$out"
    ;;
  https://github.com/yohn-jp/proprium/releases/download/proprium-gateway-v1.2.3/SHA256SUMS)
    cp "$BOOTSTRAP_FIXTURES/SHA256SUMS" "$out"
    ;;
  *) echo "unexpected URL: $url" >&2; exit 92 ;;
esac
MOCK_CURL
chmod 0755 "$mock_bin/curl"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_failure() {
  local label=$1 bin_dir=$2
  shift 2
  if PATH="$mock_bin:$PATH" BOOTSTRAP_FIXTURES="$fixtures" "$bootstrap" --bin-dir "$bin_dir" "$@" >"$work/stdout" 2>"$work/stderr"; then
    fail "$label unexpectedly succeeded"
  fi
}

build_release() {
  local cli_sha sums_sha cli_url sums_url
  cli_sha="$(sha256sum "$fixtures/proprium" | cut -d' ' -f1)"
  printf '%s  proprium\n' "$cli_sha" > "$fixtures/SHA256SUMS"
  sums_sha="$(sha256sum "$fixtures/SHA256SUMS" | cut -d' ' -f1)"
  cli_url='https://github.com/yohn-jp/proprium/releases/download/proprium-gateway-v1.2.3/proprium'
  sums_url='https://github.com/yohn-jp/proprium/releases/download/proprium-gateway-v1.2.3/SHA256SUMS'
  jq -n --arg cli "sha256:$cli_sha" --arg sums "sha256:$sums_sha" \
    --arg cli_url "$cli_url" --arg sums_url "$sums_url" \
    '{tag_name:"proprium-gateway-v1.2.3", assets:[
      {name:"proprium",digest:$cli,browser_download_url:$cli_url},
      {name:"SHA256SUMS",digest:$sums,browser_download_url:$sums_url}
    ]}' > "$fixtures/release.json"
}

printf 'verified-cli-fixture\n' > "$fixtures/proprium"
build_release

success_dir="$work/bin with spaces"
PATH="$mock_bin:$PATH" BOOTSTRAP_FIXTURES="$fixtures" "$bootstrap" --bin-dir "$success_dir" > "$work/stdout"
cmp "$fixtures/proprium" "$success_dir/proprium" || fail 'installed CLI bytes differ from the verified asset'
[[ "$(stat -c '%a' "$success_dir/proprium")" == 755 ]] || fail 'installed CLI mode is not 0755'
grep -F "Run: $success_dir/proprium install" "$work/stdout" >/dev/null || fail 'installer did not print the absolute CLI invocation'

arm64_dir="$work/arm64-bin"
PATH="$mock_bin:$PATH" BOOTSTRAP_FIXTURES="$fixtures" BOOTSTRAP_TEST_ARCH=aarch64 "$bootstrap" --bin-dir "$arm64_dir" > "$work/arm64-stdout"
cmp "$fixtures/proprium" "$arm64_dir/proprium" || fail 'ARM64 install did not preserve the verified CLI bytes'
arm64_alias_dir="$work/arm64-alias-bin"
PATH="$mock_bin:$PATH" BOOTSTRAP_FIXTURES="$fixtures" BOOTSTRAP_TEST_ARCH=arm64 "$bootstrap" --bin-dir "$arm64_alias_dir" > "$work/arm64-alias-stdout"
cmp "$fixtures/proprium" "$arm64_alias_dir/proprium" || fail 'arm64 uname alias did not preserve the verified CLI bytes'

# A bad API digest must fail before replacing an existing regular CLI.
printf 'old-cli\n' > "$success_dir/proprium"
jq '.assets |= map(if .name == "proprium" then .digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000" else . end)' \
  "$fixtures/release.json" > "$fixtures/bad-digest.json"
cp "$fixtures/bad-digest.json" "$fixtures/release.json"
expect_failure 'bad API digest' "$success_dir"
grep -Fx 'old-cli' "$success_dir/proprium" >/dev/null || fail 'failed verification changed the existing CLI'

# An authenticated checksum file that names the wrong CLI digest is rejected.
build_release
printf '%064d  proprium\n' 0 > "$fixtures/SHA256SUMS"
sums_sha="$(sha256sum "$fixtures/SHA256SUMS" | cut -d' ' -f1)"
jq --arg digest "sha256:$sums_sha" '.assets |= map(if .name == "SHA256SUMS" then .digest = $digest else . end)' \
  "$fixtures/release.json" > "$work/release-wrong-sum.json"
cp "$work/release-wrong-sum.json" "$fixtures/release.json"
expect_failure 'checksum mismatch' "$success_dir"

# Symlinked path components are rejected before any network request.
build_release
mkdir -p "$work/real-bin"
ln -s "$work/real-bin" "$work/link-bin"
expect_failure 'symlinked installation directory' "$work/link-bin"

echo 'bootstrap tests passed'
