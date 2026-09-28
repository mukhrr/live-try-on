#!/usr/bin/env bash
# Bump the extension version, build, commit and tag. Usage: pnpm release [patch|minor|major]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain -- .)" ]; then
  echo "extension/ has uncommitted changes; commit them first so the release commit is only the version bump." >&2
  exit 1
fi

version=$(npm version "${1:-patch}" --no-git-tag-version)
pnpm build
git add package.json
git commit -m "Release Toshoyna extension ${version}"
git tag "extension-${version}"
echo "Released ${version}. Push with: git push --follow-tags"
