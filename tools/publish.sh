#!/bin/sh
# Publish packages/<name> to the branch magpie installs from.
#
# magpie reads a GitHub repo's *root* package.json, so a subfolder can never be
# installed directly (and bun has no #path: support). Each package therefore
# gets its own branch whose root is that package's tree, made with
# `git subtree split`. Install with github:owner/magpie-plugin#<name>.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

names=${*:-"dl apinex freepi intern clixad howtofix"}

if [ -n "$(git status --porcelain)" ]; then
  echo "publish: 工作区不干净，先 commit" >&2
  exit 1
fi

for n in $names; do
  if [ ! -d "packages/$n" ]; then
    echo "publish: 没有 packages/$n" >&2
    exit 1
  fi
  # split refuses to reuse a branch name, and the old tip is what we replace.
  git update-ref -d "refs/heads/$n" 2>/dev/null || true
  commit=$(git subtree split --prefix "packages/$n" -b "$n")
  git push -f origin "$n:$n"
  echo "publish: $n -> $commit"
done
