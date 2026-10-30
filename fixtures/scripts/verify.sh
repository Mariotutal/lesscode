#!/usr/bin/env bash
# Harness-only verifier (may read sealed/; editing agents must not — see AGENTS.md).
# For each fixture: materialize, install, run visible tests on base and on
# bloated-pr, then sealed tests on bloated-pr. Green = all pass.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
for n in 1 2 3 4; do
  echo "=== fixture $n ==="
  bash "$root/fixtures/scripts/materialize.sh" "$n" "$tmp/f$n" >/dev/null
  cd "$tmp/f$n"
  npm install --no-audit --no-fund --silent
  git checkout -q base;        npx vitest run tests --silent;        npx tsc --noEmit
  git checkout -q bloated-pr;  npx tsc --noEmit;  cp -R "$root/fixtures/$n/sealed" ./sealed; npx vitest run tests sealed --silent
  echo "fixture $n: base visible green; bloated visible+sealed green; tsc green"
done
echo "ALL FIXTURES GREEN"
