#!/usr/bin/env bash
# Live LES-4 run: Spark classify -> Wonder plan (once) -> apply -> gate,
# over fixtures 1, 2 and 4 materialized WITHOUT sealed/ (editing-agent
# checkout; sealed tests are never read or copied here).
# Done criteria: fixtures 1 and 2 gate-accepted; fixture 4 refused or
# gate-rejected (its SharedApiClient is load-bearing — no inline).
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$root"

status=0
run_fixture() {
  local n="$1" intent="$2" expect="$3"
  local dir="$tmp/f$n"
  bash "fixtures/scripts/materialize.sh" "$n" "$dir" >/dev/null
  (cd "$dir" && git checkout -q bloated-pr && npm install --no-audit --no-fund --silent >/dev/null 2>&1)
  echo "=== fixture $n (bloated-pr, expect: $expect) ==="
  (cd "$root" && npx tsx src/plan/cli.ts --repo "$dir" --base base --gate-base bloated-pr \
      --intent "$intent" --tests tests >"$tmp/out$n.json" 2>"$tmp/err$n.txt")
  local code=$?
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [file, expect] = process.argv.slice(1);
    let r; try { r = JSON.parse(readFileSync(file, "utf8")); } catch { console.log("  NO JSON OUTPUT"); process.exit(2); }
    console.log(`  classify: findings=${r.classification.findings} dropped=${r.classification.dropped} sparkCalls=${r.classification.modelCalls} usage=${JSON.stringify(r.classification.usage ?? null)}`);
    console.log(`  plan(${r.plan.model}): wonderCalls=${r.plan.modelCalls} edits=${r.plan.edits.length} planSkipped=${r.plan.skipped.length} usage=${JSON.stringify(r.plan.usage ?? null)}`);
    for (const s of r.plan.skipped) console.log(`    plan-skip #${s.findingIndex}: ${s.reason}`);
    console.log(`  apply: applied=${r.apply.applied.length} skipped=${r.apply.skipped.length} repairCalls=${r.apply.repairCalls} repairUsage=${JSON.stringify(r.apply.repairUsage ?? null)}`);
    for (const a of r.apply.applied) console.log(`    applied #${a.findingIndex} ${a.action} -> ${a.files.join(",")}${a.repaired ? " (repaired)" : ""}`);
    for (const s of r.apply.skipped) console.log(`    apply-skip #${s.findingIndex}: ${s.reason}`);
    if (!r.gate) { console.log("  gate: not run (no patch applied) — refused"); }
    else {
      console.log(`  gate: accepted=${r.gate.accepted} size=${r.gate.metrics.sizeBefore}->${r.gate.metrics.sizeAfter}`);
      for (const c of r.gate.checks) if (!c.passed) console.log(`    gate-fail ${c.name}: ${c.detail}`);
    }
    const accepted = Boolean(r.gate?.accepted);
    const ok = expect === "accepted" ? accepted : !accepted;
    console.log(`  VERDICT: ${ok ? "AS EXPECTED" : "UNEXPECTED"} (${expect})`);
    process.exit(ok ? 0 : 1);
  ' "$tmp/out$n.json" "$expect" || status=1
  if [ -s "$tmp/err$n.txt" ]; then echo "  stderr:"; sed 's/^/    /' "$tmp/err$n.txt" | head -5; fi
  (cd "$dir" && git diff --stat bloated-pr | tail -8 | sed 's/^/  diff: /')
}

run_fixture 1 "src/userFetcher.ts,src/userApiClient.ts,src/userRepository.ts,src/userService.ts" accepted
run_fixture 2 "src/checkout/checkout.ts,src/checkout/formatMoney.ts" accepted
run_fixture 4 "" refused-or-rejected
echo "ALL FIXTURE RUNS DONE (status=$status)"
exit $status
