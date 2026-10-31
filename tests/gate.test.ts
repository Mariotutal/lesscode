import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { evaluateGate, coveringTests, isTestFilePath, repoCommands } from "../src/gate/gate.js";
import { measureSource } from "../src/gate/metrics.js";
import { buildSymbolGraph } from "../src/gate/symbolGraph.js";

const exec = promisify(execFile);
const root = process.cwd();

async function sh(cwd: string, cmd: string, args: string[]) {
  await exec(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
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

  it("LES-10 sample: credits only the file the specifier resolves to", () => {
    // Regression: name-matching credited formatMoney to both a.ts and b.ts.
    // The checker resolves `./a.js` to a.ts only, so b.ts must get no credit.
    const graph = buildSymbolGraph(new Map([
      ["a.ts", "export function formatMoney(n: number) { return '$' + n; }"],
      ["b.ts", "export function formatMoney(n: number) { return '#' + n; }"],
      ["c.ts", 'import { formatMoney } from "./a.js";\nexport const out = formatMoney(1);'],
    ]));
    expect(graph.get("a.ts")!.referencedByOthers.has("formatMoney")).toBe(true);
    expect(graph.get("b.ts")!.referencedByOthers.has("formatMoney")).toBe(false);
  });

  it("resolves aliased and namespace imports to the declaring file", () => {
    const graph = buildSymbolGraph(new Map([
      ["src/a.ts", "export function helper() { return 1; }"],
      ["src/b.ts", 'import { helper as h } from "./a";\nexport const y = h();'],
      ["src/c.ts", 'import * as a from "./a.js";\nexport const z = a.helper();'],
    ]));
    expect(graph.get("src/a.ts")!.referencedByOthers.has("helper")).toBe(true);
  });
});

describe("LES-19 repo-aware gate", () => {
  it("discovers repo commands; no tsconfig/typecheck is skipped, not failed", () => {
    expect(repoCommands(root)).toMatchObject({ test: "vitest run tests", typecheck: "npm run typecheck", lint: "npm run lint" });
  });
  it("coveringTests walks imports transitively on the pre-edit tree", () => {
    const tree = new Map([
      ["src/demo.js", "export const x = 1;\n"],
      ["src/persist.ts", "export const p = 1;\n"],
      ["tests/devtools.test.tsx", 'import { p } from "../src/persist.js";\n'],
    ]);
    expect(coveringTests(tree, "src/persist.ts")).toEqual(["tests/devtools.test.tsx"]);
    expect(coveringTests(tree, "src/demo.js")).toEqual([]);
  });
  it("LES-31: isTestFilePath counts spec files and bare test.* files, not test helpers", () => {
    for (const f of ["test.js", "test.ts", "test.mjs", "test.cjs", "src/withTimeout.spec.ts", "src/foo.test.tsx", "src/foo.test.js", "src/__tests__/foo.ts", "tests/foo.ts"]) expect(isTestFilePath(f), f).toBe(true);
    for (const f of ["src/testHelper.ts", "src/contest.ts", "src/foo.ts", "src/latest.js", "TESTS/foo.ts"]) expect(isTestFilePath(f), f).toBe(false);
  });
  it("LES-31: coveringTests follows require() (relative only), including from a root test.js", () => {
    const tree = new Map([
      ["index.js", "module.exports = 1;\n"],
      ["src/foo.ts", "export const f = 1;\n"],
      ["src/hop.js", 'const { f } = require("./foo.js");\nmodule.exports = f;\n'],
      ["test.js", 'const x = require("./index.js");\nconst y = require("./src/hop.js");\nconst z = require("express");\n'],
    ]);
    expect(coveringTests(tree, "index.js")).toEqual(["test.js"]);
    expect(coveringTests(tree, "src/foo.ts")).toEqual(["test.js"]); // transitive via require in src/hop.js
    expect(coveringTests(tree, "src/hop.js")).toEqual(["test.js"]);
  });
  it("rejects an edit no related test covers, even when tests pass and size drops (zustand case)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-g19-"));
    const repo = join(tmp, "f");
    await sh(root, "bash", ["fixtures/scripts/materialize.sh", "1", repo]);
    await sh(repo, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
    await sh(repo, "git", ["checkout", "-q", "bloated-pr"]);
    // src/index.ts re-exports userFetcher but no test imports index.ts,
    // so shrinking it is exactly the uncovered-edit case.
    writeFileSync(join(repo, "src/index.ts"), 'export * from "./client.js";\n');
    const result = await evaluateGate({ repoDir: repo, baseRef: "bloated-pr", editSet: ["src/index.ts"], relatedTests: ["tests"] });
    const cov = result.checks.find((c) => c.name === "edit-covered-by-related-tests");
    expect(cov!.passed).toBe(false);
    expect(cov!.detail).toContain("src/index.ts");
    expect(result.accepted).toBe(false);
  }, 180_000);
  it("rejects when the repository has no test command", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-g19b-"));
    const repo = join(tmp, "f");
    await sh(root, "bash", ["fixtures/scripts/materialize.sh", "1", repo]);
    await sh(repo, "git", ["checkout", "-q", "bloated-pr"]);
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")); delete pkg.scripts.test; writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
    await sh(repo, "git", ["apply", join(root, "patches/fixture-1-good.patch")]);
    const result = await evaluateGate({ repoDir: repo, baseRef: "bloated-pr", editSet: ["src/userFetcher.ts"], relatedTests: ["tests"] });
    expect(result.accepted).toBe(false);
    expect(result.checks.find((c) => c.name === "related-tests-pass")!.detail).toMatch(/no test command/);
  }, 180_000);
});

describe("LES-31 tests-not-deleted", () => {
  // Minimal repo whose test command is a no-op so every check except
  // tests-not-deleted is neutral; runCommands stays on to prove that.
  async function bareRepo(files: Record<string, string>): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "lc-g31-"));
    await sh(repo, "git", ["init", "-q", "-b", "base"]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    for (const [f, text] of Object.entries(files)) { const p = join(repo, f); await sh(repo, "mkdir", ["-p", p.slice(0, p.lastIndexOf("/"))]); writeFileSync(p, text); }
    await sh(repo, "git", ["add", "-A"]);
    await sh(repo, "git", ["-c", "user.email=gate@local", "-c", "user.name=gate", "commit", "-qm", "base"]);
    return repo;
  }
  const baseFiles = {
    "src/foo.ts": "export const f = 1;\n",
    "src/foo.spec.ts": 'import { f } from "./foo.js";\nit("works", () => {});\n',
    "src/bar.test.tsx": 'it("renders", () => {});\n',
    "test.js": 'it("root", () => {});\n',
  };
  const td = (r: Awaited<ReturnType<typeof evaluateGate>>) => r.checks.find((c) => c.name === "tests-not-deleted")!;
  it("fails when test.js is deleted", async () => {
    const repo = await bareRepo(baseFiles);
    await sh(repo, "git", ["rm", "-q", "test.js"]);
    const r = await evaluateGate({ repoDir: repo, baseRef: "base", editSet: ["src/foo.ts"], relatedTests: ["src/foo.spec.ts"] });
    expect(td(r).passed).toBe(false); expect(td(r).detail).toContain("test.js"); expect(r.accepted).toBe(false);
  });
  it("fails when src/foo.spec.ts is deleted", async () => {
    const repo = await bareRepo(baseFiles);
    await sh(repo, "git", ["rm", "-q", "src/foo.spec.ts"]);
    const r = await evaluateGate({ repoDir: repo, baseRef: "base", editSet: ["src/foo.ts"], relatedTests: ["src/foo.spec.ts"] });
    expect(td(r).passed).toBe(false); expect(td(r).detail).toContain("src/foo.spec.ts");
  });
  it("fails when an it() is removed from src/bar.test.tsx", async () => {
    const repo = await bareRepo(baseFiles);
    writeFileSync(join(repo, "src/bar.test.tsx"), "export const x = 1;\n");
    const r = await evaluateGate({ repoDir: repo, baseRef: "base", editSet: ["src/foo.ts"], relatedTests: ["src/foo.spec.ts"] });
    expect(td(r).passed).toBe(false); expect(td(r).detail).toContain("src/bar.test.tsx");
  });
  it("fails when an it() is removed from test.js and from a spec file", async () => {
    const repo = await bareRepo(baseFiles);
    writeFileSync(join(repo, "test.js"), "const x = 1;\n");
    writeFileSync(join(repo, "src/foo.spec.ts"), 'import { f } from "./foo.js";\n');
    const r = await evaluateGate({ repoDir: repo, baseRef: "base", editSet: ["src/foo.ts"], relatedTests: ["src/foo.spec.ts"] });
    expect(td(r).passed).toBe(false); expect(td(r).detail).toContain("test.js"); expect(td(r).detail).toContain("src/foo.spec.ts");
  });
  it("passes when no test case is removed", async () => {
    const repo = await bareRepo(baseFiles);
    writeFileSync(join(repo, "src/foo.ts"), "export const f = 1;\nexport const g = 2;\n");
    const r = await evaluateGate({ repoDir: repo, baseRef: "base", editSet: ["src/foo.ts"], relatedTests: ["src/foo.spec.ts"] });
    expect(td(r).passed).toBe(true);
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

  it("rejects fixture 5 identically when the patch is committed", async () => {
    // Regression for LES-9: diffing HEAD (not baseRef) judged a committed
    // patch as an empty diff, so complexity/size/eslint checks saw nothing.
    const tmp = mkdtempSync(join(tmpdir(), "lc-g5c-"));
    await sh(root, "bash", ["fixtures/scripts/materialize5.sh", join(tmp, "f")]);
    const repo = join(tmp, "f");
    await sh(repo, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
    await sh(repo, "git", ["checkout", "-q", "base"]);
    // Pin baseRef to the base SHA so the commit below does not move it.
    const { stdout: baseSha } = await exec("git", ["rev-parse", "base"], { cwd: repo, maxBuffer: 10 * 1024 * 1024 });
    writeFileSync(join(repo, "src/pricing.ts"), readFileSync(join(root, "fixtures/5/bloated/src/pricing.ts"), "utf8"));
    await sh(repo, "git", ["add", "src/pricing.ts"]);
    await sh(repo, "git", ["-c", "user.email=gate@local", "-c", "user.name=gate", "commit", "-qm", "candidate patch"]);
    const result = await evaluateGate({
      repoDir: repo, baseRef: baseSha.trim(), editSet: ["src/pricing.ts"], relatedTests: ["tests"],
    });
    expect(result.exitCodes).toEqual({ tests: 0, tsc: 0, eslint: 0 });
    expect(result.metrics.sizeAfter).toBeLessThan(result.metrics.sizeBefore);
    const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toEqual(["cyclomatic-not-over-10pct"]);
    expect(result.checks.find((c) => c.name === "eslint-touched-passes")!.detail).toContain("src/pricing.ts");
    expect(result.accepted).toBe(false);
  }, 180_000);
});
