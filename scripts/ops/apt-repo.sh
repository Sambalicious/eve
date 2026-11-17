#!/usr/bin/env bash
# Sourced by bootstrap-server.sh and enable-funnel.sh. Adds a vendor's signed apt repository
# instead of piping an install script into a root shell. Idempotent: safe to run again.
#
# apt_os_id        prints "ubuntu" or "debian"; exits 2 on any other distro
# apt_os_codename  prints the release codename (noble, bookworm, ...)
# apt_add_repo <name> <key-url> <key-file-name> <repo-url> <suites> <components>
#                  key goes to /etc/apt/keyrings/<key-file-name>, source to /etc/apt/sources.list.d/<name>.list

apt_os_id() {
  local id=""
  # shellcheck disable=SC1091
  [ -r /etc/os-release ] && id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  case "$id" in
    ubuntu|debian) printf '%s' "$id" ;;
    *)
      echo "Unsupported distro '${id:-unknown}'. This script sets up vendor apt repositories for Debian and Ubuntu only." >&2
      echo "Install Docker and Tailscale yourself with the vendor's instructions, then re-run." >&2
      exit 2
      ;;
  esac
}

apt_os_codename() {
  local codename=""
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
  [ -n "$codename" ] || { echo "Could not read the release codename from /etc/os-release." >&2; exit 2; }
  printf '%s' "$codename"
}

apt_add_repo() {
  local name="$1" key_url="$2" key_name="$3" repo_url="$4" suite="$5" component="$6"
  local key="/etc/apt/keyrings/$key_name" list="/etc/apt/sources.list.d/$name.list" tmp line
  tmp="$(mktemp)"
  # Fetch to a temp file first so a failed download never leaves a truncated key behind.
  curl -fsSL --proto '=https' --tlsv1.2 "$key_url" -o "$tmp" || { rm -f "$tmp"; echo "Could not download $key_url" >&2; exit 1; }
  [ -s "$tmp" ] || { rm -f "$tmp"; echo "Empty key from $key_url" >&2; exit 1; }
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo install -m 0644 "$tmp" "$key"
  rm -f "$tmp"
  line="deb [arch=$(dpkg --print-architecture) signed-by=$key] $repo_url $suite $component"
  if [ "$(sudo cat "$list" 2>/dev/null || true)" != "$line" ]; then
    printf '%s\n' "$line" | sudo tee "$list" >/dev/null
  fi
  sudo apt-get update -qq
}
