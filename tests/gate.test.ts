import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { evaluateGate } from "../src/gate/gate.js";
import { measureSource } from "../src/gate/metrics.js";
import { buildSymbolGraph } from "../src/gate/symbolGraph.js";

const exec = promisify(execFile);
const root = process.cwd();

async function sh(cwd: string, cmd: string, args: string[]) {
  await exec(cmd, args, { cwd });
}

describe("metrics", () => {
  it("counts decision points and ignores comments for size", () => {
    const src = "// just a comment\nconst x = 1;\n/* block */\nif (x && true) { /* hi */ }\n";
    const m = measureSource("a.ts", src);
    expect(m.sizeLines).toBe(2);
  });
  it("god function absorbs branches", () => {
    const base = readFileSync(join(root, "fixtures/5/base/src/pricing.ts"), "utf8");
    const bloated = readFileSync(join(root, "fixtures/5/bloated/src/pricing.ts"), "utf8");
    const b = measureSource("pricing.ts", base);
    const g = measureSource("pricing.ts", bloated);
    expect(g.functions.find((f) => f.name === "totalPrice")!.complexity).toBeGreaterThan(
      b.functions.find((f) => f.name === "totalPrice")!.complexity * 1.1,
    );
    expect(g.sizeLines).toBeLessThan(b.sizeLines);
  });
});

describe("symbol graph", () => {
  it("tracks exports and cross-file references", () => {
    const graph = buildSymbolGraph(new Map([
      ["a.ts", "export function helper() { return 1; }\nexport const x = 1;"],
      ["b.ts", 'import { helper } from "./a.js";\nexport const y = helper();'],
    ]));
    expect([...graph.get("a.ts")!.exports.keys()]).toEqual(["helper", "x"]);
    expect(graph.get("a.ts")!.referencedByOthers.has("helper")).toBe(true);
  });
});

describe("gate proofs", () => {
  it("accepts the hand-written fixture-1 patch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-g1-"));
    await sh(root, "bash", ["fixtures/scripts/materialize.sh", "1", join(tmp, "f")]);
    const repo = join(tmp, "f");
    await sh(repo, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
    await sh(repo, "git", ["checkout", "-q", "bloated-pr"]);
    await sh(repo, "git", ["apply", join(root, "patches/fixture-1-good.patch")]);
    const result = await evaluateGate({
      repoDir: repo, baseRef: "bloated-pr",
      editSet: ["src/userFetcher.ts", "src/userApiClient.ts", "src/userRepository.ts", "src/userService.ts"],
      relatedTests: ["tests"],
    });
    expect(result.exitCodes).toEqual({ tests: 0, tsc: 0, eslint: 0 });
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.accepted).toBe(true);
  }, 180_000);

  it("rejects fixture 5 on cyclomatic complexity alone", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-g5-"));
    await sh(root, "bash", ["fixtures/scripts/materialize5.sh", join(tmp, "f")]);
    const repo = join(tmp, "f");
    await sh(repo, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
    await sh(repo, "git", ["checkout", "-q", "base"]);
    writeFileSync(join(repo, "src/pricing.ts"), readFileSync(join(root, "fixtures/5/bloated/src/pricing.ts"), "utf8"));
    const result = await evaluateGate({
      repoDir: repo, baseRef: "base", editSet: ["src/pricing.ts"], relatedTests: ["tests"],
    });
    expect(result.exitCodes).toEqual({ tests: 0, tsc: 0, eslint: 0 });
    expect(result.metrics.sizeAfter).toBeLessThan(result.metrics.sizeBefore);
    const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toEqual(["cyclomatic-not-over-10pct"]);
    expect(result.accepted).toBe(false);
  }, 180_000);
});
