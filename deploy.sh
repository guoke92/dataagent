#!/usr/bin/env bash
# Linux, macOS, and Windows Git Bash entrypoint.
# Native Windows cmd/PowerShell: deploy.cmd (falls back to deploy.ps1 when Git Bash is absent).
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/bootstrap.sh
source "${ROOT_DIR}/scripts/deploy/bootstrap.sh"

main() {
  check_supported_system
  ensure_node_22 "$@"
  exec node "$ROOT_DIR/scripts/deploy/cli.mjs" "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
