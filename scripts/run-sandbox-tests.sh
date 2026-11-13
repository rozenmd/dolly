#!/usr/bin/env bash
set -euo pipefail

# Workerd binds its egress listener to Docker's bridge gateway. In rootless
# Docker that gateway belongs to RootlessKit's network namespace, not the host.
run_native_tests() { pnpm exec vitest run --config vitest.sandbox.config.ts "$@"; }
if [[ $(uname -s) == Linux && ${GITHUB_ACTIONS:-} == true ]]; then
  runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  daemon_pid=$(cat "$runtime_dir/dockerd-rootless/child_pid")
  nsenter --user --preserve-credentials --mount --net --target "$daemon_pid" ip -brief address
  run_native_tests() {
    nsenter --user --preserve-credentials --mount --net --target "$daemon_pid" --wd="$PWD" \
      pnpm exec vitest run --config vitest.sandbox.config.ts "$@"
  }
fi
status=0
run_native_tests "$@" || status=$?
if [[ $status != 0 && ${GITHUB_ACTIONS:-} == true ]]; then
  # Keep native network failures actionable even when workerd reports only a reset.
  for container in $(docker ps -aq --filter name=workerd-); do
    docker logs --tail 80 "$container" 2>&1 || true
  done
fi
exit "$status"
