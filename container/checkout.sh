#!/bin/sh
set -eu
remote=$1 ref=$2 branch=$3 root=${4:-/workspace}
if test -f "$root/ready"; then exit 0; fi
# Never replace an existing checkout, even if setup was interrupted.
if test -e "$root/repo" || test -L "$root/repo"; then
  echo 'Workspace exists without a ready marker; inspect it before recovery' >&2
  exit 1
fi
phase() { printf '%s\n' "$1" > "$root/checkout-phase"; }
setup=$(mktemp -d "$root/setup.XXXXXX")
trap 'rm -rf "$setup"' EXIT
phase shallow_fetch
git init "$setup/repo"
git -C "$setup/repo" remote add origin "$remote"
# Git handles HEAD, branches, tags and exact revisions without a separate lookup.
git -C "$setup/repo" -c protocol.file.allow=never fetch --depth=1 --no-tags -- origin "$ref"
phase git_checkout_branch
git -C "$setup/repo" checkout -b "$branch" FETCH_HEAD
git -C "$setup/repo" config user.name 'Dolly'
git -C "$setup/repo" config user.email 'dolly@users.noreply.github.com'
mv "$setup/repo" "$root/repo"
phase ready
touch "$root/ready"
