#!/bin/sh
set -eu
# Only fixed, credential-free broker URLs reach this helper.
name=$1 remote=$2 ref=$3
export ARTIFACT_FS_ROOT=/workspace/artifact-fs
mkdir -p "$ARTIFACT_FS_ROOT" /workspace/mounts
if ! artifact-fs status --name "$name" >/dev/null 2>&1; then
  artifact-fs add-repo --name "$name" --remote "$remote" --ref "$ref" \
    --refresh never --mount-root /workspace/mounts
fi
if ! test -f /workspace/artifact-fs.pid || ! kill -0 "$(cat /workspace/artifact-fs.pid)" 2>/dev/null; then
  artifact-fs daemon --root /workspace/mounts > /workspace/artifact-fs.log 2>&1 </dev/null &
  echo $! > /workspace/artifact-fs.pid
fi
# A registered repo is not necessarily mounted yet. Never use the empty mount directory.
i=0
until mountpoint -q "/workspace/mounts/$name"; do
  i=$((i + 1))
  if test "$i" -ge 100 || ! kill -0 "$(cat /workspace/artifact-fs.pid)" 2>/dev/null; then
    cat /workspace/artifact-fs.log >&2
    # Diagnose mount permission failures without dumping environment or credentials.
    id >&2
    stat -c '%a %u:%g %n' /usr/bin/fusermount3 /dev/fuse "/workspace/mounts/$name" >&2
    grep -E '^(Cap|NoNewPrivs)' /proc/self/status >&2
    cat /proc/self/attr/current >&2
    echo 'ArtifactFS mount failed' >&2
    exit 1
  fi
  sleep 0.1
done
