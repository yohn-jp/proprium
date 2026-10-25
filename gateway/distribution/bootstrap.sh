#!/usr/bin/env bash
set -euo pipefail

readonly api_url='https://api.github.com/repos/yohn-jp/proprium/releases/latest'
readonly release_base='https://github.com/yohn-jp/proprium/releases/download'

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--bin-dir DIRECTORY] [--help]

Download and verify the standalone Linux amd64 Proprium CLI from the latest
GitHub Release, then install it into ${XDG_BIN_HOME:-$HOME/.local/bin}.

The installer does not edit shell startup files. Add the chosen directory to
PATH yourself if it is not already there.
EOF
}

die() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 1
}

bin_dir=''
while (($#)); do
  case "$1" in
    --bin-dir)
      (($# >= 2)) || die '--bin-dir requires a directory'
      [[ -n "$2" ]] || die '--bin-dir requires a non-empty directory'
      [[ -z "$bin_dir" ]] || die '--bin-dir may only be specified once'
      bin_dir=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || die 'this bootstrap supports Linux only'
machine="$(uname -m)"
case "$machine" in
  x86_64|aarch64|arm64) ;;
  *) die "the standalone Proprium CLI is not available for Linux $machine" ;;
esac

for dependency in curl jq sha256sum stat mktemp install mv mkdir rm chmod id uname awk tr; do
  command -v "$dependency" >/dev/null 2>&1 || die "required command not found: $dependency"
done

if [[ -z "$bin_dir" ]]; then
  if [[ -n "${XDG_BIN_HOME:-}" ]]; then
    bin_dir=$XDG_BIN_HOME
  else
    [[ -n "${HOME:-}" ]] || die 'HOME is unset; supply --bin-dir'
    bin_dir=$HOME/.local/bin
  fi
fi

# Do not follow symlinks or accept ambiguous path components. Every existing
# component is checked before it is used; missing components are created 0755.
[[ "$bin_dir" == /* ]] || die '--bin-dir must be an absolute path'
[[ "$bin_dir" != / ]] || die 'refusing to install into /'
[[ "$bin_dir" != */ && "$bin_dir" != *//* ]] || die 'directory path must not contain empty components'
[[ "$bin_dir" != *$'\n'* && "$bin_dir" != *$'\r'* ]] || die 'directory path contains a newline'
IFS='/' read -r -a path_parts <<< "${bin_dir#/}"
current=''
for component in "${path_parts[@]}"; do
  [[ -n "$component" && "$component" != '.' && "$component" != '..' ]] || die 'directory path contains an empty or relative component'
  current+="/$component"
  [[ ! -L "$current" ]] || die "refusing symlink path component: $current"
  if [[ -e "$current" ]]; then
    [[ -d "$current" ]] || die "path component is not a directory: $current"
  else
    mkdir -m 0755 -- "$current" || die "cannot create directory: $current"
    [[ ! -L "$current" && -d "$current" ]] || die "directory changed while being created: $current"
    [[ "$(stat -c '%u' -- "$current")" == "$(id -u)" ]] || die "created directory is not owned by this user: $current"
  fi
  component_owner="$(stat -c '%u' -- "$current")"
  component_mode="$(stat -c '%a' -- "$current")"
  if (( (8#$component_mode & 0022) != 0 )); then
    # A root-owned sticky directory such as /tmp protects each child name
    # from replacement by other users. Other writable path components do not.
    (( (8#$component_mode & 01000) != 0 && component_owner == 0 )) || die "directory path component is writable by other users: $current"
  fi
  [[ "$component_owner" == 0 || "$component_owner" == "$(id -u)" ]] || die "directory path component is owned by another user: $current"
done

[[ -d "$bin_dir" && ! -L "$bin_dir" ]] || die 'installation directory is not a real directory'
[[ "$(stat -c '%u' -- "$bin_dir")" == "$(id -u)" ]] || die 'installation directory must be owned by the current user'
dir_mode="$(stat -c '%a' -- "$bin_dir")"
(( (8#$dir_mode & 0022) == 0 )) || die 'installation directory must not be group- or world-writable'

tmp=''
cleanup() {
  [[ -z "$tmp" ]] || rm -rf -- "$tmp"
}
tmp="$(mktemp -d)" || die 'cannot create temporary directory'
chmod 0700 "$tmp"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# All requests are HTTPS-only, including redirects, and each transfer has
# connection and total time bounds. The retry window is also finite.
curl_https() {
  curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 60 \
    --retry 2 --retry-all-errors --retry-max-time 120 \
    "$@"
}

curl_https "$api_url" --output "$tmp/release.json" || die 'could not fetch latest release metadata over HTTPS'

tag="$(jq -er '.tag_name | select(type == "string")' "$tmp/release.json")" || die 'release metadata has no valid tag_name'
[[ "$tag" =~ ^proprium-gateway-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die 'release metadata contains an invalid tag_name'

asset_digest() {
  local name=$1
  jq -er --arg name "$name" '
    [.assets[]? | select(.name == $name)] as $matches |
    if ($matches | length) == 1 then $matches[0].digest // empty else empty end
  ' "$tmp/release.json"
}

validate_api_asset() {
  local name=$1 expected_url=$2 digest actual_url
  digest="$(asset_digest "$name")" || die "release metadata must contain exactly one $name asset"
  [[ "$digest" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || die "release metadata has no valid SHA-256 digest for $name"
  actual_url="$(jq -er --arg name "$name" '
    [.assets[]? | select(.name == $name)] as $matches |
    if ($matches | length) == 1 then $matches[0].browser_download_url // empty else empty end
  ' "$tmp/release.json")" || die "release metadata has no download URL for $name"
  [[ "$actual_url" == "$expected_url" ]] || die "release metadata download URL does not match the pinned $name URL"
  printf '%s\n' "${digest#sha256:}" | tr 'A-F' 'a-f'
}

cli_url="$release_base/$tag/proprium"
sums_url="$release_base/$tag/SHA256SUMS"
api_cli_sha="$(validate_api_asset proprium "$cli_url")"
api_sums_sha="$(validate_api_asset SHA256SUMS "$sums_url")"

curl_https "$cli_url" --output "$tmp/proprium" || die 'could not download the standalone CLI over HTTPS'
curl_https "$sums_url" --output "$tmp/SHA256SUMS" || die 'could not download SHA256SUMS over HTTPS'

verify_sha() {
  local file=$1 expected=$2 label=$3 actual
  actual="$(sha256sum -- "$file")"
  actual=${actual%% *}
  [[ "$actual" == "$expected" ]] || die "$label digest mismatch"
}

verify_sha "$tmp/SHA256SUMS" "$api_sums_sha" 'SHA256SUMS API'
verify_sha "$tmp/proprium" "$api_cli_sha" 'proprium API'
awk '$2 == "proprium" && $1 ~ /^[0-9a-fA-F]{64}$/ { count++; digest=tolower($1) }
     END { if (count != 1) exit 1; print digest }' "$tmp/SHA256SUMS" > "$tmp/checksum.sha" || die 'SHA256SUMS must contain exactly one valid proprium checksum'
read -r sums_cli_sha < "$tmp/checksum.sha"
[[ "$sums_cli_sha" == "$api_cli_sha" ]] || die 'proprium checksum does not match the GitHub API digest'

target="$bin_dir/proprium"
if [[ -e "$target" || -L "$target" ]]; then
  [[ ! -L "$target" && -f "$target" ]] || die 'refusing to overwrite a non-regular or symlink proprium path'
  [[ "$(stat -c '%u' -- "$target")" == "$(id -u)" ]] || die 'refusing to overwrite a proprium file owned by another user'
  [[ "$(stat -c '%h' -- "$target")" == 1 ]] || die 'refusing to overwrite a hard-linked proprium file'
fi

staged="$bin_dir/.proprium.bootstrap.$$.$RANDOM"
[[ ! -e "$staged" && ! -L "$staged" ]] || die 'staging path already exists'
install -m 0755 -- "$tmp/proprium" "$staged"
mv -fT -- "$staged" "$target" || { rm -f -- "$staged"; die 'could not atomically install proprium'; }

printf 'Installed verified Proprium CLI: %s\n' "$target"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add this directory to PATH to run it by name: %s\n' "$bin_dir" ;;
esac
printf 'Run: %s install\n' "$target"
