#!/usr/bin/env bash
# Run the Spark classifier over the fixture branches.
# Materializes fixture checkouts WITHOUT sealed/ (materialize.sh without
# the harness flag; materialize5.sh likewise), runs the classifier on
# each bloated checkout, and asserts that every kept finding cites
# lines that exist. Sealed tests are never read or copied here.
#
#   META_API_KEY=... bash scripts/run-classify-fixtures.sh
#
# Intent files (for the code-decided scope-creep pass) state the PR's
# declared intent per fixture; fixture 4 has no in-scope simplification,
# so any model claim about its load-bearing client must not survive.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$root"

run_fixture() {
  local n="$1" base="$2" intent="$3" materializer="$4"
  local dir="$tmp/f$n"
  if [ "$n" = "5" ]; then bash "fixtures/scripts/$materializer" "$dir" >/dev/null; else bash "fixtures/scripts/$materializer" "$n" "$dir" >/dev/null; fi
  (cd "$dir" && git checkout -q bloated-pr)
  echo "=== fixture $n (bloated-pr) ==="
  npx tsx src/classify/cli.ts --repo "$dir" --base base --intent "$intent" | tee "$tmp/out$n.json" >/dev/null
  node --input-type=module -e '
    import { readFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    const [repo, file] = process.argv.slice(1);
    const r = JSON.parse(readFileSync(file, "utf8"));
    for (const f of r.findings) {
      for (const c of f.citations) {
        const p = join(repo, c.file);
        if (!existsSync(p)) throw new Error(`kept finding cites missing file ${c.file}`);
        const lines = readFileSync(p, "utf8").split("\n");
        const last = lines.at(-1) === "" ? lines.length - 1 : lines.length;
        if (c.endLine > last) throw new Error(`kept finding cites ${c.file}:${c.endLine} past EOF (${last})`);
        if (c.file.includes("/sealed/")) throw new Error(`kept finding cites sealed file ${c.file}`);
      }
    }
    console.log(`fixture: kept=${r.findings.length} dropped=${r.dropped.length} refused=${r.refusedConventions.length} modelCalls=${r.modelCalls}`);
    console.log(r.findings.map((f) => `  kept ${f.category} ${f.file}`).join("\n") || "  (none)");
  ' "$dir" "$tmp/out$n.json"
}

# Intents: f1 the fetcher chain; f2 checkout; f3 the button change;
# f4 nothing in scope (its client is load-bearing — refuse);
# f5 pricing (the gate, not this classifier, rejects the god-function).
run_fixture 1 base "src/userFetcher.ts,src/userApiClient.ts,src/userRepository.ts,src/userService.ts" materialize.sh
run_fixture 2 base "src/checkout/checkout.ts,src/checkout/formatMoney.ts" materialize.sh
run_fixture 3 base "src/components/Button.ts" materialize.sh
run_fixture 4 base "" materialize.sh
run_fixture 5 base "src/pricing.ts" materialize5.sh
echo "ALL FIXTURE RUNS: every kept finding cites existing lines"
