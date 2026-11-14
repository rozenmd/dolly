#!/usr/bin/env bash
set -euo pipefail

run_container_tests() { pnpm exec vitest run --config vitest.sandbox.config.ts "$@"; }
status=0
run_container_tests "$@" || status=$?
if [[ $status != 0 && ${GITHUB_ACTIONS:-} == true ]]; then
  # Keep container network failures actionable even when workerd reports only a reset.
  for container in $(docker ps -aq --filter name=workerd-); do
    docker logs --tail 80 "$container" 2>&1 || true
  done
fi
exit "$status"
