#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bootstrap.sh
source "${ROOT_DIR}/bootstrap.sh"

ACTION="${1:-}"
NON_INTERACTIVE=0
if [[ "${2:-}" == "--non-interactive" ]] || [[ "${DEPLOY_NON_INTERACTIVE:-}" == "1" ]]; then
  NON_INTERACTIVE=1
fi

usage() {
  echo "Usage: install-dependency.sh <node> [--non-interactive]" >&2
  exit 2
}

case "${ACTION}" in
  node) ;;
  *) usage ;;
esac

check_supported_system

if [[ "${NON_INTERACTIVE}" -eq 1 ]]; then
  perform_node_install --non-interactive
else
  perform_node_install
fi
activate_node_prefix || true
verify_node_22
