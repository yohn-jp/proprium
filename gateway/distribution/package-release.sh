#!/usr/bin/env bash
set -euo pipefail

# Package one verified Gateway and the matching official cloudflared release
# for each supported target. This runs on Linux and emits portable tar.gz files.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
: "${VERSION:?VERSION is required}"
: "${COMMIT:?COMMIT is required}"
: "${GATEWAY_BINARIES:?GATEWAY_BINARIES directory is required}"
: "${RELEASE_ASSETS:?RELEASE_ASSETS directory is required}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]

# shellcheck source=gateway/distribution/cloudflared.lock
source "$script_dir/cloudflared.lock"
command -v go >/dev/null 2>&1 || { echo 'Go toolchain is required.' >&2; exit 1; }
go_output="$(go version)"
go_tool_version="${go_output#go version }"
go_tool_version="${go_tool_version%% *}"
if [[ "$go_tool_version" != "go$go_version" ]]; then
  echo "Go toolchain mismatch: expected go$go_version, got $go_tool_version" >&2
  exit 1
fi
go_license_section_sha="$(sed -n "/^----- BEGIN Go runtime\/LICENSE /,/^----- END Go runtime\/LICENSE -----/p" "$script_dir/THIRD-PARTY-LICENSES.txt" | sed '1d;$d' | sha256sum | cut -d' ' -f1)"
go_patents_section_sha="$(sed -n "/^----- BEGIN Go runtime\/PATENTS /,/^----- END Go runtime\/PATENTS -----/p" "$script_dir/THIRD-PARTY-LICENSES.txt" | sed '1d;$d' | sha256sum | cut -d' ' -f1)"
test "$go_license_section_sha" = "$go_license_sha256"
test "$go_patents_section_sha" = "$go_patents_sha256"
mkdir -p "$RELEASE_ASSETS"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch_https() {
  curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 300 \
    --retry 2 --retry-all-errors --retry-max-time 120 \
    "$@"
}

gateway_license="$repo_root/LICENSE"
cloudflared_license="$work/LICENSE-CLOUDFLARED.txt"
fetch_https \
  "https://raw.githubusercontent.com/cloudflare/cloudflared/${version}/LICENSE" \
  -o "$cloudflared_license"
grep -F 'Apache License' "$cloudflared_license" >/dev/null
test "$(sha256sum "$cloudflared_license" | cut -d' ' -f1)" = "$license_sha256"
test "$(sha256sum "$script_dir/THIRD-PARTY-LICENSES.txt" | cut -d' ' -f1)" = "$third_party_licenses_sha256"

targets=(linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64)
for target in "${targets[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  key="${os}_${arch}"
  expected="${!key}"
  upstream_name="cloudflared-${os}-${arch}"
  if [[ "$os" == windows ]]; then upstream_name+=".exe"; fi
  if [[ "$os" == darwin ]]; then upstream_name+=".tgz"; fi
  upstream="https://github.com/cloudflare/cloudflared/releases/download/${version}/${upstream_name}"
  target_dir="$work/$os-$arch"
  mkdir -p "$target_dir"

  gateway_name=gateway
  cf_name=cloudflared
  suffix=""
  if [[ "$os" == windows ]]; then
    suffix=.exe
    gateway_name+="$suffix"
    cf_name+="$suffix"
  fi
  gateway_asset="${GATEWAY_BINARIES}/proprium-gateway_${VERSION}_${os}_${arch}${suffix}"
  test -s "$gateway_asset"
  cp "$gateway_asset" "$target_dir/$gateway_name"
  fetch_https "$upstream" -o "$work/$upstream_name"
  actual="$(sha256sum "$work/$upstream_name" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "cloudflared checksum mismatch for $target: expected $expected, got $actual" >&2
    exit 1
  fi
  if [[ "$os" == darwin ]]; then
    tar -xzf "$work/$upstream_name" -C "$target_dir" cloudflared
  else
    cp "$work/$upstream_name" "$target_dir/$cf_name"
  fi
  chmod 0755 "$target_dir/$gateway_name" "$target_dir/$cf_name"
  cp "$gateway_license" "$target_dir/LICENSE-GATEWAY.txt"
  cp "$cloudflared_license" "$target_dir/LICENSE-CLOUDFLARED.txt"
  cp "$script_dir/THIRD-PARTY-LICENSES.txt" "$target_dir/THIRD-PARTY-LICENSES.txt"
  cp "$script_dir/NOTICE-CLOUDFLARED.txt" "$target_dir/NOTICE-CLOUDFLARED.txt"

  gateway_sha="$(sha256sum "$target_dir/$gateway_name" | cut -d' ' -f1)"
  cf_sha="$(sha256sum "$target_dir/$cf_name" | cut -d' ' -f1)"
  {
    echo "schema=proprium-gateway-bundle-v1"
    echo "version=$VERSION"
    echo "commit=$COMMIT"
    echo "os=$os"
    echo "arch=$arch"
    echo "gateway_sha256=$gateway_sha"
    echo "cloudflared_version=$version"
    echo "cloudflared_sha256=$cf_sha"
    echo "go_version=$go_version"
    echo "go_license_sha256=$go_license_sha256"
    echo "go_patents_sha256=$go_patents_sha256"
    echo "third_party_licenses_sha256=$third_party_licenses_sha256"
  } > "$target_dir/manifest"
  {
    echo "schema=proprium-gateway-source-v1"
    echo "version=$VERSION"
    echo "commit=$COMMIT"
    echo "gateway_source=https://github.com/yohn-jp/proprium/tree/$COMMIT/gateway"
    echo "cloudflared_version=$version"
    echo "cloudflared_source=https://github.com/cloudflare/cloudflared/tree/$version"
    echo "cloudflared_asset=$upstream_name"
    echo "cloudflared_upstream_sha256=$expected"
    echo "go_version=$go_version"
    echo "go_commit=$go_commit"
    echo "go_source=https://github.com/golang/go/tree/go$go_version"
    echo "go_license_sha256=$go_license_sha256"
    echo "go_patents_sha256=$go_patents_sha256"
    echo "third_party_licenses_sha256=$third_party_licenses_sha256"
  } > "$target_dir/SOURCE.txt"

  if [[ "$os" == linux ]]; then
    cli="$script_dir/proprium"
    test -s "$cli"
    cp "$cli" "$target_dir/proprium"
    chmod 0755 "$target_dir/proprium"
    cli_sha="$(sha256sum "$target_dir/proprium" | cut -d' ' -f1)"
    sed -i "/^cloudflared_sha256=/a proprium_sha256=$cli_sha" "$target_dir/manifest"
    echo "proprium_source=https://github.com/yohn-jp/proprium/tree/$COMMIT/gateway/distribution/proprium" >> "$target_dir/SOURCE.txt"
  fi

  archive="$RELEASE_ASSETS/proprium-gateway_${VERSION}_${os}_${arch}.tar.gz"
  (cd "$target_dir" && tar -czf "$archive" -- *)
done

cp "$script_dir/proprium" "$RELEASE_ASSETS/proprium"
cp "$script_dir/bootstrap.sh" "$RELEASE_ASSETS/bootstrap.sh"
chmod 0755 "$RELEASE_ASSETS/proprium" "$RELEASE_ASSETS/bootstrap.sh"
{
  echo "schema=proprium-gateway-source-v1"
  echo "tag=proprium-gateway-v$VERSION"
  echo "version=$VERSION"
  echo "commit=$COMMIT"
  echo "go=$go_tool_version"
  echo "go_version=$go_version"
  echo "go_commit=$go_commit"
  echo "go_license_sha256=$go_license_sha256"
  echo "go_patents_sha256=$go_patents_sha256"
  echo "cloudflared_version=$version"
  echo "third_party_licenses_sha256=$third_party_licenses_sha256"
} > "$RELEASE_ASSETS/SOURCE.txt"
(cd "$RELEASE_ASSETS" && sha256sum proprium-gateway_*.tar.gz proprium bootstrap.sh > SHA256SUMS)
