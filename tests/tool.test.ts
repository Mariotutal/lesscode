import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import { simplify } from "../src/simplify/simplify.js";
import { SIMPLIFY_TOOL_DEF, SIMPLIFY_TOOL_NAME, createSimplifyTool, simplifyTool } from "../src/tool/tool.js";

const exec = promisify(execFile);
const root = process.cwd();

async function sh(cwd: string, cmd: string, args: string[]) {
  await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Scripted model (same stub shape as tests/simplify.test.ts): one stub
 * serves both Spark (report_findings) and Wonder
 * (propose_surgical_patch / repair_patch), dispatching on the tool
 * name. No live model, no sealed reads.
 */
function scripted(sparkFindings: unknown, wonderEdits: unknown): GuestClient {
  return {
    config: { baseUrl: "stub", apiKey: "stub", model: "scripted" },
    async chat(req) {
      const tool = req.tools?.[0]?.function.name ?? "";
      const payload = tool === "report_findings" ? { findings: sparkFindings } : { edits: wonderEdits };
      return {
        content: null,
        toolCalls: [{ id: "c1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(payload) } }],
        finishReason: "tool_calls",
      };
    },
  } as GuestClient;
}

async function materialize(n: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), `lc-tool-${n}-`));
  const dir = join(tmp, "f");
  await sh(root, "bash", ["fixtures/scripts/materialize.sh", n, dir]);
  await sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
  await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
  return dir;
}

const cite = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });

describe("simplify tool", () => {
  it("exposes one function tool named simplify taking checkout, base, intent", () => {
    expect(SIMPLIFY_TOOL_NAME).toBe("simplify");
    expect(simplifyTool.definition).toBe(SIMPLIFY_TOOL_DEF);
    expect(SIMPLIFY_TOOL_DEF.type).toBe("function");
    expect(SIMPLIFY_TOOL_DEF.function.name).toBe("simplify");
    const params = SIMPLIFY_TOOL_DEF.function.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(params.required).toEqual(["checkout", "base", "intent"]);
    expect(Object.keys(params.properties)).toEqual(
      expect.arrayContaining(["checkout", "base", "intent", "relatedTests"]),
    );
  });

  it("rejects invalid arguments before any run", async () => {
    const tool = createSimplifyTool();
    await expect(tool.call({ checkout: "/x", base: "base", intent: [] })).rejects.toThrow(/invalid simplify tool arguments/);
    await expect(tool.call({ checkout: "/x", base: "base" })).rejects.toThrow(/invalid simplify tool arguments/);
    await expect(tool.call(null)).rejects.toThrow(/invalid simplify tool arguments/);
  });

  it("scripted model: the tool result is the simplify result (accepted)", async () => {
    const dir = await materialize("2");
    const spark = [
      { category: "duplicate-helper", file: "src/checkout/formatMoney.ts", existingHelperFile: "src/lib/formatMoney.ts", citations: [cite("src/checkout/formatMoney.ts", 1, 8), cite("src/lib/formatMoney.ts", 1, 8)], rationale: "duplicate" },
    ];
    const newCheckout = [
      'import { formatMoney } from "../lib/formatMoney.js";',
      "export interface LineItem { price: number; qty: number; }",
      "export function checkoutTotal(items: LineItem[]): string {",
      "  return formatMoney(items.reduce((sum, i) => sum + i.price * i.qty, 0));",
      "}",
      "",
    ].join("\n");
    const wonder = [
      { findingIndex: 0, action: "retarget", newFiles: [{ file: "src/checkout/checkout.ts", content: newCheckout }], deleteFiles: ["src/checkout/formatMoney.ts"], rationale: "retarget" },
    ];
    const client = scripted(spark, wonder);
    const args = { checkout: dir, base: "base", intent: ["src/checkout/checkout.ts", "src/checkout/formatMoney.ts"] };

    // Two runs over two materializations of the same fixture would
    // differ only by tempdir paths, which do not appear in the
    // result — so call both on the same checkout: simplify never
    // modifies it, which is exactly what makes the comparison valid.
    const direct = await simplify({ ...args, sparkClient: client, wonderClient: client });
    const viaTool = await createSimplifyTool().call(args, { sparkClient: client, wonderClient: client });

    expect(viaTool).toEqual(direct);
    expect(viaTool.verdict).toBe("accepted");
    expect(viaTool.patch).toContain("../lib/formatMoney.js");
    expect(viaTool.findings.map((f) => f.category)).toEqual(["duplicate-helper"]);
    expect(viaTool.gate?.accepted).toBe(true);
  }, 300_000);

  it("scripted model: refused tool result leaves the caller branch unchanged", async () => {
    const dir = await materialize("4");
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const statusBefore = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    const spark = [
      { category: "single-use-abstraction", file: "src/sharedApiClient.ts", citations: [cite("src/sharedApiClient.ts", 1, 13)], rationale: "looks like a wrapper" },
    ];
    const wonder = [
      { findingIndex: 0, action: "skip", rationale: "load-bearing: unwraps envelope, used by two features" },
    ];
    const client = scripted(spark, wonder);
    const args = { checkout: dir, base: "base", intent: ["src/features/users.ts"] };

    const direct = await simplify({ ...args, sparkClient: client, wonderClient: client });
    const viaTool = await createSimplifyTool().call(args, { sparkClient: client, wonderClient: client });

    expect(viaTool).toEqual(direct);
    expect(viaTool.verdict).toBe("refused");
    expect(viaTool.patch).toBe("");
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect((await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout).toBe(statusBefore);
  }, 300_000);
});
