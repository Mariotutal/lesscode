#!/usr/bin/env bash
# Fixture 5 gate proof: bloated-pr is the god-function patch applied on top of
# base behaviour. Checks out base, writes the bloated pricing.ts as the patch,
# runs the gate. Gate must reject on cyclomatic complexity alone.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
bash "$root/fixtures/scripts/materialize5.sh" "$tmp/f5" >/dev/null
cd "$tmp/f5"
git checkout -q base
cp "$root/fixtures/5/bloated/src/pricing.ts" src/pricing.ts
npm install --no-audit --no-fund --silent
npx tsx "$root/src/gate/cli.ts" --repo "$tmp/f5" --base base --edit src/pricing.ts --tests tests
echo "gate exit: $?"
