#!/usr/bin/env bash
set -euo pipefail
# Ordinary local checkouts need no FUSE device, SYS_ADMIN, or rootless daemon.
exec bash "$(dirname "$0")/run-sandbox-tests.sh" "$@"
