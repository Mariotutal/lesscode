import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFindings } from "../src/classify/classify.js";
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
