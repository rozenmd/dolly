#!/usr/bin/env bash
set -euo pipefail
docker build -f container/codex.Dockerfile -t dolly-codex-test .
exec docker run --rm --network none --read-only --tmpfs /tmp \
  -v "$PWD/container:/tests/container:ro" \
  -v "$PWD/test/codex:/tests/test/codex:ro" \
  dolly-codex-test node --test /tests/test/codex/cli.test.mjs
