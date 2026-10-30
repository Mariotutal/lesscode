#!/usr/bin/env bash
# Usage: materialize5.sh <target-dir>
# Materializes fixture 5 like materialize.sh: base/ on `base`, bloated/ on `bloated-pr`.
# No sealed argument: editing-agent checkouts never receive sealed tests.
set -euo pipefail
target="${1:?target dir}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$target"; mkdir -p "$target"; cd "$target"
git init -q -b base
cp -R "$root/fixtures/5/base/." .
cp "$root/fixtures/eslint.config.mjs" . 2>/dev/null || true
git add -A; git -c user.email=fixture@local -c user.name=fixture commit -qm "base"
git checkout -qb bloated-pr
git rm -rq . >/dev/null; cp -R "$root/fixtures/5/bloated/." .
cp "$root/fixtures/eslint.config.mjs" . 2>/dev/null || true
git add -A; git -c user.email=fixture@local -c user.name=fixture commit -qm "bloated PR"
echo "materialized fixture 5 at $target (branches: base, bloated-pr)"
