#!/usr/bin/env bash
set -euo pipefail

# Miniflare grants FUSE access only in a local VM or rootless Linux Docker.
# Keep setup here so trusted-base pull_request_target workflows also use it.
if [[ ${GITHUB_ACTIONS:-} == true && $(uname -s) == Linux ]]; then
  security=$(docker info --format '{{json .SecurityOptions}}')
  if [[ $security != *rootless* ]]; then
    sudo apt-get update -qq
    sudo apt-get install -y uidmap fuse3 dbus-user-session
    sudo modprobe fuse
    # GitHub's dedicated ephemeral runner needs user namespaces for rootlesskit.
    if sysctl kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then
      sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    fi
    if ! grep -q "^$USER:" /etc/subuid; then
      sudo usermod --add-subuids 100000-165535 "$USER"
    fi
    if ! grep -q "^$USER:" /etc/subgid; then
      sudo usermod --add-subgids 100000-165535 "$USER"
    fi
    tools="$RUNNER_TEMP/pi-hard-rootless"
    mkdir -p "$tools"
    curl --fail --silent --show-error --location \
      https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-28.5.1.tgz \
      -o "$tools/extras.tgz"
    echo "d0bf8c7442ee9f6ed65966d74bf381c2293f78a89f181153c25ba39b3d708d4e  $tools/extras.tgz" | sha256sum --check
    tar -xzf "$tools/extras.tgz" -C "$tools"
    # The upstream installer expects the Docker client beside the setup helper.
    ln -s "$(command -v docker)" "$tools/docker-rootless-extras/docker"
    export PATH="$tools/docker-rootless-extras:$PATH"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    sudo loginctl enable-linger "$USER"
    sudo systemctl start "user@$(id -u).service"
    dockerd-rootless-setuptool.sh install --force
    export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
    # The later Worker dry run must build against the same daemon.
    printf 'DOCKER_HOST=%s\n' "$DOCKER_HOST" >> "$GITHUB_ENV"
    docker info
  fi
  # Ubuntu's fusermount3 profile otherwise rejects this container mount path.
  # Permit only ArtifactFS mounts in the checkout mount directory on this runner.
  profile=/etc/apparmor.d/fusermount3
  if [[ -f $profile ]]; then
    grep -q 'local/fusermount3' "$profile"
    sudo mkdir -p /etc/apparmor.d/local
    printf 'mount fstype=fuse.artifact-fs -> /workspace/mounts/*/,\numount /workspace/mounts/*/,\n' \
      | sudo tee -a /etc/apparmor.d/local/fusermount3 >/dev/null
    sudo apparmor_parser --replace "$profile"
  fi
  test -c /dev/fuse
  docker info --format '{{json .SecurityOptions}}' | grep -q rootless
fi

exec bash "$(dirname "$0")/run-sandbox-tests.sh" "$@"
