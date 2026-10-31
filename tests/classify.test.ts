import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFindings } from "../src/classify/classify.js";
import { scopedReviewFiles } from "../src/classify/checkout.js";
import type { GuestClient } from "../src/classify/client.js";
import { filterByEvidence, citationExists, isSealedPath } from "../src/classify/evidence.js";
import { decideScopeCreep } from "../src/classify/scopeCreep.js";
import { classifiedOutputSchema, type Finding } from "../src/classify/schema.js";
import { decideConventionBreak } from "../src/classify/conventionBreak.js";
import { CONVENTIONS } from "../src/classify/conventions.js";

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lc-cls-"));
  for (const [name, text] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

function stubClient(outputs: unknown[]): GuestClient & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    config: { baseUrl: "stub", apiKey: "stub", model: "muse-spark-1.3" },
    async chat() {
      const raw = outputs[Math.min(state.calls++, outputs.length - 1)];
      return {
        content: null,
        toolCalls: [
          {
            id: "c1",
            type: "function" as const,
            function: { name: "report_findings", arguments: JSON.stringify(raw) },
          },
        ],
        finishReason: "tool_calls",
      };
    },
  } as GuestClient & { calls: number };
}

const root = process.cwd();
const SRC = {
  "src/wrap.ts": [
    "export class Wrapper {",
    "  constructor(private readonly inner: { get(): number }) {}",
    "  fetch(): number { return this.inner.get(); }",
    "}",
    "",
  ].join("\n"),
  "src/use.ts": [
    'import { Wrapper } from "./wrap.js";',
    "export const out = new Wrapper({ get: () => 1 }).fetch();",
    "",
  ].join("\n"),
};

describe("zod schema", () => {
  it("rejects unknown categories and scope-creep from the model", () => {
    expect(
      classifiedOutputSchema.safeParse({
        findings: [{ category: "scope-creep", file: "a.ts", citations: [{ file: "a.ts", startLine: 1, endLine: 1 }], rationale: "x" }],
      }).success,
    ).toBe(false);
    expect(
      classifiedOutputSchema.safeParse({
        findings: [{ category: "nested-abstraction", file: "a.ts", citations: [{ file: "a.ts", startLine: 1, endLine: 1 }], rationale: "x" }],
      }).success,
    ).toBe(false);
  });
  it("requires non-empty citations", () => {
    expect(
      classifiedOutputSchema.safeParse({
        findings: [{ category: "single-use-abstraction", file: "a.ts", citations: [], rationale: "x" }],
      }).success,
    ).toBe(false);
  });
});

describe("evidence filter", () => {
  const dir = checkout(SRC);
  const good: Finding = {
    category: "single-use-abstraction",
    file: "src/wrap.ts",
    citations: [
      { file: "src/wrap.ts", startLine: 1, endLine: 4 },
      { file: "src/use.ts", startLine: 2, endLine: 2 },
    ],
    rationale: "wrapper used once",
  };
  it("keeps findings whose cited lines exist", () => {
    expect(filterByEvidence(dir, [good])).toEqual([good]);
    expect(citationExists(dir, { file: "src/wrap.ts", startLine: 5, endLine: 5 })).toBe(false);
  });
  it("drops findings citing past-EOF, missing files, or sealed paths", () => {
    const pastEof: Finding = { ...good, citations: [{ file: "src/wrap.ts", startLine: 1, endLine: 99 }] };
    const missing: Finding = { ...good, file: "src/nope.ts", citations: [{ file: "src/nope.ts", startLine: 1, endLine: 1 }] };
    const sealed: Finding = {
      ...good,
      file: "fixtures/1/sealed/x.test.ts",
      citations: [{ file: "fixtures/1/sealed/x.test.ts", startLine: 1, endLine: 1 }],
    };
    expect(filterByEvidence(dir, [pastEof, missing, sealed])).toEqual([]);
    expect(isSealedPath("fixtures/1/sealed/x.test.ts")).toBe(true);
  });
});

describe("classifier tool loop (stubbed wire)", () => {
  it("keeps only cited findings; drops invented lines", async () => {
    const dir = checkout(SRC);
    const client = stubClient([
      {
        findings: [
          {
            category: "single-use-abstraction",
            file: "src/wrap.ts",
            citations: [
              { file: "src/wrap.ts", startLine: 1, endLine: 4 },
              { file: "src/use.ts", startLine: 2, endLine: 2 },
            ],
            rationale: "Wrapper forwards and is used once",
          },
          {
            category: "single-use-abstraction",
            file: "src/wrap.ts",
            citations: [{ file: "src/wrap.ts", startLine: 40, endLine: 44 }],
            rationale: "invented lines",
          },
        ],
      },
    ]);
    const r = await classifyFindings({ checkoutDir: dir, client });
    expect(r.modelCalls).toBe(1);
    expect(r.findings).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
  });

  it("retries exactly once on zod failure, then uses the valid output", async () => {
    const dir = checkout(SRC);
    const client = stubClient([
      { findings: [{ category: "bogus", file: "src/wrap.ts", citations: [], rationale: "" }] },
      {
        findings: [
          {
            category: "single-use-abstraction",
            file: "src/wrap.ts",
            citations: [{ file: "src/wrap.ts", startLine: 1, endLine: 3 }],
            rationale: "single use",
          },
        ],
      },
    ]);
    const r = await classifyFindings({ checkoutDir: dir, client });
    expect(r.modelCalls).toBe(2);
    expect(r.findings).toHaveLength(1);
  });

  it("keeps nothing after a second zod failure (no guessing)", async () => {
    const dir = checkout(SRC);
    const client = stubClient([{ nope: true }, { still: "bad" }]);
    const r = await classifyFindings({ checkoutDir: dir, client });
    expect(r.modelCalls).toBe(2);
    expect(r.findings).toEqual([]);
  });

  it("refuses a convention-break with no mechanical fix, keeps a fixable one", async () => {
    const dir = checkout({
      "src/a.ts": "export function f(): void {\n  console.log('x');\n}\n",
      "src/b.ts": "export const s = \"hi\";\n",
      // LES-17: a practice is applied only when this repository wrote
      // it in its convention registry.
      "lesscode-conventions.json": JSON.stringify({ conventions: ["no-console-log"] }),
    });
    const client = stubClient([
      {
        findings: [
          {
            category: "convention-break",
            file: "src/a.ts",
            convention: "no-console-log",
            citations: [{ file: "src/a.ts", startLine: 2, endLine: 2 }],
            rationale: "console.log in source",
          },
          {
            category: "convention-break",
            file: "src/b.ts",
            convention: "tabs-not-spaces",
            citations: [{ file: "src/b.ts", startLine: 1, endLine: 1 }],
            rationale: "unregistered convention",
          },
        ],
      },
    ]);
    const r = await classifyFindings({ checkoutDir: dir, client });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe("convention-break");
    expect(r.refusedConventions).toHaveLength(1);
    expect(r.refusedConventions[0]!.status).toBe("refused");
  });
});

describe("LES-19 scoped review files", () => {
  it("sees the change + one-hop neighbours + related tests, not the whole checkout", () => {
    const dir = checkout({
      ...SRC,
      "src/other.ts": "export const o = 1;\n",
      "src/deep.ts": 'import { o } from "./other.js";\nexport const d = o;\n',
      "tests/use.test.ts": 'import { out } from "../src/use.js";\n',
      "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true } }),
      "src/legacy.js": "export const l = 1;\n",
    });
    const files = scopedReviewFiles(dir, { intentFiles: ["src/use.ts"] });
    expect(files).toContain("src/use.ts");
    expect(files).toContain("src/wrap.ts"); // imported by the change
    expect(files).toContain("tests/use.test.ts"); // test importing the change
    expect(files).not.toContain("src/deep.ts"); // two hops away
    expect(files).not.toContain("src/legacy.js"); // unrelated
  });
  it("excludes JavaScript neighbours when allowJs is false, includes them when true; the change itself is always visible", () => {
    const mk = (allowJs: boolean) => checkout({ "src/a.ts": 'import { l } from "./legacy.js";\nexport const a = l;\n', "src/legacy.js": "export const l = 1;\n", "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs } }) });
    expect(scopedReviewFiles(mk(false), { intentFiles: ["src/a.ts"] })).not.toContain("src/legacy.js");
    expect(scopedReviewFiles(mk(true), { intentFiles: ["src/a.ts"] })).toContain("src/legacy.js");
    // A JavaScript change under allowJs:false still sees its own files.
    const js = checkout({ "src/main.js": "export const m = 1;\n", "src/other.js": "export const o = 1;\n", "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: false } }) });
    expect(scopedReviewFiles(js, { intentFiles: ["src/main.js"] })).toEqual(["src/main.js"]);
  });
  it("LES-31: scoped review sees a root test.js that require()s the change, and not bare require targets", () => {
    const dir = checkout({
      "src/use.ts": "export const u = 1;\n",
      "test.js": 'const { u } = require("./src/use.js");\n',
      "other.js": 'const x = require("./src/use.js");\n',
      "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true } }),
    });
    const files = scopedReviewFiles(dir, { intentFiles: ["src/use.ts"] });
    expect(files).toContain("test.js");
  });
  it("fails before the request when the scoped prompt exceeds the window", async () => {
    const dir = checkout({ "src/big.ts": `export const x = "${"x".repeat(20000)}";\n` });
    process.env.LESSCODE_CONTEXT_WINDOW = "100";
    try {
      const client = stubClient([{ findings: [] }]);
      await expect(classifyFindings({ checkoutDir: dir, client })).rejects.toThrow(/~\d+ tokens.*100-token context window/);
      expect(client.calls).toBe(0);
    } finally { delete process.env.LESSCODE_CONTEXT_WINDOW; }
  });
});

describe("scope creep (code-decided)", () => {
  it("flags every changed file outside the intent, never intent files", () => {
    const out = decideScopeCreep({
      changedFiles: ["src/app.ts", "src/components/Button.ts", "src/logger.ts", "src/styles/footerStyle.ts"],
      intentFiles: ["src/app.ts", "src/components/Button.ts"],
    });
    expect(out.map((f) => f.file)).toEqual(["src/logger.ts", "src/styles/footerStyle.ts"]);
    expect(out.every((f) => f.category === "scope-creep" && f.action === "restore-from-base")).toBe(true);
  });
  it("classifier appends creep findings without a model category", async () => {
    const dir = checkout({
      "src/components/Button.ts": "export const b = 1;\n",
      "src/styles/footerStyle.ts": "export const s = 2;\n",
      "src/logger.ts": "export const l = 3;\n",
    });
    const client = stubClient([{ findings: [] }]);
    const r = await classifyFindings({
      checkoutDir: dir,
      client,
      scopeCreep: {
        changedFiles: ["src/components/Button.ts", "src/logger.ts", "src/styles/footerStyle.ts"],
        intentFiles: ["src/components/Button.ts"],
      },
    });
    expect(r.findings.map((f) => f.file).sort()).toEqual(["src/logger.ts", "src/styles/footerStyle.ts"]);
  });
});

describe("LES-20 verification (code decides truth)", () => {
  const citeF = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });
  const run = async (dir: string, findings: unknown[]) => {
    const client = stubClient([{ findings }]);
    return classifyFindings({ checkoutDir: dir, client });
  };

  it("drops a transforming wrapper cited as single-use", async () => {
    const dir = checkout({
      "src/wrap.ts": "export function label(n: number): string {\n  return String(n).trim();\n}\n",
      "src/use.ts": 'import { label } from "./wrap.js";\nexport const out = label(1);\n',
    });
    const r = await run(dir, [{ category: "single-use-abstraction", file: "src/wrap.ts", citations: [citeF("src/wrap.ts", 1, 3), citeF("src/use.ts", 2, 2)], rationale: "single-use" }]);
    expect(r.findings).toEqual([]);
    expect(r.verificationDropped).toHaveLength(1);
    expect(r.verificationDropped[0]!.reason).toMatch(/not a pure forward/);
    expect(r.dropped).toHaveLength(1);
  });

  it("drops a validating/branching wrapper cited as single-use", async () => {
    const dir = checkout({
      "src/wrap.ts": "export function unwrap(x: number | null): number {\n  if (x === null) throw new Error('missing');\n  return x;\n}\n",
      "src/use.ts": 'import { unwrap } from "./wrap.js";\nexport const out = unwrap(1);\n',
    });
    const r = await run(dir, [{ category: "single-use-abstraction", file: "src/wrap.ts", citations: [citeF("src/wrap.ts", 1, 4)], rationale: "single-use" }]);
    expect(r.findings).toEqual([]);
    expect(r.verificationDropped[0]!.reason).toMatch(/not a pure forward/);
  });

  it("drops a helper used by two or more callers", async () => {
    const dir = checkout({
      "src/help.ts": "export function fmt(n: number): string { return String(n); }\n",
      "src/a.ts": 'import { fmt } from "./help.js";\nexport const a = fmt(1);\n',
      "src/b.ts": 'import { fmt } from "./help.js";\nexport const b = fmt(2);\n',
    });
    // Body is impure too, but the call-site count must be reported first.
    const r = await run(dir, [{ category: "single-use-abstraction", file: "src/help.ts", citations: [citeF("src/help.ts", 1, 1)], rationale: "single-use" }]);
    expect(r.findings).toEqual([]);
    expect(r.verificationDropped[0]!.reason).toMatch(/2 call site\(s\)/);
  });

  it("keeps a genuine pure-forward single-use wrapper", async () => {
    const dir = checkout(SRC);
    const r = await run(dir, [{ category: "single-use-abstraction", file: "src/wrap.ts", citations: [citeF("src/wrap.ts", 1, 4), citeF("src/use.ts", 2, 2)], rationale: "wrapper forwards, used once" }]);
    expect(r.findings).toHaveLength(1);
    expect(r.verificationDropped).toEqual([]);
  });

  it("drops a non-equivalent duplicate, keeps an equivalent (renamed) one", async () => {
    const dir = checkout({
      "src/lib/format.ts": "export function fmt(value: number): string {\n  return '$' + value.toFixed(2);\n}\n",
      "src/dup.ts": "export function fmt(amount: number): string {\n  return '$' + amount.toFixed(2);\n}\n",
      "src/bad.ts": "export function fmt(amount: number): string {\n  return 'EUR ' + amount.toFixed(3);\n}\n",
    });
    const dup = { category: "duplicate-helper", file: "src/dup.ts", existingHelperFile: "src/lib/format.ts", citations: [citeF("src/dup.ts", 1, 3), citeF("src/lib/format.ts", 1, 3)], rationale: "duplicate" };
    const bad = { ...dup, file: "src/bad.ts", citations: [citeF("src/bad.ts", 1, 3), citeF("src/lib/format.ts", 1, 3)] };
    const r = await run(dir, [dup, bad]);
    expect(r.findings).toEqual([expect.objectContaining({ file: "src/dup.ts" })]);
    expect(r.verificationDropped).toHaveLength(1);
    expect(r.verificationDropped[0]!.finding.file).toBe("src/bad.ts");
    expect(r.verificationDropped[0]!.reason).toMatch(/not equivalent/);
  });

  it("fixtures 1 and 2 still classify: verified findings are kept", async () => {
    const f1 = join(root, "fixtures/1/bloated");
    const spark1 = [
      { category: "single-use-abstraction", file: "src/userApiClient.ts", citations: [citeF("src/userApiClient.ts", 1, 6)], rationale: "single-use" },
      { category: "single-use-abstraction", file: "src/userRepository.ts", citations: [citeF("src/userRepository.ts", 1, 7)], rationale: "single-use" },
      { category: "single-use-abstraction", file: "src/userService.ts", citations: [citeF("src/userService.ts", 1, 7)], rationale: "single-use" },
    ];
    const r1 = await run(f1, spark1);
    expect(r1.verificationDropped).toEqual([]);
    expect(r1.findings).toHaveLength(3);
    const f2 = join(root, "fixtures/2/bloated");
    const r2 = await run(f2, [{ category: "duplicate-helper", file: "src/checkout/formatMoney.ts", existingHelperFile: "src/lib/formatMoney.ts", citations: [citeF("src/checkout/formatMoney.ts", 1, 8), citeF("src/lib/formatMoney.ts", 1, 8)], rationale: "duplicate" }]);
    expect(r2.verificationDropped).toEqual([]);
    expect(r2.findings).toHaveLength(1);
  });
});

describe("convention registry", () => {
  it("every registered fix is idempotent-ish: applying twice equals applying once", () => {
    for (const c of CONVENTIONS) {
      const sample = "  console.log('x');  \nconst s = \"hi\"";
      expect(c.fix(c.fix(sample))).toBe(c.fix(sample));
    }
  });
  it("no-console-log decision refuses when cited lines have no console.log", () => {
    const dir = checkout({ "src/a.ts": "export const x = 1;\n" });
    const d = decideConventionBreak(dir, [
      {
        category: "convention-break",
        file: "src/a.ts",
        convention: "no-console-log",
        citations: [{ file: "src/a.ts", startLine: 1, endLine: 1 }],
        rationale: "claimed",
      },
    ]);
    expect(d[0]!.status).toBe("refused");
  });
});
