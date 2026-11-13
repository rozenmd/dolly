#!/bin/sh
set -eu
# The working tree and index already represent HEAD. Change only branch metadata.
branch="refs/heads/$1"
git check-ref-format "$branch"
head=$(git rev-parse --verify HEAD)
if git show-ref --verify --quiet "$branch"; then
  # Retrying setup must never reset an existing session branch.
  test "$(git rev-parse --verify "$branch")" = "$head"
else
  git update-ref "$branch" "$head" ""
fi
git symbolic-ref HEAD "$branch"
