#!/usr/bin/env bash
# Usage: materialize.sh <1|2|3|4> <target-dir> []
# Creates a throwaway git repo: commit base/ on `base`, then bloated/ on `bloated-pr`.
#  is HARNESS-ONLY: copies fixtures/<n>/sealed/ into the bloated-pr
# worktree (uncommitted) so the sealed suite can run. Never use it for an
# editing-agent checkout. See fixtures/AGENTS.md.
set -euo pipefail
n="${1:?fixture number}"; target="${2:?target dir}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$target"; mkdir -p "$target"; cd "$target"
git init -q -b base
cp -R "$root/fixtures/$n/base/." .
cp "$root/fixtures/eslint.config.mjs" . 2>/dev/null || true
git add -A; git -c user.email=fixture@local -c user.name=fixture commit -qm "base"
git checkout -qb bloated-pr
# bloated snapshot replaces the tree (handles deletions between snapshots)
git rm -rq . >/dev/null; cp -R "$root/fixtures/$n/bloated/." .
cp "$root/fixtures/eslint.config.mjs" . 2>/dev/null || true
git add -A; git -c user.email=fixture@local -c user.name=fixture commit -qm "bloated PR"
echo "materialized fixture $n at $target (branches: base, bloated-pr)"
