#!/usr/bin/env bash
# Shared bootstrap helpers for native deploy (sourced by ./deploy.sh).
# Supports Linux, macOS, and Windows (Git Bash / MSYS / Cygwin).

detect_os_family() {
  local uname_s="${DATAFOUNDRY_UNAME_S:-}"
  if [[ -z "${uname_s}" ]]; then
    uname_s="$(uname -s 2>/dev/null || true)"
  fi
  case "${uname_s}" in
    Linux) echo linux ;;
    Darwin) echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *)
      if [[ "${OS:-}" == "Windows_NT" ]]; then
        echo windows
      else
        echo "unknown:${uname_s:-unknown}"
      fi
      ;;
  esac
}

normalize_arch() {
  local arch="${DATAFOUNDRY_UNAME_M:-}"
  if [[ -z "${arch}" ]]; then
    arch="$(uname -m 2>/dev/null || true)"
  fi
  case "${arch}" in
    x86_64|amd64|AMD64) echo x64 ;;
    aarch64|arm64|ARM64) echo arm64 ;;
    *) echo "${arch:-unknown}" ;;
  esac
}

check_supported_system() {
  local family raw_os
  family="$(detect_os_family)"
  case "${family}" in
    linux|macos|windows) ;;
    unknown:*)
      raw_os="${family#unknown:}"
      echo "Unsupported operating system: ${raw_os}. DataFoundry native deploy supports Linux, macOS, and Windows." >&2
      exit 1
      ;;
    *)
      echo "Unsupported operating system: ${family}. DataFoundry native deploy supports Linux, macOS, and Windows." >&2
      exit 1
      ;;
  esac

  local arch raw_arch
  arch="$(normalize_arch)"
  case "${arch}" in
    x64|arm64) ;;
    *)
      raw_arch="${DATAFOUNDRY_UNAME_M:-${arch}}"
      echo "Unsupported architecture: ${raw_arch}. DataFoundry native deploy supports x86_64/amd64 and aarch64/arm64 only." >&2
      exit 1
      ;;
  esac
}

linux_distro_id() {
  local os_release="${DATAFOUNDRY_OS_RELEASE_FILE:-/etc/os-release}"
  local line value
  if [[ ! -r "${os_release}" ]]; then
    echo ""
    return 0
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    case "${line}" in
      ID=*)
        value="${line#ID=}"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        echo "${value}"
        return 0
        ;;
    esac
  done < "${os_release}"
  echo ""
}

uses_apt_node_install() {
  [[ "$(detect_os_family)" == "linux" ]] || return 1
  case "$(linux_distro_id)" in
    ubuntu|debian) return 0 ;;
    *) return 1 ;;
  esac
}

node_prefix() {
  if [[ -n "${DATAFOUNDRY_NODE_PREFIX:-}" ]]; then
    echo "${DATAFOUNDRY_NODE_PREFIX}"
    return 0
  fi
  local home="${HOME:-${USERPROFILE:-}}"
  echo "${home}/.local/share/datafoundry/node"
}

node_asset_suffix() {
  local family arch
  family="$(detect_os_family)"
  arch="$(normalize_arch)"
  case "${family}-${arch}" in
    linux-x64) echo "linux-x64.tar.xz" ;;
    linux-arm64) echo "linux-arm64.tar.xz" ;;
    macos-x64) echo "darwin-x64.tar.gz" ;;
    macos-arm64) echo "darwin-arm64.tar.gz" ;;
    windows-x64) echo "win-x64.zip" ;;
    windows-arm64) echo "win-arm64.zip" ;;
    *)
      echo "Unsupported Node.js package for ${family} ${arch}." >&2
      return 1
      ;;
  esac
}

activate_node_prefix() {
  local prefix bin
  prefix="$(node_prefix)"
  if [[ -x "${prefix}/bin/node" ]]; then
    bin="${prefix}/bin"
  elif [[ -x "${prefix}/node.exe" || -x "${prefix}/node" ]]; then
    bin="${prefix}"
  else
    return 1
  fi
  case ":${PATH}:" in
    *":${bin}:"*) ;;
    *) export PATH="${bin}:${PATH}" ;;
  esac
  hash -r 2>/dev/null || true
}

command_is_readonly() {
  local token
  for token in "$@"; do
    case "${token}" in
      status|logs|stop|doctor|help) return 0 ;;
    esac
  done
  return 1
}

has_non_interactive_flag() {
  local token
  for token in "$@"; do
    [[ "${token}" == "--non-interactive" ]] && return 0
  done
  return 1
}

node_major_version() {
  local version
  version="$(node --version 2>/dev/null || true)"
  if [[ "${version}" =~ ^v([0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

can_install_noninteractive() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  if sudo -n true >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

verify_node_22() {
  if ! node --version >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
    echo "Node.js 22 installation did not produce working node/npm commands." >&2
    exit 1
  fi
  local major
  major="$(node_major_version || true)"
  if [[ -z "${major}" || "${major}" -lt 22 ]]; then
    echo "Node.js 22+ is required after installation; found $(node --version 2>/dev/null || echo none)." >&2
    exit 1
  fi
}

confirm_node_install() {
  local source_url
  if uses_apt_node_install; then
    source_url="https://deb.nodesource.com/setup_22.x"
    echo "Node.js 22 is required."
    echo "Installer source: ${source_url}"
    echo "Commands:"
    echo "  curl -fsSL ${source_url} -o /tmp/nodesource_setup.sh"
    echo "  bash /tmp/nodesource_setup.sh"
    echo "  apt-get install -y nodejs"
    if has_non_interactive_flag "$@"; then
      if ! can_install_noninteractive; then
        echo "Non-interactive Node.js installation requires root or passwordless sudo." >&2
        exit 1
      fi
    else
      local answer
      read -r -p "Install Node.js 22 from NodeSource now? [y/N]: " answer
      case "${answer}" in
        y|Y|yes|YES) ;;
        *)
          echo "Node.js 22 is required. Install it and re-run ./deploy.sh." >&2
          exit 1
          ;;
      esac
    fi
    return 0
  fi

  local suffix prefix
  suffix="$(node_asset_suffix)"
  prefix="$(node_prefix)"
  source_url="https://nodejs.org/dist/latest-v22.x/"
  echo "Node.js 22 is required."
  echo "Installer source: ${source_url} (*-${suffix})"
  echo "Install location: ${prefix}"
  echo "Commands:"
  echo "  curl -fsSL ${source_url}SHASUMS256.txt"
  echo "  curl -fsSL ${source_url}<node-archive>"
  echo "  verify SHA-256, then extract into ${prefix}"
  if has_non_interactive_flag "$@"; then
    return 0
  fi
  local answer
  read -r -p "Install Node.js 22 from nodejs.org now? [y/N]: " answer
  case "${answer}" in
    y|Y|yes|YES) ;;
    *)
      echo "Node.js 22 is required. Install it and re-run ./deploy.sh." >&2
      exit 1
      ;;
  esac
}

perform_node_install_apt() {
  local setup
  local nodesource_url="https://deb.nodesource.com/setup_22.x"
  setup="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f \"${setup}\"" RETURN
  curl -fsSL "${nodesource_url}" -o "${setup}"
  if [[ "$(id -u)" -eq 0 ]]; then
    bash "${setup}"
    apt-get install -y nodejs
  elif has_non_interactive_flag "$@"; then
    sudo -n bash "${setup}"
    sudo -n apt-get install -y nodejs
  else
    sudo bash "${setup}"
    sudo apt-get install -y nodejs
  fi
  rm -f "${setup}"
  trap - RETURN
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${file}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  elif command -v certutil >/dev/null 2>&1; then
    actual="$(certutil -hashfile "${file}" SHA256 | awk 'NR==2 { gsub(/\r/, ""); print $1 }')"
  else
    echo "A SHA-256 tool (sha256sum, shasum, or certutil) is required to verify the Node.js download." >&2
    exit 1
  fi
  expected="$(printf '%s' "${expected}" | tr '[:upper:]' '[:lower:]')"
  actual="$(printf '%s' "${actual}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "Node.js download checksum mismatch." >&2
    exit 1
  fi
}

perform_node_install_official() {
  local suffix prefix tmp sums checksum name extracted bin
  suffix="$(node_asset_suffix)"
  prefix="$(node_prefix)"
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to download Node.js 22." >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required to extract the Node.js 22 archive." >&2
    exit 1
  fi

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf \"${tmp}\"" RETURN
  sums="${tmp}/SHASUMS256.txt"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "${sums}"
  checksum="$(
    awk -v suffix="-${suffix}" '
      NF >= 2 {
        name = $2
        if (index(name, "node-v22") == 1 && length(name) >= length(suffix) && substr(name, length(name) - length(suffix) + 1) == suffix) {
          print $1
          exit
        }
      }
    ' "${sums}"
  )"
  name="$(
    awk -v suffix="-${suffix}" '
      NF >= 2 {
        name = $2
        if (index(name, "node-v22") == 1 && length(name) >= length(suffix) && substr(name, length(name) - length(suffix) + 1) == suffix) {
          print name
          exit
        }
      }
    ' "${sums}"
  )"
  if [[ -z "${checksum}" || -z "${name}" ]]; then
    echo "Could not resolve a Node.js 22 ${suffix} download." >&2
    exit 1
  fi
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/${name}" -o "${tmp}/${name}"
  verify_sha256 "${tmp}/${name}" "${checksum}"

  case "${name}" in
    *.tar.xz) tar -xJf "${tmp}/${name}" -C "${tmp}" ;;
    *.tar.gz|*.tgz) tar -xzf "${tmp}/${name}" -C "${tmp}" ;;
    *.zip) tar -xf "${tmp}/${name}" -C "${tmp}" ;;
    *)
      echo "Unsupported Node.js archive: ${name}" >&2
      exit 1
      ;;
  esac

  extracted=""
  local candidate
  for candidate in "${tmp}"/node-v22*; do
    if [[ -d "${candidate}" ]]; then
      extracted="${candidate}"
      break
    fi
  done
  if [[ -z "${extracted}" ]]; then
    echo "Node.js archive did not contain a node-v22 directory." >&2
    exit 1
  fi

  rm -rf "${prefix}"
  mkdir -p "$(dirname "${prefix}")"
  mv "${extracted}" "${prefix}"
  rm -rf "${tmp}"
  trap - RETURN

  activate_node_prefix || true
  if [[ -x "${prefix}/bin/node" ]]; then
    bin="${prefix}/bin"
  else
    bin="${prefix}"
  fi
  echo "Node.js 22 is installed at ${prefix}."
  echo "This directory was added to PATH for the current process."
  echo "Add it to your shell profile to use node in new terminals:"
  echo "  export PATH=\"${bin}:\$PATH\""
}

perform_node_install() {
  if uses_apt_node_install; then
    perform_node_install_apt "$@"
    return 0
  fi
  perform_node_install_official "$@"
}

install_node_22() {
  confirm_node_install "$@"
  perform_node_install "$@"
  activate_node_prefix || true
  verify_node_22
}

ensure_node_22() {
  activate_node_prefix || true

  local major=""
  if command -v node >/dev/null 2>&1; then
    major="$(node_major_version || true)"
  fi

  if [[ -n "${major}" && "${major}" -ge 22 ]]; then
    return 0
  fi

  if command_is_readonly "$@"; then
    echo "Node.js 22+ is required for this command. Install Node.js 22 and re-run ./deploy.sh $*." >&2
    exit 1
  fi

  if [[ -n "${major}" && "${major}" -lt 22 ]]; then
    echo "Unsupported Node.js version: $(node --version). DataFoundry requires Node.js 22.x." >&2
  fi

  install_node_22 "$@"
}
