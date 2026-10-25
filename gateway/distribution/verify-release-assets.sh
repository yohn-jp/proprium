#!/usr/bin/env bash
set -euo pipefail

assets="${1:?usage: verify-release-assets.sh ASSET_DIR VERSION COMMIT}"
gateway_version="${2:?version is required}"
commit="${3:?commit is required}"
[[ "$gateway_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
assets="$(cd -- "$assets" && pwd)"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gateway/distribution/cloudflared.lock
source "$script_dir/cloudflared.lock"
cloudflared_version="$version"
go_license_section_sha="$(sed -n "/^----- BEGIN Go runtime\/LICENSE /,/^----- END Go runtime\/LICENSE -----/p" "$script_dir/THIRD-PARTY-LICENSES.txt" | sed '1d;$d' | sha256sum | cut -d' ' -f1)"
go_patents_section_sha="$(sed -n "/^----- BEGIN Go runtime\/PATENTS /,/^----- END Go runtime\/PATENTS -----/p" "$script_dir/THIRD-PARTY-LICENSES.txt" | sed '1d;$d' | sha256sum | cut -d' ' -f1)"
test "$go_license_section_sha" = "$go_license_sha256"
test "$go_patents_section_sha" = "$go_patents_sha256"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$assets" && sha256sum --check SHA256SUMS)
grep -Fx "tag=proprium-gateway-v$gateway_version" "$assets/SOURCE.txt" >/dev/null
grep -Fx "version=$gateway_version" "$assets/SOURCE.txt" >/dev/null
grep -Fx "commit=$commit" "$assets/SOURCE.txt" >/dev/null
grep -Fx 'schema=proprium-gateway-source-v1' "$assets/SOURCE.txt" >/dev/null
grep -Fx "cloudflared_version=$cloudflared_version" "$assets/SOURCE.txt" >/dev/null
grep -Fx "go=go$go_version" "$assets/SOURCE.txt" >/dev/null
grep -Fx "go_version=$go_version" "$assets/SOURCE.txt" >/dev/null
grep -Fx "go_commit=$go_commit" "$assets/SOURCE.txt" >/dev/null
grep -Fx "go_license_sha256=$go_license_sha256" "$assets/SOURCE.txt" >/dev/null
grep -Fx "go_patents_sha256=$go_patents_sha256" "$assets/SOURCE.txt" >/dev/null
grep -Fx "third_party_licenses_sha256=$third_party_licenses_sha256" "$assets/SOURCE.txt" >/dev/null

expected_assets=(
  "proprium-gateway_${gateway_version}_linux_amd64.tar.gz"
  "proprium-gateway_${gateway_version}_linux_arm64.tar.gz"
  "proprium-gateway_${gateway_version}_windows_amd64.tar.gz"
  "proprium-gateway_${gateway_version}_darwin_amd64.tar.gz"
  "proprium-gateway_${gateway_version}_darwin_arm64.tar.gz"
  proprium bootstrap.sh SHA256SUMS SOURCE.txt
)
actual_assets="$(find "$assets" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
expected_list="$(printf '%s\n' "${expected_assets[@]}" | LC_ALL=C sort)"
if [[ "$actual_assets" != "$expected_list" ]]; then
  printf 'Unexpected release asset set.\nExpected:\n%s\nGot:\n%s\n' "$expected_list" "$actual_assets" >&2
  exit 1
fi
for name in "${expected_assets[@]}"; do
  [[ -f "$assets/$name" && ! -L "$assets/$name" ]] || {
    echo "Release asset is not a regular file: $name" >&2
    exit 1
  }
done

targets=(linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64)
for target in "${targets[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  key="${os}_${arch}"
  expected_upstream_sha="${!key}"
  target_dir="$work/$os-$arch"
  mkdir -p "$target_dir"
  archive="$assets/proprium-gateway_${gateway_version}_${os}_${arch}.tar.gz"
  members=(LICENSE-CLOUDFLARED.txt LICENSE-GATEWAY.txt NOTICE-CLOUDFLARED.txt SOURCE.txt THIRD-PARTY-LICENSES.txt manifest)
  gateway_name=gateway
  cloudflared_name=cloudflared
  if [[ "$os" == windows ]]; then
    gateway_name+=.exe
    cloudflared_name+=.exe
  fi
  members+=("$gateway_name" "$cloudflared_name")
  if [[ "$os" == linux ]]; then members+=(proprium); fi
  actual_members="$(tar -tzf "$archive" | LC_ALL=C sort)"
  expected_members="$(printf '%s\n' "${members[@]}" | LC_ALL=C sort)"
  if [[ "$actual_members" != "$expected_members" ]]; then
    printf 'Unexpected members in %s.\nExpected:\n%s\nGot:\n%s\n' \
      "${archive##*/}" "$expected_members" "$actual_members" >&2
    exit 1
  fi
  while IFS= read -r member; do
    [[ "$member" == -* ]] || {
      echo "Non-regular archive entry in ${archive##*/}." >&2
      exit 1
    }
  done < <(tar -tvzf "$archive")
  tar -xzf "$archive" -C "$target_dir"
  cmp -- "$script_dir/NOTICE-CLOUDFLARED.txt" "$target_dir/NOTICE-CLOUDFLARED.txt"
  test "$(sha256sum "$target_dir/LICENSE-CLOUDFLARED.txt" | cut -d' ' -f1)" = "$license_sha256"
  test "$(sha256sum "$target_dir/THIRD-PARTY-LICENSES.txt" | cut -d' ' -f1)" = "$third_party_licenses_sha256"
  grep -Fx 'schema=proprium-gateway-bundle-v1' "$target_dir/manifest" >/dev/null
  grep -Fx "version=$gateway_version" "$target_dir/manifest" >/dev/null
  grep -Fx "commit=$commit" "$target_dir/manifest" >/dev/null
  grep -Fx "os=$os" "$target_dir/manifest" >/dev/null
  grep -Fx "arch=$arch" "$target_dir/manifest" >/dev/null
  grep -Fx "cloudflared_version=$cloudflared_version" "$target_dir/manifest" >/dev/null
  grep -Fx "go_version=$go_version" "$target_dir/manifest" >/dev/null
  grep -Fx "go_license_sha256=$go_license_sha256" "$target_dir/manifest" >/dev/null
  grep -Fx "go_patents_sha256=$go_patents_sha256" "$target_dir/manifest" >/dev/null
  grep -Fx "third_party_licenses_sha256=$third_party_licenses_sha256" "$target_dir/manifest" >/dev/null
  grep -Fx "cloudflared_upstream_sha256=$expected_upstream_sha" "$target_dir/SOURCE.txt" >/dev/null
  grep -Fx "go_version=$go_version" "$target_dir/SOURCE.txt" >/dev/null
  grep -Fx "go_commit=$go_commit" "$target_dir/SOURCE.txt" >/dev/null
  grep -Fx "go_license_sha256=$go_license_sha256" "$target_dir/SOURCE.txt" >/dev/null
  grep -Fx "go_patents_sha256=$go_patents_sha256" "$target_dir/SOURCE.txt" >/dev/null
  grep -Fx "third_party_licenses_sha256=$third_party_licenses_sha256" "$target_dir/SOURCE.txt" >/dev/null
  gateway_sha="$(sha256sum "$target_dir/$gateway_name" | cut -d' ' -f1)"
  cloudflared_sha="$(sha256sum "$target_dir/$cloudflared_name" | cut -d' ' -f1)"
  grep -Fx "gateway_sha256=$gateway_sha" "$target_dir/manifest" >/dev/null
  grep -Fx "cloudflared_sha256=$cloudflared_sha" "$target_dir/manifest" >/dev/null
  if [[ "$os" == linux ]]; then
    proprium_sha="$(sha256sum "$target_dir/proprium" | cut -d' ' -f1)"
    grep -Fx "proprium_sha256=$proprium_sha" "$target_dir/manifest" >/dev/null
    cmp -- "$assets/proprium" "$target_dir/proprium"
  elif grep -q '^proprium_sha256=' "$target_dir/manifest"; then
    echo "Unexpected proprium hash in non-Linux bundle ${archive##*/}." >&2
    exit 1
  fi
done
